# Changelog

## 0.3.0 (2026-09-29)

- `serve --arg key=v1,v2,...` declares a key and the values a connection
  may choose for it. The chosen value replaces `{key}` in the server
  command. Unlike `--param`, it never sets an environment variable. See
  ADR 0010.

## 0.2.0 (2026-09-28)

- serve closes a connection that ends its side before sending a header at
  once. It used to wait out the 5-second header timeout.
- connect exits with the program's exit code, 128 plus a signal's number,
  or 127 for a command that cannot start. serve frames the program's
  output so the status can follow it, when both sides support it. See
  ADR 0009.
- `connect --param key=value` sends a value for one connection, and
  `serve --param key=ENV_NAME` declares which keys it accepts and the
  variable each one sets in the child. Connections with different values
  share one resident. See ADR 0008.
- Accepting a connection now cancels the idle timer. A client that
  connected just before the timeout used to get its child, but the
  resident then exited, and the next client had to start a new one.
- A resident now also compares its socket's change time when it checks
  that the path is still its own. On Linux, a replaced socket could get
  the old inode number, and the resident did not see the replacement. A
  chmod on the socket now makes the resident step aside.
- `npm test` runs the suite under a process limit, through `scripts/test.sh`.
- Publishing moves to GitHub Actions with an npm Trusted Publisher. See
  `docs/releasing.md`.

## 0.1.0 (2026-09-27)

First release.

- `autospawn connect`, `serve`, and `stop`: attach to a resident over a
  Unix domain socket, or start one through a command you choose, such as
  `op run`. The resident starts your program as a fresh child for each
  connection, with the environment it got at its one start.
- A double fork keeps the resident alive when a client kills its process
  tree.
- A spawn lock keeps clients that start together from starting two
  residents.
- A fingerprint of the configured command catches two configs that share
  a name but disagree.
- Known gaps are listed in `docs/limitations.md`.
