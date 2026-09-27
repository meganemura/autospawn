# 0007. Not limited to MCP, and named autospawn

## Status

Accepted. The tool was first named `mcp-autospawn`, with the environment
prefix `MCP_AUTOSPAWN_` and the state directory
`~/.local/state/mcp-autospawn`. None of them shipped under that name.

## Context

The first use was MCP servers: a server wrapped in `op run` asked for a
1Password approval each time a client started it. But nothing in the
implementation depends on MCP. `connect` and `serve` relay bytes and never
parse them, and the only rule about stdout, that `connect` writes nothing
but the relay there, holds for any stdio program.

A second use appeared before the first release: a command-line tool that
an agent runs once per task, with a token that `op run` resolves. It needs
the same thing: resolve the secret once, then start the program per
connection.

## Decision

Name the tool `autospawn`. The command is `autospawn`, the environment
prefix is `AUTOSPAWN_`, and the state directory is
`~/.local/state/autospawn`. The README describes a launcher for stdio
programs, and uses MCP servers with 1Password as its main use case.

## Consequences

- A user of a non-MCP tool can find it, and can trust that relaying stays
  byte for byte, since that is now part of the stated scope.
- The name no longer tells an MCP user that the tool is for them. The
  README's use case section carries that instead.
- `connect` exits 0 when the relay ends. It does not pass on the child's
  exit code. An MCP client does not care, but a command-line caller can.
  This is a known gap, and a later change can add it.

## Rejected alternatives

- **Keep `mcp-autospawn` and add a note that other programs work.** The
  name would keep telling other users the opposite of the note.
- **`stdio-autospawn`.** More exact, but longer, and "stdio" adds little:
  a launcher that relays a process is a stdio launcher already.
