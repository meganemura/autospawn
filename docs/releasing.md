# Releasing

A release is three things: the npm package, a git tag, and a GitHub
release. autospawn stays on 0.x versions for now.

Version 0.1.0 was published by hand, before the workflow existed. From
0.2.0 on, pushing a `v*` tag runs
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml). The
workflow installs the tagged commit, builds, runs the type check and the
tests, and runs `npm publish`. npm authenticates with GitHub Actions OIDC
through a Trusted Publisher, so the repository stores no npm token. The
GitHub Environment `publish` is the human gate: the job waits there until
someone approves it.

Every `uses:` in a workflow is a full-length 40-hex commit SHA, with the
version in a trailing comment.

## Trusted publisher

The fields are case-sensitive:

- User: `meganemura`
- Repository: `autospawn`
- Workflow filename: `publish.yml`
- Environment name: `publish`
- Allowed action: `npm publish`

With the npm CLI:

```sh
npm trust github autospawn --file publish.yml --repo meganemura/autospawn --env publish --allow-publish
```

`package.json` `repository.url` points at
`https://github.com/meganemura/autospawn.git`. npm checks it against the
repository that runs the workflow.

## Each version

1. Move the `(unreleased)` entry of `CHANGELOG.md` to the version and the
   date. Set the same version in `package.json`.
2. `npm run typecheck && npm test`.
3. `npm pack --dry-run`, and read the file list: `dist/`, the READMEs, the
   license, and `package.json`, and nothing from `src/`, `test/`, or
   `docs/`.
4. Commit as `chore: release 0.x.0`. Tag `v0.x.0`; the tag without the
   leading `v` must equal the `package.json` version, or the workflow
   stops. Push the commit and the tag.
5. Approve the `publish` environment on that Actions run.
6. Extract the version's section of `CHANGELOG.md`, and create the
   release from it:

   ```sh
   awk '/^## 0.x.0/{f=1;next} /^## /{f=0} f' CHANGELOG.md > notes.md
   gh release create v0.x.0 --title v0.x.0 --notes-file notes.md
   ```
