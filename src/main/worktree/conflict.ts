// F3: the merge engine's conflict helpers now live in src/shared/conflict.ts so
// the renderer's Monaco resolver can reuse the exact same pure transforms
// without importing main-side code. Re-exported here to keep the main-side
// import surface (and Task 8's tests) stable.
export {
  parseConflicts,
  applyChoice,
  type ConflictHunk,
  type ResolvedChoice
} from '../../shared/conflict'
