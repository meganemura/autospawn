# 0003. `serve` is an explicit boundary, not an inferred one

## Status

Accepted.

## Context

Somewhere in the command line `autospawn connect --name x -- op run --
autospawn serve -- node server.js`, one point marks where the resident
side (`serve`, receiving connections and spawning server-command per
connection) takes over from the plain wrapper chain (`op run`, resolving
secrets and exec'ing onward). That point could be found by convention — for
example, treating the last `--` in the whole argv as the boundary and
inserting `serve` there automatically — or written explicitly by whoever
sets up the config.

## Decision

Whoever writes the config writes `autospawn serve --` explicitly, at
the point in the chain where the real MCP server should run. `connect`
never inspects or rewrites the command it is given to find that point.

## Consequences

- The chain a person reads in their config is the chain that actually
  runs; there is no implicit insertion to keep in mind while reading it.
- A wrapper chain with more than one `--` (for example, a wrapper that
  itself takes `-- <its own args> --`) has no ambiguity to resolve, because
  nothing is inferring a position from `--` at all.
- Setting up a new server requires knowing to write `serve` at the right
  spot; this is one thing to learn once, documented in the README's
  example.

## Rejected alternatives

- **Infer the boundary from the last `--`.** Breaks as soon as any
  wrapper in the chain takes its own `--`-delimited arguments, since "last"
  stops meaning "the one before the real server." Also hides the one
  command that most needs to be visible (where the resident side starts)
  behind a convention the person configuring the client cannot see in their
  own file.
