# Architecture

## Process shape

A client starts `connect` as a process it manages directly: for example,
Cursor, Claude Code, or Codex starts it as an MCP server, and an agent
starts it as a command-line tool. Everything past `connect` in the diagram below
lives outside the client's process tree once startup finishes.

```
client
  └─ connect ──(spawns, detached)──> __spawn ──(spawns, detached)──> spawn-command
                     (writes pid,          (e.g. op run)
                      exits immediately)         │
                                                  └─ exec's into ──> serve
                                                                       │
                                                        (per connection, spawns)
                                                                       │
                                                                       v
                                                              server-command
                                                             (the real server)
```

`connect` talks to `serve` over a unix domain socket at
`<base>/<name>.sock`. Everything from the second connect onward skips the
spawn chain and goes straight to that socket.

## Why two detached hops, not one

`detached: true` on a spawned child moves it to a new process group, which
protects it from a signal sent to the old group and from SIGHUP. It does
nothing against a kill by pid: a host that tree-kills its MCP server (by
walking `ppid`, as `pkill -P` or a "tree-kill" library does) can still reach
anything still parented under `connect`, including a resident `connect`
just started, if `connect` itself is what spawned it directly.

`__spawn` exists to break that parent chain before the resident has done
anything worth losing. `connect` starts `__spawn`; `__spawn` starts
spawn-command (the real chain, e.g. `op run`) detached, writes its pid to
its own stdout, and exits. From that point, spawn-command's parent is
`__spawn`, which is already gone, so the OS reparents it to pid 1
(launchd on macOS; init, or a subreaper, on Linux).
A tree-kill rooted at `connect` no longer reaches it, because it is no
longer a descendant of `connect` by the time `connect` gets killed.

`connect` reads the pid `__spawn` reported and polls: try to connect; if
that fails, check whether the pid is still alive (`process.kill(pid, 0)`).
A dead pid does not mean failure by itself — the winner of a startup race
(see below) can make its own `serve` exit 0 right as the winning socket
becomes reachable — so `connect` gives one more short window to connect
before it gives up and reports the log path.

## Handshake

Right after a client's `connect` opens the socket, it sends one line of
JSON, then falls silent until `serve` answers with one line of its own:

```
connect -> serve: {"v":1,"op":"attach","fingerprint":"<sha256 of argv>"}\n
serve   -> connect: {"ok":true}\n                                  (or {"ok":false,"error":"...","message":"..."})
```

`serve` reads only up to the first `\n`, at up to 64 KiB and 5 seconds. A
header that never arrives, is not valid JSON, or is too large gets its
connection closed without a reply. Valid JSON that is neither attach nor
stop gets a `bad_header` reply, and an attach with the wrong fingerprint
gets a `fingerprint_mismatch` reply, before the connection closes.

Bytes that arrive after that first `\n` in the same read are put back on
the socket before either side treats the connection as a plain byte
relay, so a client that pipelines its first message right after the
header loses nothing.

`stop --name <name>` uses the same socket with `{"v":1,"op":"stop"}`
instead, and gets `{"ok":true}` before `serve` shuts down.

## The fingerprint

The fingerprint is `sha256(JSON.stringify(argv))` over the command that
follows `--` in `connect`'s own invocation — never environment variables.
`connect` passes it to the resident it starts via
`AUTOSPAWN_FINGERPRINT`; wrappers like `op run` pass environment
through by default, so it reaches `serve` unchanged. Every later `attach`
carries the fingerprint of whatever command that `connect` invocation was
given, and `serve` compares it against the one its own resident started
with.

A mismatch means two different client configs point at the same `--name`
with different commands. `serve` reports `fingerprint_mismatch` and
`connect` exits 1 with the resolution (`stop`, then reconnect) in its
stderr. Nothing here restarts a resident automatically: if config A and
config B disagree, an automatic restart-on-mismatch would have each one
keep tearing down the other's resident.

## The spawn lock

Two `connect` invocations starting at the same instant would otherwise
both find no resident and both start a chain — and for a chain wrapped in
`op run`, both trigger their own 1Password approval, even though only one
resulting `serve` ends up serving anyone. `connect` avoids this with a
lock file, `<base>/<name>.spawn`, created with `O_EXCL` before it spawns
anything. Whichever `connect` creates it is the one that spawns; the rest
poll the socket instead, on the assumption that the holder's chain is on
its way up. See [ADR 0006](adr/0006-spawn-lock.md) for why this has to be
a lock file rather than something built on the socket bind itself (the
short version: the bind happens after the approval, too late to prevent a
second one).

A lock file whose holder never removed it (most likely killed mid-startup,
the case the previous section exists for) is only reclaimed once it is
older than some later connect's own `--timeout` — deliberately: the chain
the holder started can outlive the holder, so a waiter reclaiming too
early risks spawning a second chain while the first is still coming up.

## Startup races

The spawn lock above keeps the common case — several clients starting up
together — down to one spawn. It does not make the bind-level race below
unreachable: a lock reclaimed after its holder died can still spawn a
second chain if the first one actually made it up, and a stale socket file
left by a resident that crashed earlier needs the same handling with no
second `connect` in sight at all. Two `serve` processes that do both try to
bind `<base>/<name>.sock` — for whichever reason — have one winner; the
loser's `listen()` fails with `EADDRINUSE`.

The loser probes the socket:

- Connects successfully → a resident is already up. Log it, exit 0.
- `ECONNREFUSED` → the file is a leftover from a resident that died
  without cleaning up. Unlink it and try `listen()` once more.

## Losing ownership after binding

A narrower race sits inside the `ECONNREFUSED` branch above: two losers can
both get `ECONNREFUSED` on the same stale file, both unlink it, and both
bind. The second bind silently replaces the first's file at that path. The
first (call it B) now holds an open, working socket handle, but the path on
disk belongs to a different resident (C) — and B has no signal that this
happened, since bind and listen already succeeded for B.

Left unnoticed, B keeps running, keeps whatever secret its environment
holds, and (absent `--idle-timeout`) never exits.

`serve` guards against this by recording the socket path's device, inode,
and change time right after it binds and chmods the socket, then checking
that the path still resolves to the same three values, once a second. The
inode alone would not do: Linux can give a socket created right after
another one was removed the same inode number. The change time, in
nanoseconds, tells the two apart. Its cost: a chmod or chown on the socket
after that point also counts as a replacement, and the resident steps
aside. There is no check
on each new connection: clients connect by path, so once the path points
elsewhere, no new client can reach this resident. A mismatch (or the path
being gone) means this resident is no longer the one clients will reach.
It logs that once, marks itself displaced, and exits once it has no
running children.

It exits with `process.exit()` directly, not `server.close()`. Node's
`net.Server.close()` unlinks whatever file currently sits at the path it
bound, and by the time B notices, that file belongs to C. Calling
`close()` here would delete C's socket. `process.exit()` leaves the path
alone, since it was verified that no cleanup call runs for a plain
`process.exit()` on a listening unix socket.

## Lifecycle

- `serve` checks the base directory, binds and starts listening, then
  chmods the socket to 0600.
- Each connection spawns one server-command child; the socket and the
  child's stdio are wired together until either side closes.
- `stop`, SIGTERM, and SIGINT all run the same shutdown: SIGTERM every
  child, then `server.close()` (which unlinks the resident's own socket,
  since it still owns the path at that point), then exit 0.
- With `--idle-timeout`, a timer for that many seconds runs while there is
  no running child and no connection being handled. Accepting a
  connection cancels it. It starts at startup, when the last child closes,
  and when a connection ends without a child (a refused attach, a bad
  header). Firing runs the same shutdown.
- A resident that loses the ownership race above runs a different exit path
  (see the previous section): no `close()`, no unlink, just `process.exit()`
  once it has no running children.
