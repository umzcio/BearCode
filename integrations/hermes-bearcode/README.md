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
