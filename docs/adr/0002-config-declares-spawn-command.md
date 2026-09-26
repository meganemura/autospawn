# 0002. The client config declares the spawn command

## Status

Accepted.

## Context

`connect` needs to know how to start a resident when none answers. That
command could live in mcp-autospawn's own config file, in an environment
variable, or directly in the argv the client already passes to `connect`.

## Decision

The client's own MCP config is the only place the spawn command lives:
everything after `--` in `mcp-autospawn connect --name <name> -- ...` is
the exact command `connect` runs if it needs to. mcp-autospawn holds no
config file of its own, and knows nothing about `op`, 1Password, or any
other secrets tool that command might invoke.

## Consequences

- Setting up a new server means editing one file (the client's MCP config)
  the same way you would without mcp-autospawn in front of it, plus adding
  `mcp-autospawn connect --name <name> --` at the front.
- mcp-autospawn's own argv fingerprint (ADR 0005) can be computed from
  exactly what the client already passed, with nothing to keep in sync
  elsewhere.
- Two clients pointing at the same `--name` with different commands is a
  detectable inconsistency (a fingerprint mismatch), not silent
  overwriting of one config by another.

## Rejected alternatives

- **A separate mcp-autospawn config file mapping name to command.** Adds a
  second file to edit and keep in sync with the client config that already
  has the command. The client config is the one file that must be correct
  for the client to work at all.
