# 0006. A spawn lock file, so only one connect starts the chain

## Status

Accepted.

## Context

Two `connect` invocations can start at the same time (two MCP clients
starting up together, for example) and both find no resident yet. Without
anything to coordinate them, both would spawn their own chain. Only one
resulting `serve` keeps the socket; the ownership check (see
"Losing ownership after binding" in architecture.md) already
makes the loser step aside safely. But by the time that happens, both
chains already ran spawn-command — which, for a chain wrapped in `op run`,
means both already triggered their own 1Password approval. The second
approval is wasted on a resident that never serves anyone, and it defeats
the reason this tool exists: one approval, shared by every client.

The socket bind itself cannot be what coordinates this. `serve` binds after
spawn-command has already run (spawn-command is everything up to and
including `serve` in the chain: `op run`, or whatever wraps it, resolves
its secret and approval before it execs into `serve`). By the time a bind
exists to race on, any second approval prompt has already been shown.

## Decision

Before starting a chain, `connect` tries to create
`<base>/<name>.spawn` with `wx` (`O_EXCL`), mode 0600, holding its own pid.
Success makes it the holder: it spawns the chain, polls the socket, and
removes the lock file once the socket answers or once it gives up.
Failure with `EEXIST` makes it a waiter: it does not spawn anything, and
instead polls the socket until its own `--timeout` deadline, on the
assumption that whoever holds the lock is already starting one.

A lock file older than the connect's own `--timeout` is treated as stale
(its holder is gone without cleaning up, most likely killed before it
could remove it) and reclaimed: unlink it, then try to create it again,
once.

## Consequences

- Two connects racing at the same instant produce exactly one spawn of the
  chain, and exactly one approval prompt, regardless of how the ownership
  race between the two resulting `serve` processes eventually resolves.
- A `connect` that gets killed while holding the lock (the case the double
  fork exists for) leaves the lock file behind. This is intended, not a leak to
  fix: the chain it started survives the kill (that is the whole point of
  the detached double fork), so a waiter that reclaimed the lock too early
  would risk starting a second chain while the first is still coming up.
  The lock only clears once it is older than some connect's own timeout,
  by which point the original attempt has already failed by any measure.
- A waiter that never sees the socket answer still has its own `--timeout`
  as a bound; it does not wait forever on a holder that is never coming
  back.

## Rejected alternatives

- **Coordinate on the socket bind alone (serve's `EADDRINUSE` /
  `ECONNREFUSED` handling).** That mechanism still runs, and still matters,
  for double-spawns that already happened; it says nothing about the
  approval prompt that already fired by the time a bind exists.
- **A lock keyed on the spawn-command's pid, checked with
  `process.kill(pid, 0)`.** The chain that pid belongs to is deliberately
  detached from `connect` (see "Why two detached hops, not one" in
  architecture.md), so a waiter has no
  descendant relationship to that pid to make watching it meaningful, and
  the pid could be recycled by the time a waiter checks it. Age of the
  lock file, compared against the waiting connect's own `--timeout`, is
  the signal that survives the holder's death.
