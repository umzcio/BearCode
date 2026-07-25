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
tar -C integrations/hermes-bearcode -czf /tmp/hermes-bearcode-plugin.tgz .
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
awk -F= '$1 == "BEARCODE_PLATFORM_KEY" { print substr($0, index($0, "=") + 1); exit }' /root/.hermes/.env
```

The command itself contains no secret, so shell history records no key. Do not paste the output
into repository files, terminal commands, chat, or issue trackers. Enter it directly into the
Native Platform key field in BearCode Settings.

For a direct post-deploy probe, load the environment without putting the key in command
arguments:

```bash
set -a
. /root/.hermes/.env
set +a
HERMES_HOME=/root/.hermes \
BEARCODE_NATIVE_URL="ws://$(tailscale ip -4):8643/v1/bearcode" \
/usr/local/lib/hermes-agent/venv/bin/python \
/root/.hermes/plugins/platforms/bearcode/scripts/healthcheck.py
```
