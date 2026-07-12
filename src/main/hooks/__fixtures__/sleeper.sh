#!/bin/sh
# PreToolUse fixture: outlives any test-scale timeout, would deny if it ever
# finished -- proves a timed-out hook fails OPEN (never lets its stale output
# through).
sleep 5
echo '{"decision":"deny","reason":"too late"}'
