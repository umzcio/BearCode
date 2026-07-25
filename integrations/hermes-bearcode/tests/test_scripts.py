"""Behavior tests for upgrade-safe BearCode plugin deployment tooling."""
import asyncio
import getpass
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

from aiohttp import web


PLUGIN_ROOT = Path(__file__).parents[1]
SCRIPTS_ROOT = PLUGIN_ROOT / "scripts"
COMPATIBILITY_SCRIPT = SCRIPTS_ROOT / "check-compatibility.py"
HEALTHCHECK_SCRIPT = SCRIPTS_ROOT / "healthcheck.py"
INSTALL_SCRIPT = SCRIPTS_ROOT / "install-local.sh"


def _write(path, contents, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        textwrap.dedent(contents).lstrip("\n"),
        encoding="utf-8",
    )
    path.chmod(mode)


def _fake_runtime(root, *, missing_hook=None):
    base_methods = [
        "connect",
        "disconnect",
        "send",
        "edit_message",
        "send_document",
        "send_image_file",
        "send_clarify",
        "handle_message",
        "build_source",
        "on_processing_start",
        "on_processing_complete",
        "validate_media_delivery_path",
    ]
    method_source = "\n".join(
        f"    def {name}(self, *args, **kwargs): pass"
        for name in base_methods
        if name != missing_hook
    )
    for package in (
        "gateway",
        "gateway/platforms",
        "tools",
    ):
        _write(root / package / "__init__.py", "")
    _write(
        root / "gateway/config.py",
        """
        from enum import Enum
        class Platform(Enum):
            LOCAL = "local"
            @classmethod
            def _missing_(cls, value):
                member = object.__new__(cls)
                member._name_ = str(value).upper()
                member._value_ = str(value)
                cls._value2member_map_[value] = member
                return member
        """,
    )
    _write(
        root / "gateway/session.py",
        """
        def build_session_key(*args, **kwargs):
            return "fake-session"
        """,
    )
    base_source = (
        "from enum import Enum\n"
        "from pathlib import Path\n\n"
        "class BasePlatformAdapter:\n"
        f"{method_source or '    pass'}\n\n"
        "class MessageEvent:\n"
        "    pass\n\n"
        "class MessageType(Enum):\n"
        "    TEXT = 'text'\n"
        "    PHOTO = 'photo'\n"
        "    DOCUMENT = 'document'\n\n"
        "class ProcessingOutcome(Enum):\n"
        "    SUCCESS = 'success'\n"
        "    FAILURE = 'failure'\n"
        "    CANCELLED = 'cancelled'\n\n"
        "class SendResult:\n"
        "    def __init__(self, **kwargs):\n"
        "        self.__dict__.update(kwargs)\n\n"
        "def cache_media_bytes(*args, **kwargs):\n"
        "    return None\n\n"
        "def _cache(name):\n"
        f"    path = Path({str(root)!r}) / 'cache' / name\n"
        "    path.mkdir(parents=True, exist_ok=True)\n"
        "    return path\n\n"
        "def get_image_cache_dir():\n"
        "    return _cache('images')\n\n"
        "def get_audio_cache_dir():\n"
        "    return _cache('audio')\n\n"
        "def get_video_cache_dir():\n"
        "    return _cache('video')\n\n"
        "def get_document_cache_dir():\n"
        "    return _cache('documents')\n"
    )
    _write(root / "gateway/platforms/base.py", base_source)
    _write(
        root / "tools/approval.py",
        """
        def resolve_gateway_approval(*args, **kwargs):
            return True
        """,
    )
    _write(
        root / "tools/clarify_gateway.py",
        """
        def resolve_gateway_clarify(*args, **kwargs):
            return True
        """,
    )


class CompatibilityScriptTests(unittest.TestCase):
    def _run(self, runtime):
        environment = os.environ.copy()
        environment["PYTHONPATH"] = os.pathsep.join(
            (str(runtime), str(PLUGIN_ROOT))
        )
        return subprocess.run(
            (sys.executable, str(COMPATIBILITY_SCRIPT)),
            cwd=PLUGIN_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )

    def test_real_contract_import_and_registration_succeeds(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            _fake_runtime(runtime)

            result = self._run(runtime)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("compatible", result.stdout.lower())

    def test_missing_required_base_hook_refuses_before_installation(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            _fake_runtime(
                runtime,
                missing_hook="validate_media_delivery_path",
            )

            result = self._run(runtime)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("validate_media_delivery_path", result.stderr)


class HealthcheckScriptTests(unittest.IsolatedAsyncioTestCase):
    async def _run_probe(self, response):
        observed = {}

        async def handler(request):
            observed["authorization"] = request.headers.get("Authorization")
            socket = web.WebSocketResponse()
            await socket.prepare(request)
            message = await socket.receive_json()
            observed["hello"] = message
            await socket.send_json(response)
            await socket.close()
            return socket

        application = web.Application()
        application.router.add_get("/v1/bearcode", handler)
        runner = web.AppRunner(application)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        environment = os.environ.copy()
        environment.update(
            {
                "BEARCODE_NATIVE_URL": (
                    f"ws://127.0.0.1:{port}/v1/bearcode"
                ),
                "BEARCODE_PLATFORM_KEY": "probe-secret",
            }
        )
        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                str(HEALTHCHECK_SCRIPT),
                cwd=str(PLUGIN_ROOT),
                env=environment,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=10,
            )
        finally:
            await runner.cleanup()
        return (
            process.returncode,
            stdout.decode(),
            stderr.decode(),
            observed,
        )

    async def test_authenticated_probe_uses_canonical_hello_and_env_secret(self):
        response = {
            "type": "hello.accepted",
            "protocol": "bearcode-hermes",
            "version": 1,
            "connectionId": "33333333-3333-4333-8333-333333333333",
            "capabilities": {
                "streaming": True,
                "toolProgress": True,
                "approvals": True,
                "clarifications": True,
                "attachments": {
                    "upload": True,
                    "download": True,
                    "maxFiles": 5,
                    "maxBytesPerFile": 10485760,
                    "maxChunkBytes": 262144,
                },
            },
        }

        returncode, stdout, stderr, observed = await self._run_probe(
            response
        )

        self.assertEqual(returncode, 0, stderr)
        self.assertIn("protocol 1", stdout)
        self.assertEqual(
            observed["authorization"],
            "Bearer probe-secret",
        )
        self.assertEqual(
            observed["hello"]["protocol"],
            "bearcode-hermes",
        )
        self.assertEqual(observed["hello"]["versions"], [1])
        self.assertEqual(observed["hello"]["client"]["name"], "BearCode")
        self.assertRegex(
            observed["hello"]["conversationId"],
            r"^[0-9a-f-]{36}$",
        )
        self.assertRegex(
            observed["hello"]["installationId"],
            r"^[0-9a-f-]{36}$",
        )
        self.assertNotIn("probe-secret", stdout + stderr)

    async def test_incorrect_attachment_limits_fail_without_leaking_key(self):
        response = {
            "type": "hello.accepted",
            "protocol": "bearcode-hermes",
            "version": 1,
            "connectionId": "33333333-3333-4333-8333-333333333333",
            "capabilities": {
                "streaming": True,
                "toolProgress": True,
                "approvals": True,
                "clarifications": True,
                "attachments": {
                    "upload": True,
                    "download": True,
                    "maxFiles": 5,
                    "maxBytesPerFile": 10485760,
                    "maxChunkBytes": 1,
                },
            },
        }

        returncode, stdout, stderr, _ = await self._run_probe(response)

        self.assertNotEqual(returncode, 0)
        self.assertIn("incompatible", stderr.lower())
        self.assertNotIn("probe-secret", stdout + stderr)


class InstallerScriptTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.home = self.root / "hermes-home"
        self.home.mkdir(mode=0o700)
        self.commands = self.root / "commands"
        self.commands.mkdir()
        self.command_log = self.root / "commands.log"
        self.health_started = self.root / "health-started"
        self.restart_count = self.root / "restart-count"
        self._make_fake_commands()

    def tearDown(self):
        self.temporary.cleanup()

    def _make_fake_commands(self):
        _write(
            self.commands / "python",
            r"""
            #!/bin/sh
            printf '%s\n' "$*" >> "$FAKE_COMMAND_LOG"
            case "$*" in
              *check-compatibility.py*)
                if [ "${FAKE_COMPAT_FAIL:-0}" = "1" ]; then
                  exit 42
                fi
                ;;
              *healthcheck.py*)
                : > "$FAKE_HEALTH_STARTED"
                if [ "${FAKE_HEALTH_BLOCK:-0}" = "1" ]; then
                  trap 'exit 143' TERM INT HUP
                  while :; do sleep 1; done
                fi
                if [ "${FAKE_HEALTH_FAIL:-0}" = "1" ]; then
                  exit 43
                fi
                ;;
            esac
            exit 0
            """,
            0o755,
        )
        _write(
            self.commands / "hermes",
            r"""
            #!/bin/sh
            printf 'hermes %s\n' "$*" >> "$FAKE_COMMAND_LOG"
            if [ "${FAKE_ENABLE_FAIL:-0}" = "1" ]; then
              exit 44
            fi
            """,
            0o755,
        )
        _write(
            self.commands / "systemctl",
            r"""
            #!/bin/sh
            printf 'systemctl %s\n' "$*" >> "$FAKE_COMMAND_LOG"
            count=0
            if [ -f "$FAKE_RESTART_COUNT" ]; then
              count=$(cat "$FAKE_RESTART_COUNT")
            fi
            count=$((count + 1))
            printf '%s\n' "$count" > "$FAKE_RESTART_COUNT"
            if [ "${FAKE_RESTART_FAIL_ONCE:-0}" = "1" ] &&
               [ "$count" -eq 1 ]; then
              exit 45
            fi
            """,
            0o755,
        )
        _write(
            self.commands / "tailscale",
            r"""
            #!/bin/sh
            printf 'tailscale %s\n' "$*" >> "$FAKE_COMMAND_LOG"
            printf '%s\n' '100.64.0.2'
            """,
            0o755,
        )

    def _make_stage(self, name="new", *, manifest=True):
        stage = self.root / f"stage-{name}"
        (stage / "scripts").mkdir(parents=True)
        if manifest:
            _write(stage / "plugin.yaml", "name: bearcode-platform\n")
        _write(stage / "adapter.py", "def register(ctx): pass\n")
        _write(stage / "VERSION", f"{name}\n")
        for script in ("check-compatibility.py", "healthcheck.py"):
            source = SCRIPTS_ROOT / script
            if source.exists():
                shutil.copy2(source, stage / "scripts" / script)
            else:
                _write(stage / "scripts" / script, "")
        (stage / "tests").mkdir()
        return stage

    def _seed_current(self, value="old"):
        current = self.home / "plugins/platforms/bearcode"
        current.mkdir(parents=True)
        _write(current / "VERSION", f"{value}\n")
        return current

    def _environment(self, **updates):
        environment = os.environ.copy()
        environment.update(
            {
                "HERMES_HOME": str(self.home),
                "HERMES_PYTHON": str(self.commands / "python"),
                "HERMES_CLI": str(self.commands / "hermes"),
                "HERMES_SYSTEMCTL": str(
                    self.commands / "systemctl"
                ),
                "HERMES_TAILSCALE": str(
                    self.commands / "tailscale"
                ),
                "HERMES_ENV_PYTHON": sys.executable,
                "HERMES_SERVICE_USER": getpass.getuser(),
                "FAKE_COMMAND_LOG": str(self.command_log),
                "FAKE_HEALTH_STARTED": str(self.health_started),
                "FAKE_RESTART_COUNT": str(self.restart_count),
            }
        )
        environment.update({key: str(value) for key, value in updates.items()})
        return environment

    def _run(self, stage=None, **updates):
        arguments = ("bash", str(INSTALL_SCRIPT))
        if stage is not None:
            arguments += (str(stage),)
        return subprocess.run(
            arguments,
            cwd=PLUGIN_ROOT,
            env=self._environment(**updates),
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )

    def _command_lines(self):
        if not self.command_log.exists():
            return []
        return self.command_log.read_text(encoding="utf-8").splitlines()

    def test_refuses_root_empty_overlap_and_service_user_mismatch(self):
        stage = self._make_stage()
        cases = (
            ("missing stage", None, {}, "stage"),
            ("root stage", Path("/"), {}, "root"),
            (
                "root home",
                stage,
                {"HERMES_HOME": "/"},
                "root",
            ),
            (
                "overlapping paths",
                self.home / "stage",
                {},
                "overlap",
            ),
            (
                "service user mismatch",
                stage,
                {"HERMES_SERVICE_USER": "__not_the_current_user__"},
                "service user",
            ),
        )
        (self.home / "stage").mkdir()
        _write(self.home / "stage/plugin.yaml", "name: x\n")
        _write(self.home / "stage/adapter.py", "pass\n")

        for label, candidate, updates, expected in cases:
            with self.subTest(label=label):
                result = self._run(candidate, **updates)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr.lower())

        self.assertEqual(self._command_lines(), [])

    def test_manifest_symlink_and_compatibility_failure_stop_before_copy(self):
        current = self._seed_current()
        missing = self._make_stage("missing", manifest=False)

        missing_result = self._run(missing)

        self.assertNotEqual(missing_result.returncode, 0)
        self.assertEqual((current / "VERSION").read_text(), "old\n")
        self.assertFalse(current.with_name("bearcode.next").exists())
        outside = self.root / "outside-adapter.py"
        _write(outside, "pass\n")
        unsafe = self._make_stage("unsafe")
        (unsafe / "adapter.py").unlink()
        (unsafe / "adapter.py").symlink_to(outside)

        unsafe_result = self._run(unsafe)

        self.assertNotEqual(unsafe_result.returncode, 0)
        self.assertIn("symlink", unsafe_result.stderr.lower())
        compatible = self._make_stage("compat")
        compatibility_result = self._run(
            compatible,
            FAKE_COMPAT_FAIL=1,
        )
        self.assertNotEqual(compatibility_result.returncode, 0)
        self.assertEqual((current / "VERSION").read_text(), "old\n")
        self.assertFalse(current.with_name("bearcode.next").exists())
        commands = self._command_lines()
        self.assertTrue(any("-m unittest discover" in line for line in commands))
        self.assertTrue(
            any("check-compatibility.py" in line for line in commands)
        )
        self.assertFalse(any(line.startswith("hermes ") for line in commands))
        self.assertFalse(
            any(line.startswith("systemctl ") for line in commands)
        )

    def test_stage_special_files_are_rejected_before_tests_or_copy(self):
        stage = self._make_stage("special")
        os.mkfifo(stage / "unexpected-pipe")

        result = self._run(stage)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("regular file", result.stderr.lower())
        self.assertEqual(self._command_lines(), [])
        self.assertFalse(
            (self.home / "plugins/platforms/bearcode.next").exists()
        )

    def test_successful_install_preserves_secret_mode_and_previous_version(self):
        current = self._seed_current()
        previous = current.with_name("bearcode.previous")
        previous.mkdir()
        _write(previous / "VERSION", "stale\n")
        environment_file = self.home / ".env"
        _write(
            environment_file,
            "OTHER=value\nBEARCODE_PLATFORM_KEY=keep-me\n",
            0o644,
        )
        stage = self._make_stage()

        result = self._run(stage)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((current / "VERSION").read_text(), "new\n")
        self.assertEqual((previous / "VERSION").read_text(), "old\n")
        timestamp = (
            previous / ".bearcode-deployment-timestamp"
        ).read_text().strip()
        self.assertRegex(timestamp, r"^\d{8}T\d{6}Z$")
        environment = environment_file.read_text(encoding="utf-8")
        self.assertIn("OTHER=value\n", environment)
        self.assertEqual(
            environment.count("BEARCODE_PLATFORM_KEY=keep-me"),
            1,
        )
        self.assertIn("BEARCODE_LISTEN_HOST=100.64.0.2", environment)
        self.assertIn("BEARCODE_LISTEN_PORT=8643", environment)
        self.assertIn("BEARCODE_ALLOW_ALL_USERS=true", environment)
        self.assertEqual(stat.S_IMODE(environment_file.stat().st_mode), 0o600)
        self.assertFalse(current.with_name("bearcode.next").exists())
        commands = self._command_lines()
        expected_order = (
            "-m unittest discover",
            "check-compatibility.py",
            "hermes plugins enable bearcode-platform",
            "systemctl restart hermes-gateway.service",
            "healthcheck.py",
        )
        positions = [
            next(index for index, line in enumerate(commands) if item in line)
            for item in expected_order
        ]
        self.assertEqual(positions, sorted(positions))
        self.assertFalse(
            any("keep-me" in line for line in self._command_lines())
        )

    def test_generated_key_is_64_hex_and_is_not_rotated(self):
        self._seed_current()
        first = self._run(self._make_stage("first"))
        self.assertEqual(first.returncode, 0, first.stderr)
        environment_file = self.home / ".env"
        first_environment = environment_file.read_text(encoding="utf-8")
        match = re.search(
            r"^BEARCODE_PLATFORM_KEY=([0-9a-f]{64})$",
            first_environment,
            re.MULTILINE,
        )
        self.assertIsNotNone(match)
        secret = match.group(1)

        second = self._run(self._make_stage("second"))

        self.assertEqual(second.returncode, 0, second.stderr)
        second_environment = environment_file.read_text(encoding="utf-8")
        self.assertEqual(
            second_environment.count(f"BEARCODE_PLATFORM_KEY={secret}"),
            1,
        )
        command_text = "\n".join(self._command_lines())
        self.assertNotIn(secret, command_text)

    def test_health_failure_restores_plugin_and_environment_then_restarts(self):
        current = self._seed_current()
        environment_file = self.home / ".env"
        original_environment = (
            "OTHER=original\nBEARCODE_PLATFORM_KEY=stable-key\n"
        )
        _write(environment_file, original_environment, 0o600)

        result = self._run(
            self._make_stage(),
            FAKE_HEALTH_FAIL=1,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((current / "VERSION").read_text(), "old\n")
        self.assertEqual(environment_file.read_text(), original_environment)
        self.assertEqual(stat.S_IMODE(environment_file.stat().st_mode), 0o600)
        self.assertFalse(current.with_name("bearcode.previous").exists())
        self.assertFalse(current.with_name("bearcode.next").exists())
        restarts = [
            line
            for line in self._command_lines()
            if line == "systemctl restart hermes-gateway.service"
        ]
        self.assertEqual(len(restarts), 2)

    def test_restart_failure_after_activation_rolls_back_and_restarts_old(self):
        current = self._seed_current()

        result = self._run(
            self._make_stage(),
            FAKE_RESTART_FAIL_ONCE=1,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((current / "VERSION").read_text(), "old\n")
        self.assertFalse(current.with_name("bearcode.previous").exists())
        self.assertFalse(current.with_name("bearcode.next").exists())
        restarts = [
            line
            for line in self._command_lines()
            if line == "systemctl restart hermes-gateway.service"
        ]
        self.assertEqual(len(restarts), 2)
        self.assertFalse(
            any("healthcheck.py" in line for line in self._command_lines())
        )

    def test_failed_first_install_undoes_enablement_and_generated_secret(self):
        result = self._run(
            self._make_stage(),
            FAKE_HEALTH_FAIL=1,
        )

        self.assertNotEqual(result.returncode, 0)
        platform_root = self.home / "plugins/platforms"
        self.assertFalse((platform_root / "bearcode").exists())
        self.assertFalse((platform_root / "bearcode.previous").exists())
        self.assertFalse((platform_root / "bearcode.next").exists())
        self.assertFalse((self.home / ".env").exists())
        self.assertIn(
            "hermes plugins disable bearcode-platform",
            self._command_lines(),
        )

    def test_termination_during_healthcheck_rolls_back_and_cleans_next(self):
        current = self._seed_current()
        stage = self._make_stage()
        process = subprocess.Popen(
            ("bash", str(INSTALL_SCRIPT), str(stage)),
            cwd=PLUGIN_ROOT,
            env=self._environment(FAKE_HEALTH_BLOCK=1),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        deadline = time.monotonic() + 10
        while (
            not self.health_started.exists()
            and process.poll() is None
            and time.monotonic() < deadline
        ):
            time.sleep(0.02)
        self.assertTrue(self.health_started.exists())

        os.killpg(process.pid, signal.SIGTERM)
        _, stderr = process.communicate(timeout=10)

        self.assertNotEqual(process.returncode, 0, stderr)
        self.assertEqual((current / "VERSION").read_text(), "old\n")
        self.assertFalse(current.with_name("bearcode.previous").exists())
        self.assertFalse(current.with_name("bearcode.next").exists())


if __name__ == "__main__":
    unittest.main()
