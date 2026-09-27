# Design decisions

- [0001. Autospawn runs on the client side](adr/0001-client-side-autospawn.md)
- [0002. The client config declares the spawn command](adr/0002-config-declares-spawn-command.md)
- [0003. `serve` is an explicit boundary, not an inferred one](adr/0003-explicit-serve-boundary.md)
- [0004. State lives under `$HOME`, not XDG or `$TMPDIR`](adr/0004-home-based-state-dir.md)
- [0005. The fingerprint covers argv only, and a mismatch never auto-restarts](adr/0005-fingerprint-argv-only.md)
- [0006. A spawn lock file, so only one connect starts the chain](adr/0006-spawn-lock.md)
- [0007. Not limited to MCP, and named autospawn](adr/0007-not-limited-to-mcp.md)
- [0008. Per-connection values travel as declared environment variables](adr/0008-per-connection-params.md)

See [architecture.md](architecture.md) for how these decisions fit together
at runtime.
