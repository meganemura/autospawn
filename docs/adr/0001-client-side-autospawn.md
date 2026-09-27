# 0001. Autospawn runs on the client side

## Status

Accepted.

## Context

A resident process needs to exist before any MCP client can attach to it.
Something has to start it the first time. Candidates: a background service
managed outside any client (launchd, systemd, a manually run daemon), or
logic built into the launcher each client already runs as its MCP server
process.

## Decision

`connect` starts the resident itself, the first time it cannot reach one,
using the exact command its own client config gives it. No separate daemon
manager, no install step beyond putting `autospawn` on `PATH`.

## Consequences

- Works with any MCP client that can run an arbitrary command as its
  server, with no client-specific integration.
- The first client to start after a machine reboot pays the one-time
  startup cost (and the one 1Password approval); every client after that
  attaches to what it started.
- No launchd/systemd unit to install, update, or debug.
- autospawn depends on nothing keeping the resident alive across a
  reboot; after a reboot, the next `connect` starts a fresh one.

## Rejected alternatives

- **A user-level launchd/systemd unit, started once at login.** Needs a
  per-name unit file generated and installed, one more thing to keep in
  sync with the client config's own copy of the same command. Left out of
  this version; revisit if the one-approval cold start ever becomes a real
  cost.
