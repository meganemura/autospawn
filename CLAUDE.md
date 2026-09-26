# mcp-autospawn

This repository is public-facing: commit messages, code comments, and docs
are English. The one entry point for users is `README.md`. Anything past
introductory use goes in `docs/`.

Record a new design decision as a new file in `docs/adr/`, following the
existing ADRs' shape (Status / Context / Decision / Consequences / Rejected
alternatives), and add it to `docs/README.md`'s index. Do not edit an
existing ADR's Decision after it ships; add a new one that supersedes it
instead.

Before treating a change as done, run:

```sh
npm run typecheck && npm test
```

`npm run build` also needs to succeed before a release, but is not required
for every local change.

Each module in `src/` opens with a comment on its responsibility and what
it deliberately does not do. Comments explain why, not what the code
already says.
