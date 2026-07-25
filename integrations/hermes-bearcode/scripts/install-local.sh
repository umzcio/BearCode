#!/usr/bin/env bash
set -Eeuo pipefail

die() {
  printf 'Hermes BearCode install refused: %s\n' "$1" >&2
  exit 1
}

stage_argument=${1:-}
[[ -n "$stage_argument" ]] || die "an explicit stage directory is required"
[[ -n "${HERMES_HOME:-}" ]] || die "HERMES_HOME is required"
[[ -d "$stage_argument" ]] || die "stage directory does not exist"
[[ -d "$HERMES_HOME" ]] || die "HERMES_HOME does not exist"

stage=$(realpath "$stage_argument") ||
  die "stage directory could not be resolved"
hermes_home=$(realpath "$HERMES_HOME") ||
  die "HERMES_HOME could not be resolved"
[[ "$stage" != "/" ]] || die "stage directory cannot be the filesystem root"
[[ "$hermes_home" != "/" ]] || die "HERMES_HOME cannot be the filesystem root"

case "$stage/" in
  "$hermes_home/"*)
    die "stage and HERMES_HOME paths overlap"
    ;;
esac
case "$hermes_home/" in
  "$stage/"*)
    die "stage and HERMES_HOME paths overlap"
    ;;
esac

current_uid=$(id -u)
current_user=$(id -un)
if [[ -n "${HERMES_SERVICE_USER:-}" &&
      "$current_uid" != "0" &&
      "$current_user" != "$HERMES_SERVICE_USER" ]]; then
  die "current service user does not match HERMES_SERVICE_USER"
fi

hermes_python=${HERMES_PYTHON:-/usr/local/lib/hermes-agent/venv/bin/python}
env_python=${HERMES_ENV_PYTHON:-python3}
hermes_cli=${HERMES_CLI:-hermes}
systemctl_command=${HERMES_SYSTEMCTL:-systemctl}
tailscale_command=${HERMES_TAILSCALE:-tailscale}
hermes_agent_root=${HERMES_AGENT_ROOT:-/usr/local/lib/hermes-agent}

[[ -x "$hermes_python" ]] || die "Hermes Python is not executable"
command -v "$env_python" >/dev/null 2>&1 ||
  die "environment Python is not executable"
command -v "$hermes_cli" >/dev/null 2>&1 ||
  die "Hermes CLI is not executable"
command -v "$systemctl_command" >/dev/null 2>&1 ||
  die "systemctl command is not executable"
command -v "$tailscale_command" >/dev/null 2>&1 ||
  die "tailscale command is not executable"

"$env_python" - "$stage" "$hermes_home" "$current_uid" <<'PY'
import os
from pathlib import Path
import stat
import sys

stage = Path(sys.argv[1])
home = Path(sys.argv[2])
expected_uid = int(sys.argv[3])


def inspect_tree(root, *, reject_writable):
    for directory, names, files in os.walk(root, followlinks=False):
        candidates = [Path(directory)]
        candidates.extend(Path(directory) / name for name in names + files)
        for candidate in candidates:
            info = os.lstat(candidate)
            if stat.S_ISLNK(info.st_mode):
                raise SystemExit(f"unsafe symlink in path: {candidate}")
            if not (
                stat.S_ISDIR(info.st_mode)
                or stat.S_ISREG(info.st_mode)
            ):
                raise SystemExit(
                    f"stage entry is not a regular file or directory: {candidate}"
                )
            if info.st_uid != expected_uid:
                raise SystemExit(f"path is not owned by service user: {candidate}")
            if reject_writable and info.st_mode & 0o022:
                raise SystemExit(
                    f"stage path is writable by another user: {candidate}"
                )


for root in (stage, home):
    info = os.lstat(root)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise SystemExit(f"unsafe directory: {root}")
    if info.st_uid != expected_uid:
        raise SystemExit(f"path is not owned by service user: {root}")

inspect_tree(stage, reject_writable=True)
for required in ("plugin.yaml", "adapter.py"):
    path = stage / required
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        raise SystemExit(f"stage is missing {required}")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise SystemExit(f"stage {required} is a symlink or not a regular file")
PY

platform_root="$hermes_home/plugins/platforms"
"$env_python" - "$hermes_home" "$platform_root" "$current_uid" <<'PY'
import os
from pathlib import Path
import stat
import sys

home = Path(sys.argv[1])
target = Path(sys.argv[2])
expected_uid = int(sys.argv[3])
current = home
for component in target.relative_to(home).parts:
    current = current / component
    try:
        info = os.lstat(current)
    except FileNotFoundError:
        os.mkdir(current, 0o700)
        info = os.lstat(current)
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISDIR(info.st_mode)
        or info.st_uid != expected_uid
    ):
        raise SystemExit(f"unsafe plugin parent directory: {current}")
PY

active="$platform_root/bearcode"
next="$platform_root/bearcode.next"
previous="$platform_root/bearcode.previous"
environment_file="$hermes_home/.env"
environment_backup="$hermes_home/.bearcode-env-backup.$$"

validate_owned_tree() {
  local target=$1
  "$env_python" - "$target" "$platform_root" "$current_uid" <<'PY'
import os
from pathlib import Path
import stat
import sys

target = Path(sys.argv[1])
parent = Path(sys.argv[2])
expected_uid = int(sys.argv[3])
if target.parent != parent:
    raise SystemExit(f"unsafe plugin target path: {target}")
try:
    root_info = os.lstat(target)
except FileNotFoundError:
    raise SystemExit(0)
if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
    raise SystemExit(f"unsafe plugin target: {target}")
for directory, names, files in os.walk(target, followlinks=False):
    candidates = [Path(directory)]
    candidates.extend(Path(directory) / name for name in names + files)
    for candidate in candidates:
        info = os.lstat(candidate)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != expected_uid:
            raise SystemExit(f"unsafe deployed path: {candidate}")
PY
}

remove_owned_tree() {
  local target=$1
  "$env_python" - "$target" "$platform_root" "$current_uid" <<'PY'
import os
from pathlib import Path
import shutil
import stat
import sys

target = Path(sys.argv[1])
parent = Path(sys.argv[2])
expected_uid = int(sys.argv[3])
if target.parent != parent:
    raise SystemExit(f"unsafe removal target: {target}")
try:
    root_info = os.lstat(target)
except FileNotFoundError:
    raise SystemExit(0)
if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
    raise SystemExit(f"unsafe removal target: {target}")
for directory, names, files in os.walk(target, followlinks=False):
    candidates = [Path(directory)]
    candidates.extend(Path(directory) / name for name in names + files)
    for candidate in candidates:
        info = os.lstat(candidate)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != expected_uid:
            raise SystemExit(f"unsafe removal path: {candidate}")
shutil.rmtree(target)
PY
}

environment_existed=0
environment_changed=0
previous_moved=0
activated=0
had_current=0
enable_attempted=0
finished=0

restore_environment() {
  if [[ "$environment_changed" != "1" ]]; then
    return
  fi
  "$env_python" - \
    "$environment_file" \
    "$environment_backup" \
    "$environment_existed" \
    "$current_uid" <<'PY'
import os
from pathlib import Path
import stat
import sys

environment = Path(sys.argv[1])
backup = Path(sys.argv[2])
existed = sys.argv[3] == "1"
expected_uid = int(sys.argv[4])
if existed:
    info = os.lstat(backup)
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISREG(info.st_mode)
        or info.st_uid != expected_uid
    ):
        raise SystemExit("unsafe environment backup")
    os.replace(backup, environment)
    os.chmod(environment, 0o600)
else:
    try:
        info = os.lstat(environment)
    except FileNotFoundError:
        info = None
    if info is not None:
        if (
            stat.S_ISLNK(info.st_mode)
            or not stat.S_ISREG(info.st_mode)
            or info.st_uid != expected_uid
        ):
            raise SystemExit("unsafe generated environment file")
        os.unlink(environment)
    try:
        os.unlink(backup)
    except FileNotFoundError:
        pass
PY
  environment_changed=0
}

discard_environment_backup() {
  "$env_python" - "$environment_backup" "$current_uid" <<'PY'
import os
from pathlib import Path
import stat
import sys

backup = Path(sys.argv[1])
expected_uid = int(sys.argv[2])
try:
    info = os.lstat(backup)
except FileNotFoundError:
    raise SystemExit(0)
if (
    stat.S_ISLNK(info.st_mode)
    or not stat.S_ISREG(info.st_mode)
    or info.st_uid != expected_uid
):
    raise SystemExit("unsafe environment backup")
os.unlink(backup)
PY
}

rollback() {
  local status=$1
  local needs_restart=0
  trap - ERR INT TERM HUP
  set +e

  if [[ "$activated" == "1" || "$previous_moved" == "1" ]]; then
    needs_restart=1
  fi
  restore_environment
  if [[ "$activated" == "1" ]]; then
    remove_owned_tree "$active"
    activated=0
  fi
  if [[ "$previous_moved" == "1" && -d "$previous" ]]; then
    mv "$previous" "$active"
    previous_moved=0
  fi
  remove_owned_tree "$next"
  if [[ "$enable_attempted" == "1" && "$had_current" == "0" ]]; then
    "$hermes_cli" plugins disable bearcode-platform >/dev/null 2>&1 || true
  fi
  if [[ "$needs_restart" == "1" ]]; then
    "$systemctl_command" restart hermes-gateway.service \
      >/dev/null 2>&1 || true
  fi
  printf 'Hermes BearCode deployment rolled back.\n' >&2
  exit "$status"
}

on_error() {
  local status=$?
  if [[ "$finished" == "1" ]]; then
    exit "$status"
  fi
  rollback "$status"
}

on_signal() {
  rollback "$1"
}

trap on_error ERR
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

PYTHONPATH="$stage/tests/fakes:$stage${PYTHONPATH:+:$PYTHONPATH}" \
  "$hermes_python" -m unittest discover -s "$stage/tests" -v
PYTHONPATH="$hermes_agent_root:$stage${PYTHONPATH:+:$PYTHONPATH}" \
  "$hermes_python" "$stage/scripts/check-compatibility.py"

validate_owned_tree "$active"
validate_owned_tree "$previous"
validate_owned_tree "$next"
remove_owned_tree "$next"
mkdir -m 0700 "$next"
cp -R "$stage"/. "$next"/
chmod 0700 "$next"

if [[ -e "$environment_file" || -L "$environment_file" ]]; then
  environment_existed=1
fi
environment_changed=1
if ! environment_values=$(
  ENVIRONMENT_FILE="$environment_file" \
  ENVIRONMENT_BACKUP="$environment_backup" \
  ENVIRONMENT_EXISTED="$environment_existed" \
  EXPECTED_UID="$current_uid" \
  REQUESTED_HOST="${BEARCODE_LISTEN_HOST:-}" \
  REQUESTED_PORT="${BEARCODE_LISTEN_PORT:-}" \
  TAILSCALE_HOST="$("$tailscale_command" ip -4)" \
  "$env_python" - <<'PY'
import os
from pathlib import Path
import secrets
import stat

environment = Path(os.environ["ENVIRONMENT_FILE"])
backup = Path(os.environ["ENVIRONMENT_BACKUP"])
existed = os.environ["ENVIRONMENT_EXISTED"] == "1"
expected_uid = int(os.environ["EXPECTED_UID"])

contents = b""
if existed:
    descriptor = os.open(
        environment,
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != expected_uid
        ):
            raise SystemExit("unsafe .env file")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            contents = source.read()
    finally:
        os.close(descriptor)
    os.chmod(environment, 0o600)

backup_descriptor = os.open(
    backup,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
    0o600,
)
try:
    with os.fdopen(backup_descriptor, "wb", closefd=False) as output:
        output.write(contents)
        output.flush()
        os.fsync(output.fileno())
finally:
    os.close(backup_descriptor)

try:
    text = contents.decode("utf-8")
except UnicodeDecodeError:
    raise SystemExit(".env is not valid UTF-8")
lines = text.splitlines()
values = {}
for line in lines:
    if "=" not in line or line.lstrip().startswith("#"):
        continue
    name, value = line.split("=", 1)
    if name in {
        "BEARCODE_PLATFORM_KEY",
        "BEARCODE_LISTEN_HOST",
        "BEARCODE_LISTEN_PORT",
    } and name not in values:
        normalized = value.strip()
        if (
            len(normalized) >= 2
            and normalized[0] == normalized[-1]
            and normalized[0] in {"'", '"'}
        ):
            normalized = normalized[1:-1]
        values[name] = normalized

key = values.get("BEARCODE_PLATFORM_KEY") or secrets.token_hex(32)
if "\n" in key or "\r" in key or not key:
    raise SystemExit("BEARCODE_PLATFORM_KEY is invalid")
host = (
    os.environ.get("REQUESTED_HOST", "").strip()
    or values.get("BEARCODE_LISTEN_HOST", "").strip()
    or os.environ.get("TAILSCALE_HOST", "").strip()
)
if (
    not host
    or any(character.isspace() for character in host)
    or "/" in host
):
    raise SystemExit("BEARCODE_LISTEN_HOST is invalid")
port_text = (
    os.environ.get("REQUESTED_PORT", "").strip()
    or values.get("BEARCODE_LISTEN_PORT", "").strip()
    or "8643"
)
try:
    port = int(port_text)
except ValueError:
    raise SystemExit("BEARCODE_LISTEN_PORT is invalid")
if not 1 <= port <= 65535:
    raise SystemExit("BEARCODE_LISTEN_PORT is invalid")

updates = {
    "BEARCODE_PLATFORM_KEY": key,
    "BEARCODE_LISTEN_HOST": host,
    "BEARCODE_LISTEN_PORT": str(port),
    "BEARCODE_ALLOW_ALL_USERS": "true",
}
rendered = []
written = set()
for line in lines:
    if "=" in line and not line.lstrip().startswith("#"):
        name = line.split("=", 1)[0]
        if name in updates:
            if name not in written:
                rendered.append(f"{name}={updates[name]}")
                written.add(name)
            continue
    rendered.append(line)
for name, value in updates.items():
    if name not in written:
        rendered.append(f"{name}={value}")
payload = ("\n".join(rendered) + "\n").encode("utf-8")
temporary = environment.with_name(f".{environment.name}.{secrets.token_hex(8)}")
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
    0o600,
)
try:
    with os.fdopen(descriptor, "wb", closefd=False) as output:
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())
finally:
    os.close(descriptor)
os.replace(temporary, environment)
os.chmod(environment, 0o600)
print(key)
print(host)
print(port)
PY
); then
  printf 'Hermes BearCode install failed: could not update .env safely.\n' >&2
  rollback 1
fi
platform_key=${environment_values%%$'\n'*}
remaining_values=${environment_values#*$'\n'}
listen_host=${remaining_values%%$'\n'*}
listen_port=${remaining_values##*$'\n'}
if [[ -z "$platform_key" || -z "$listen_host" || -z "$listen_port" ]]; then
  printf 'Hermes BearCode install failed: environment values are invalid.\n' >&2
  rollback 1
fi

remove_owned_tree "$previous"
if [[ -d "$active" ]]; then
  had_current=1
  mv "$active" "$previous"
  previous_moved=1
fi
mv "$next" "$active"
activated=1

enable_attempted=1
"$hermes_cli" plugins enable bearcode-platform
"$systemctl_command" restart hermes-gateway.service
BEARCODE_NATIVE_URL="ws://$listen_host:$listen_port/v1/bearcode" \
BEARCODE_PLATFORM_KEY="$platform_key" \
  "$hermes_python" "$active/scripts/healthcheck.py"

if [[ "$previous_moved" == "1" ]]; then
  deployment_timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
  printf '%s\n' "$deployment_timestamp" \
    > "$previous/.bearcode-deployment-timestamp"
  chmod 0600 "$previous/.bearcode-deployment-timestamp"
fi
discard_environment_backup
environment_changed=0
finished=1
trap - ERR INT TERM HUP
printf 'Hermes BearCode platform deployed successfully.\n'
