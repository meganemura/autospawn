# mcp-autospawn

This repository is public-facing: commit messages, code comments, and docs
are English. The one entry point for users is `README.md`. Anything past
introductory use goes in `docs/`.

Record a new design decision as a new file in `docs/adr/`, following the
existing ADRs' shape (Status / Context / Decision / Consequences / Rejected
alternatives), and add it to `docs/README.md`'s index. Do not edit an
existing ADR's Decision after it ships; add a new one that supersedes it
instead.

Before treating a change as done, run `npm run typecheck`, then the tests
under a process limit, as shown below.

`npm run build` also needs to succeed before a release, but is not required
for every local change.

The tests start detached processes that no test runner timeout can reach.
A bug that makes them start each other runs until the machine has no
processes left; this happened once. Run the tests under a process limit,
set a little above your current process count:

```sh
(ulimit -u $(( $(ps -U "$(id -u)" | wc -l) + 200 )); npm test)
```

Run mutation testing one file at a time with `npm run mutation -- --mutate
src/<file>.ts --concurrency 2`. `scripts/mutation.sh` sets the process
limit and stops leftover sandbox processes at the end.

Each module in `src/` opens with a comment on its responsibility and what
it deliberately does not do. Comments explain why, not what the code
already says.
