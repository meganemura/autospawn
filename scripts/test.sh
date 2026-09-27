#!/bin/sh
# Run the test suite under a process limit.
#
# The tests start detached processes that no test runner timeout can
# reach. A bug that makes them start each other once ran until the machine
# had no processes left. The limit is the user's current process count
# plus a margin, so such a bug fails to fork instead.
#
# Extra arguments go to `node --test`, for example a single test file.

margin=200
limit=$(( $(ps -U "$(id -u)" | wc -l) + margin ))
# A hard limit below this value is already stricter, so keep going.
ulimit -u "$limit" 2>/dev/null || true
exec node --test "$@"
