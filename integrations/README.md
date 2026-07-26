# integrations/

## hermes-bearcode

Moved to its own private repository: **https://github.com/umzcio/bearcode-hermes**

That package is the Hermes gateway platform plugin (the Python side, deployed
to `umzspark`) — a standalone install target, not part of the Electron app,
so it lives outside this monorepo. Full history was preserved via
`git subtree split` at the time of the split (2026-07-26).

The BearCode-side native client (`src/main/hermes/nativeClient.ts` and
related files) stays in this repo — that's the actual app.
