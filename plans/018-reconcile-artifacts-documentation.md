# Plan 018: Reconcile Artifacts Pane implementation records with shipped behavior

> **Executor instructions**: Update records only after all prerequisite verification is green. Never
> mark an item complete based on intent alone. Update the plan index last.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- docs/superpowers/specs/2026-07-27-artifacts-pane-motion-polish-design.md docs/superpowers/plans/2026-07-27-artifacts-pane-motion-polish.md CLAUDE.md src/renderer/src/components src/main/browser`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: every preceding plan in `plans/README.md` (`plans/001-*.md` through
  `plans/017-*.md`)
- **Category**: docs
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

The motion design still says “Approved, pending implementation plan” even though commits
`860168d` through `102a212` implemented it. Its implementation plan leaves Task 8 unchecked despite
focused verification having been run, and source/test comments still describe a future headed gate.
Stale records cause repeated audits and can make later agents undo intentional constraints.

## Current state

- `docs/superpowers/specs/2026-07-27-artifacts-pane-motion-polish-design.md:3` says
  `Status: Approved, pending implementation plan`.
- The implementing commit chain is:
  - `860168d` signal-completed exits;
  - `887a93e` native browser staging;
  - `2afafc0` persistent shell;
  - `563a8b8` control motion;
  - `f9743a8` inline view-zone motion;
  - `28ab9d9` plan resolution acknowledgment;
  - `59ef879` preview arrival;
  - `102a212` malformed-token rejection.
- `docs/superpowers/plans/2026-07-27-artifacts-pane-motion-polish.md:1184+` leaves full regression
  verification unchecked.
- `CLAUDE.md` currently documents a nonzero type baseline; plan 001 must replace it before this plan.
- Plan 012 removes the silent “live only” browser-test fiction; comments must point to the real
  headed command.
- The design constraints remain authoritative and must stay documented: persistent shell,
  immediate high-frequency switching, no per-frame native-view IPC, 2000ms failsafe, bounded Monaco
  height exception, and no review-flow redesign.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Plan status | `rg -n "\\[ \\]|pending implementation|17 node|2 web|if \\(!live\\) return|live only" docs/superpowers/specs/2026-07-27-artifacts-pane-motion-polish-design.md docs/superpowers/plans/2026-07-27-artifacts-pane-motion-polish.md CLAUDE.md src/renderer/src/components src/main/browser` | no stale matches in scoped records |
| Full gate | `npm run typecheck && npm test && npm run build` | exit 0 |
| Headed browser | `npm run test:electron:browser` | exit 0 |
| Doc diff | `git diff --check -- docs CLAUDE.md plans/README.md` | exit 0 |

## Scope

**In scope**:

- `docs/superpowers/specs/2026-07-27-artifacts-pane-motion-polish-design.md`
- `docs/superpowers/plans/2026-07-27-artifacts-pane-motion-polish.md`
- `CLAUDE.md`
- Stale comments in `src/renderer/src/components/ArtifactsPane.tsx`,
  `src/renderer/src/components/artifactsPane/` (if plan 017 created it),
  `src/renderer/src/components/Browser/BrowserPane.tsx`, and
  `src/main/browser/manager.test.ts`
- `plans/README.md`

**Out of scope**:

- Rewriting the design rationale
- Claiming a verification that was not run in this branch/environment
- Editing unrelated historical plans
- Removing intentional non-goals/edge-case decisions

## Git workflow

- Branch: `advisor/018-reconcile-artifacts-documentation`
- Commit: `docs: reconcile artifacts pane implementation`

## Steps

### Step 1: Verify the implementation, do not infer it

Run full typecheck, tests, build, focused pane suite, CSS contract, and headed browser command. Save
the exact command names/results in the implementation-plan verification section. If any command is
red, stop; do not check its box.

### Step 2: Update design status and implementation note

Change the design status to `Implemented` (or `Implemented and follow-up audited`) and add a concise
implementation note listing the commit chain and follow-up `plans/README.md`. Preserve all goals,
non-goals, and design decisions. Do not rewrite the document as if the follow-up fixes were part of
the original motion proposal.

**Verify**: no “pending implementation plan” remains.

### Step 3: Reconcile the original implementation checklist

Mark only completed steps/tasks checked. For Task 8, record the actual current commands and results,
not stale historical counts. If the plan contains commands superseded by the new headed gate or
zero-baseline gate, annotate the replacement rather than deleting history.

**Verify**:

```bash
rg -n "\\[ \\]" docs/superpowers/plans/2026-07-27-artifacts-pane-motion-polish.md
```

Expected: no unchecked item that was executed; any intentionally deferred item has a one-line reason.

### Step 4: Remove stale source/test commentary

Search scoped Artifacts/browser files for claims that the motion pass is pending, full typecheck
errors are accepted, or browser tests silently defer to a nonexistent future harness. Update comments
to match current code/command. Comments should explain invariants, not audit chronology.

### Step 5: Close the advisor index

Confirm plans 001-017 are DONE or carry explicit BLOCKED/REJECTED reasons. Mark plan 018 DONE only
after doc diff check passes. The “Findings considered and rejected” section remains “None”; the user
selected every finding/opportunity.

## Test plan

Documentation is verified by exact stale-string scans and the same commands it claims passed.
No prose-only assertion substitutes for command output.

## Done criteria

- [ ] Design status matches implementation.
- [ ] Original checklist reflects actual execution.
- [ ] Required constraints/non-goals remain intact.
- [ ] No stale nonzero-baseline or pseudo-live-harness claim remains.
- [ ] Every plan row has a truthful terminal/current status.
- [ ] Full, headed, and doc-diff gates pass.

## STOP conditions

- Any prerequisite plan is not DONE/BLOCKED with a documented reason.
- A claimed command cannot run in the current environment.
- Commit history contradicts an implementation claim.
- Updating a source comment would require changing code behavior.

## Maintenance notes

Historical design docs should preserve why; status notes should say what shipped and how it is
verified. Future audits should start from `plans/README.md`, not reopen already closed findings.
