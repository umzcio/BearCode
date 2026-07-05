// The artifacts substrate (Ba1, design 2026-07-04-ba-artifacts-design.md
// sections 3.3/3.4): plan and walkthrough rows in the artifacts table, with
// per-conversation-per-type versioning and pending-plan supersede. The layering
// mirrors src/main/permissions/store.ts: db/index.ts holds the SQL, this
// module holds the logic, tested with a mocked '../db'.
//
// SECURITY (design section 4): this module writes ONLY artifact DB rows. It
// must never gain filesystem or command capability, and an 'approved' status
// minted here is a workflow record, NOT permission -- plan approval never
// pre-approves any command or edit; every Bb permission gate still runs per
// call when the agent implements.
import { randomUUID } from 'crypto'
import type { Artifact, ArtifactReviewPolicy, ArtifactType } from '../../shared/types'
import { getArtifact, insertArtifact, listArtifacts, markPendingPlansSuperseded } from '../db'
import { getSettings } from '../settings'

// Pure: versions are per conversation+type and start at 1 (design 3.4).
export function nextArtifactVersion(existing: readonly Artifact[], type: ArtifactType): number {
  let max = 0
  for (const a of existing) {
    if (a.type === type && a.version > max) max = a.version
  }
  return max + 1
}

// One plan submission. The review policy is read LIVE here, at submit time
// (design 3.3: no restart; and design 5: a policy flipped later never
// retroactively changes an already-recorded row). Under 'always-proceed' the
// plan is recorded approved-and-resolved immediately ("immediately bypass the
// pause"); under 'request-review' it is recorded pending-review -- in Ba1 the
// caller still returns to the model immediately (the plan_review interrupt is
// Ba2), which is why the status, not control flow, carries the difference.
// A still-pending prior plan is superseded by this submission (design 3.1);
// approved plans are history and are never rewritten.
//
// REPLAY IDEMPOTENCY: checkpoint durability is 'async' and the graph's task
// writes (checkpoints.db) share no transaction with these rows (bearcode.db),
// so a crash after the tool completed but before its task writes committed
// makes the resumed graph RE-EXECUTE this call. The caller derives `id`
// deterministically from the provider tool-call id (tools.ts), so the
// re-execution finds the row it already wrote and returns it unchanged: no
// second insert, no re-supersede, no version bump. An id-less provider falls
// back to randomUUID and accepts the residual duplicate-on-crash window (same
// class as an id-less approval card).
export function createPlanArtifact(
  conversationId: string,
  title: string,
  body: string,
  id: string = randomUUID()
): { artifact: Artifact; policy: ArtifactReviewPolicy } {
  const existing = getArtifact(id)
  if (existing) {
    return {
      artifact: existing,
      // Reconstruct the policy that governed the ORIGINAL submission from the
      // recorded status -- the live setting may have flipped since, and the
      // replayed tool must return the copy the original run earned. Only an
      // 'approved' row reconstructs 'always-proceed'; anything else (incl.
      // 'superseded') fails safe to 'request-review' so a replay never mints
      // approval copy for a plan the user never green-lit.
      policy: existing.status === 'approved' ? 'always-proceed' : 'request-review'
    }
  }
  const policy = getSettings().artifactReviewPolicy
  const now = Date.now()
  const version = nextArtifactVersion(listArtifacts(conversationId), 'plan')
  markPendingPlansSuperseded(conversationId, now)
  const artifact: Artifact = {
    id,
    conversationId,
    type: 'plan',
    version,
    title,
    body,
    status: policy === 'always-proceed' ? 'approved' : 'pending-review',
    createdAt: now,
    resolvedAt: policy === 'always-proceed' ? now : null
  }
  insertArtifact(artifact)
  return { artifact, policy }
}

// Walkthroughs never pause and are born 'final' (design 3.4), regardless of
// the review policy, and never touch plan rows. Same replay idempotency as
// createPlanArtifact: an existing row under the deterministic id is returned
// unchanged, nothing re-inserted.
export function createWalkthroughArtifact(
  conversationId: string,
  title: string,
  body: string,
  id: string = randomUUID()
): Artifact {
  const existing = getArtifact(id)
  if (existing) return existing
  const now = Date.now()
  const artifact: Artifact = {
    id,
    conversationId,
    type: 'walkthrough',
    version: nextArtifactVersion(listArtifacts(conversationId), 'walkthrough'),
    title,
    body,
    status: 'final',
    createdAt: now,
    resolvedAt: now
  }
  insertArtifact(artifact)
  return artifact
}
