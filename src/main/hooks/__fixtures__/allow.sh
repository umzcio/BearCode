#!/bin/sh
# PreToolUse fixture: drains stdin, always allows.
cat >/dev/null
echo '{"decision":"allow"}'
