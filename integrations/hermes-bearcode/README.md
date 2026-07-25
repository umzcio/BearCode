# BearCode Hermes integration

This plugin provides the authenticated native Hermes transport used by BearCode. The local
cross-language suite starts the real Python `BearCodeServer`, connection, protocol, ledger,
authentication, upload cache, and download storage over a loopback WebSocket, then drives them
with the real TypeScript `HermesNativeTurn`. Only the deterministic Hermes delegate is fake.

## Local tests

Run the Python unit suite from the BearCode repository root:

```bash
PYTHONPATH=integrations/hermes-bearcode/tests/fakes:integrations/hermes-bearcode \
integrations/hermes-bearcode/.venv/bin/python -m unittest discover -s integrations/hermes-bearcode/tests -v
```

Run the complete native TypeScript compatibility suite:

```bash
npx vitest run src/main/hermes/protocol.test.ts \
  src/main/hermes/nativeFiles.test.ts \
  src/main/hermes/nativeClient.test.ts \
  src/main/hermes/nativeRunner.test.ts \
  src/main/hermes/nativeIntegration.test.ts
```

The Python test fakes exercise the adapter contracts without requiring a Hermes checkout. They
are deliberately first on `PYTHONPATH` only for that unit command. The final installed-plugin
compatibility check omits those fakes and imports the real installed Hermes `gateway` and `tools`
modules before deployment.

The cross-language test chooses an ephemeral loopback port, waits for the child server's single
`READY` line, and applies bounded timeouts to readiness, turns, and shutdown. It uses temporary
attachment and server roots and removes them after every run.

## Deploy to `umzspark`

Deploy from a clean BearCode workspace. The current route is a two-hop copy through `umzcaio`,
followed by installation as the Hermes service user (`root` on the current host):

```bash
git -c tar.umask=0022 archive --format=tar.gz \
  --output=/tmp/hermes-bearcode-plugin.tgz \
  HEAD:integrations/hermes-bearcode
scp -o ProxyJump=umzcaio /tmp/hermes-bearcode-plugin.tgz zach@umzspark:/tmp/hermes-bearcode-plugin.tgz
ssh -o BatchMode=yes umzcaio
sudo -i
ssh umzspark
mkdir -p /tmp/hermes-bearcode-stage
tar -C /tmp/hermes-bearcode-stage -xzf /tmp/hermes-bearcode-plugin.tgz
HERMES_HOME=/root/.hermes /tmp/hermes-bearcode-stage/scripts/install-local.sh /tmp/hermes-bearcode-stage
```

The installer rejects root, overlapping, unowned, writable-by-other-user, and symlinked stage
paths. Before copying anything, it runs the staged Python tests and imports the staged adapter
against the real installed Hermes modules. It then builds `bearcode.next`, securely updates
`/root/.hermes/.env`, and atomically swaps the active directory. The previous deployment is kept
at `bearcode.previous` with a UTC deployment timestamp. A failed enable, restart, health check, or
interrupt restores both the previous plugin and the prior `.env`, then restarts the gateway.

The platform key is generated only when `BEARCODE_PLATFORM_KEY` is absent. The `.env` file remains
mode `0600`, and the key is passed to the health check through its environment, never a process
argument. To display the generated key once for manual entry in BearCode Settings, run this on
`umzspark`:

```bash
/usr/local/lib/hermes-agent/venv/bin/python - <<'PY'
from pathlib import Path
import shlex

matches = []
for line in Path("/root/.hermes/.env").read_text(encoding="utf-8").splitlines():
    candidate = line.lstrip()
    if candidate.startswith("export "):
        candidate = candidate[7:].lstrip()
    if candidate.startswith("BEARCODE_PLATFORM_KEY="):
        matches.append(
            shlex.split(candidate.split("=", 1)[1], comments=False, posix=True)
        )
if len(matches) != 1 or len(matches[0]) != 1 or not matches[0][0]:
    raise SystemExit("expected one non-empty BEARCODE_PLATFORM_KEY")
print(matches[0][0])
PY
```

The command itself contains no secret, so shell history records no key. Do not paste the output
into repository files, terminal commands, chat, or issue trackers. Enter it directly into the
Native Platform key field in BearCode Settings.

`git archive` packages tracked source from the committed integration tree only. The explicit
archive umask produces non-writable group/other modes accepted by the installer while preserving
executable scripts. The archive excludes the plugin-local `.venv`, Python caches, ignored files,
and other untracked/build artifacts that the installer correctly rejects.

For a direct post-deploy probe, point the health check at `.env`. It extracts only the unique
literal platform-key assignment without evaluating any other line and keeps the key out of
command arguments:

```bash
BEARCODE_NATIVE_URL="ws://$(tailscale ip -4):8643/v1/bearcode" \
BEARCODE_ENV_FILE=/root/.hermes/.env \
/usr/local/lib/hermes-agent/venv/bin/python \
/root/.hermes/plugins/platforms/bearcode/scripts/healthcheck.py
```
