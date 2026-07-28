# Monaco Comment Retargeting Design

## Context

Plan 010 requires `HeightAnimator` to ignore a repeated request for the same
active target. The existing Monaco comment composer used repeated close
requests to replace an animation completion callback: every close incremented
its local generation and supplied a new callback for target `0`. Suppressing
that duplicate retarget would leave the first callback stale and the closing
view zone mounted.

## Considered approaches

1. **Make Monaco close idempotent (selected).** Track whether the current
   composer is already closing. A repeated Escape or close-button activation
   does nothing, so the original generation and completion callback remain
   valid. Opening another composer clears the closing state and continues to
   interrupt from the animator's current height.
2. **Add a callback-replacement option to `HeightAnimator`.** This would
   preserve the existing caller behavior but complicate a general animation
   primitive for one call site and make identical-target semantics conditional.
3. **Accumulate callbacks for identical targets.** This would avoid losing the
   newest callback, but it would retain stale lifecycle callbacks and make
   completion ownership ambiguous.

## Design

`attachCommenting` owns composer lifecycle. It will track an in-progress close,
ignore duplicate close requests, and clear that state when structure is removed
or a new composer opens. A new open still cancels the previous animation,
increments the lifecycle generation, rebuilds the zone, and animates from the
sampled current height.

`HeightAnimator` owns interpolation lifecycle. Its `reduced` option will accept
either a boolean or a getter. It will remember the target of an active frame
run. An identical active target returns without cancellation, rescheduling, or
callback replacement. A different target cancels the prior run and starts from
the current sampled height. Reduced motion is resolved on retarget and on every
frame; if it becomes active mid-run, the animator snaps to the exact target,
clears active state, and completes that run once.

Monaco will pass `prefersReducedMotion` as a live getter. Its relayout path will
continue positioning the overlay even when the zone height request is
suppressed, keeping scroll positioning independent from height animation.

## Verification

Animator tests will cover duplicate active targets, completed targets,
different-target interruption, live reduced-motion changes, close-direction
snapping, and cancellation. Monaco tests will cover repeated Escape during
close, reopening during close, same-height typing, live reduced motion, and
disposal with no pending frames. Focused tests, web typechecking, and scoped
lint must pass before review.

