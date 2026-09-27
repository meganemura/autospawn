#!/bin/sh
# Run Stryker with three guards that the test suite cannot give itself.
#
# 1. A process limit. The tests start detached residents, and a mutant can
#    turn a bounded spawn into an unbounded one. The limit is the user's
#    current process count plus a margin, so a runaway fails to fork
#    instead of filling the machine.
# 2. A private, short parent directory for the tests' state directories
#    (AUTOSPAWN_TEST_TMP). A test that a mutant stops partway never
#    runs its cleanup, and the directory takes what it leaves behind.
# 3. A final sweep of every process started from Stryker's sandbox. A
#    mutant in serve can break its own idle timeout or its stop handler,
#    and such a resident outlives the run: its parent is launchd, so no
#    test cleanup reaches it.
#
# Extra arguments go to `stryker run`, for example `--mutate src/stop.ts`.

margin=400
limit=$(( $(ps -U "$(id -u)" | wc -l) + margin ))
dir=$(mktemp -d /tmp/mas-run.XXXXXX) || exit 1

(
  ulimit -u "$limit"
  AUTOSPAWN_TEST_TMP="$dir" npx stryker run "$@"
)
code=$?

pkill -TERM -f "$PWD/.stryker-tmp/sandbox-" 2>/dev/null
sleep 2
pkill -KILL -f "$PWD/.stryker-tmp/sandbox-" 2>/dev/null
rm -rf "$dir"
exit "$code"
