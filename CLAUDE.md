# autospawn

This repository is public-facing: commit messages, code comments, and docs
are English. The one entry point for users is `README.md`. Anything past
introductory use goes in `docs/`.

`README.ja.md` is the Japanese translation of `README.md`, one sentence
per line, with code blocks identical to the English ones. Carry every
change to `README.md` into it in the same commit.

Record a new design decision as a new file in `docs/adr/`, following the
existing ADRs' shape (Status / Context / Decision / Consequences / Rejected
alternatives), and add it to `docs/README.md`'s index. Do not edit an
existing ADR's Decision after it ships; add a new one that supersedes it
instead.

Before treating a change as done, run `npm run typecheck && npm test`.

`npm run build` also needs to succeed before a release, but is not required
for every local change. See `docs/releasing.md` for a release.

The tests start detached processes that no test runner timeout can reach.
A bug that makes them start each other runs until the machine has no
processes left; this happened once. `npm test` runs `scripts/test.sh`,
which sets a process limit a little above your current process count.
Never run `node --test` directly; pass a file to `npm test -- <file>`
instead.

Most of the suite's time is waiting on serve's own clock: the ownership
check runs once per second, and `--idle-timeout` counts in seconds.
`test/helpers.ts` sets `AUTOSPAWN_TEST_TIME_UNIT_MS` so serve's second is
200ms in every process a test starts. A test that waits on either one uses
`units(n)`; a long `--idle-timeout` that only bounds a leftover resident is
scaled up by the same factor.

Run mutation testing one file at a time with `npm run mutation -- --tests
"<test files>" --mutate src/<file>.ts --concurrency 3`. `--tests` limits
each mutant's run to the test files that reach that source file; without
it, every mutant runs the whole suite. `scripts/mutation.sh` sets the
process limit and stops leftover sandbox processes at the end, and each
test times out after 10 seconds, so a mutant that hangs serve counts as
killed without waiting for Stryker's own timeout.

Each module in `src/` opens with a comment on its responsibility and what
it deliberately does not do. Comments explain why, not what the code
already says.
