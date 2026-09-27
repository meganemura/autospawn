# 0004. State lives under `$HOME`, not XDG or `$TMPDIR`

## Status

Accepted.

## Context

The socket and log file need a directory. Common choices on macOS and
Linux are `$XDG_RUNTIME_DIR` (session-scoped, often tmpfs),
`$XDG_STATE_HOME`, `$TMPDIR`, or a fixed path under `$HOME`. Several MCP
clients (Codex, by default) start the server process with a reduced
environment, and do not pass most variables through.

## Decision

The base directory is `$AUTOSPAWN_DIR` if set, otherwise
`$HOME/.local/state/autospawn`. None of `XDG_RUNTIME_DIR`,
`XDG_STATE_HOME`, or `TMPDIR` are consulted.

## Consequences

- Every client that can start a process at all can find the same
  directory, since `$HOME` is the variable seen passed through in every
  client environment.
- Two clients with a reduced environment and no `$HOME` override land in
  the same place, which is the whole point of a shared resident.
- `AUTOSPAWN_DIR` remains available for a person who wants a different
  location (a shorter path, to fit the unix socket length limit, or a
  separate location for testing).

## Rejected alternatives

- **`$XDG_RUNTIME_DIR`.** Not observed in a reduced client environment; a
  client that strips it would silently get a different socket than one
  that has it, defeating the sharing this tool exists for.
- **`$TMPDIR`.** Same problem, and additionally cleared by the OS on
  reboot on some systems, which is a difference in behavior a person
  configuring this tool should not need to reason about.
