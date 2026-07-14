# Security Policy

## Supported Versions

BearCode is pre-1.x-stable and moves fast. Only the latest published release
is supported with security fixes — there's no parallel maintenance of older
versions right now.

| Version | Supported |
|---------|-----------|
| latest  | ✅ |
| older   | ❌ |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Use GitHub's [private vulnerability reporting](https://github.com/umzcio/BearCode/security/advisories/new)
for this repo instead — it opens a private draft advisory visible only to
the maintainer until a fix is ready. This applies especially to anything
touching:

- The **sandbox escape hatch** (`unsandboxed()` / Seatbelt policy in
  `src/main/orchestrator/sandbox`)
- The **secrets vault** or key handling (`src/main/keys.ts`)
- **Path jailing** under `.agents/` or a project's outside-access policy
- The **trust/consent model** for hooks, plugins, or MCP servers
- **Code signing / notarization / auto-update** integrity (`src/main/updater.ts`,
  `electron-builder.yml`)

You should receive an initial response within a few days. Confirmed
vulnerabilities will be credited in the fix's release notes unless you'd
prefer to stay anonymous.

## Scope

BearCode runs entirely on your own machine with your own API keys — there
is no BearCode-operated backend or hosted service in scope. Findings in
third-party dependencies should generally be reported upstream, but feel
free to flag them here too if you're not sure.
