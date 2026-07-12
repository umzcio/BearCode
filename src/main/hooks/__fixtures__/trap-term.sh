#!/bin/sh
# PreToolUse fixture: ignores SIGTERM and sleeps well past any test-scale
# timeout -- proves runOne's kill uses SIGKILL (untrappable) rather than
# relying on execFile's default SIGTERM, so a hostile/broken hook can never
# wedge the caller by trapping the "polite" signal.
trap '' TERM
sleep 30
