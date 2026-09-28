# autospawn

[![npm version](https://img.shields.io/npm/v/autospawn?logo=npm)](https://www.npmjs.com/package/autospawn)

Attach-or-spawn launcher for programs that talk over stdin and stdout.
A client starts `autospawn connect`. If a resident is already running,
connect attaches to it. If not, connect starts one, and every later
client shares it.

The resident starts once, through a command you choose, such as a secret
resolver. It then starts your program as a fresh child for each
connection, with the environment it got at that one start, minus
autospawn's own `AUTOSPAWN_*` variables. autospawn
relays bytes and does not read them, so any stdio program works: an MCP
server, a command-line tool, or a long-running watcher.

## Use case: MCP servers with 1Password

Some MCP servers need a secret, such as an API token. A common way to
supply it without writing the plaintext token into a config file is to wrap
the server's launch command in `op run` (the 1Password CLI), which reads
the token from a `op://` reference at start time.

1Password's CLI integration approves that access per terminal session: the
approval expires after 10 minutes of no activity, and after 12 hours at the
latest (per 1Password's own documentation). An MCP client starts its server
as a new process, and 1Password treats that as a new session. Each server
start asks for approval again (Touch ID, on a Mac). Run the same server
from more than one client — Cursor, Claude Code, Codex — and the number of
approvals grows with the number of clients.

With autospawn, `op run` runs once, for the resident. Every client
attaches to that one resident, so approval happens once, at the first
start.

## Install

```sh
npm install -g autospawn
```

autospawn needs Node.js 24.10 or later, and runs on macOS and Linux. It
talks over Unix domain sockets, so it does not run on Windows.

## Example: 1Password

Every example below uses placeholder names. Replace `example`,
`Private/example-api`, and the paths with your own.

### mcp.json (Cursor and similar clients)

```json
{
  "mcpServers": {
    "example": {
      "command": "autospawn",
      "args": [
        "connect", "--name", "example", "--",
        "op", "run", "--",
        "autospawn", "serve", "--",
        "node", "/path/to/server.js"
      ],
      "env": {
        "PATH": "/path/to/bin:/usr/bin:/bin",
        "EXAMPLE_API_URL": "https://api.example.com",
        "EXAMPLE_CLIENT_ID": "op://Private/example-api/client-id",
        "EXAMPLE_CLIENT_SECRET": "op://Private/example-api/client-secret"
      }
    }
  }
}
```

GUI apps such as Cursor do not read your shell's `PATH`. Set `env.PATH` to
include the directories that hold `op`, `node`, and `autospawn`.

### Claude Code

```sh
claude mcp add-json -s user example '{
  "command": "autospawn",
  "args": [
    "connect", "--name", "example", "--",
    "op", "run", "--",
    "autospawn", "serve", "--",
    "node", "/path/to/server.js"
  ],
  "env": {
    "EXAMPLE_API_URL": "https://api.example.com",
    "EXAMPLE_CLIENT_ID": "op://Private/example-api/client-id",
    "EXAMPLE_CLIENT_SECRET": "op://Private/example-api/client-secret"
  }
}'
```

This writes the same shape into `~/.claude.json` that you would write by
hand.

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.example]
command = "autospawn"
args = [
  "connect", "--name", "example", "--",
  "op", "run", "--",
  "autospawn", "serve", "--",
  "node", "/path/to/server.js",
]

[mcp_servers.example.env]
EXAMPLE_API_URL = "https://api.example.com"
EXAMPLE_CLIENT_ID = "op://Private/example-api/client-id"
EXAMPLE_CLIENT_SECRET = "op://Private/example-api/client-secret"
```

With any of these, the first client to start `example` triggers one
1Password approval. Later starts, from the same client or a different one,
attach to the resident and ask for no approval.

If you change the 1Password item, or anything else the running server
depends on, run `autospawn stop --name example` so the next connect
starts a fresh resident with the new values.

If you change the `--name` itself, stop the resident under the old name
too. Nothing connects to it any more, but it keeps running, and it keeps
the secrets it resolved.

## Example: a command-line tool

The same shape works for a program that is not an MCP server. Here, an
agent runs a tool that needs a token, once per task, and 1Password asks
for approval only the first time:

```sh
autospawn connect --name example-cli -- \
  op run -- \
  autospawn serve --idle-timeout 3600 -- \
  example-tool fetch
```

The tool's output arrives on stdout, and `connect` exits with the tool's
exit code, as if you had run `example-tool fetch` directly.
`--idle-timeout` ends the resident after an hour with no connections.

## Commands

### `autospawn connect --name <name> [--timeout <seconds>] [--param <key>=<value>]... -- <command...>`

Attaches to the resident named `<name>`, starting it from `<command...>` if
none answers yet. Relays stdin to the resident and the resident's output to
stdout, byte for byte; all diagnostics go to stderr. `--timeout` (default
120 seconds) bounds how long connect waits for a freshly started resident
to come up — long enough for a person to approve a 1Password prompt.
`--param` sends a value for this connection only; see "Per-connection
values" below.

connect exits with the program's exit code. A program ended by a signal
gives 128 plus the signal's number, and a program that cannot start gives
127, as a shell does. A connection that ends before the program's status
arrives gives 1. A resident started by autospawn 0.1.0 does not send the
status; with one, connect exits 0.

### `autospawn serve [--idle-timeout <seconds>] [--param <key>=<ENV_NAME>]... -- <command...>`

Listens on the resident's socket and starts `<command...>` as a fresh child
for every connection it accepts. Only `connect` starts `serve`; running it
directly fails, since it needs environment variables that `connect` sets.
With `--idle-timeout`, serve exits once it has had no running children,
and no connection being set up, for that many seconds. Without it, serve
runs until stopped. `--param` declares a key that connections may send,
and the environment variable it sets in that connection's child.

### `autospawn stop --name <name>`

Asks the resident named `<name>` to shut down. Exits 0 if it stopped a
resident or found none running, and 1 on an error.

## Per-connection values

Some programs need a value that changes on every call, while the secret
stays the same, such as a topic to watch. Put it in `--param` on
`connect`, not after `--`: everything after `--` is part of the
fingerprint, so a value there would need a resident of its own.

```sh
autospawn connect --name example-events --param topic=proj-a -- \
  op run -- \
  autospawn serve --param topic=EXAMPLE_TOPIC -- \
  example-tool watch
```

`serve --param topic=EXAMPLE_TOPIC` declares the key `topic`, and gives
its value to the child as `EXAMPLE_TOPIC`. Each connection gets its own
child with its own value, and all of them share the one resident, and the
one approval. A value never reaches the child's command line, so a caller
cannot add an option such as `-e` to it.

serve refuses:

- a key it did not declare, with a `bad_param` reply;
- a value with a control character, or longer than 4096 bytes;
- at startup, a declared name that its own environment already holds, or
  that starts with `AUTOSPAWN_`, since a caller could otherwise replace a
  value the config set, such as the URL the program sends its
  credentials to.

The program still has to treat a value as untrusted input.

## Files

autospawn keeps a socket, a log file, and a spawn lock per name, under a
base directory:

- `$AUTOSPAWN_DIR` if set and not empty, otherwise
  `$HOME/.local/state/autospawn`.
- `<base>/<name>.sock`, `<base>/<name>.log`, and `<base>/<name>.spawn`.
  The spawn lock exists while a connect starts a resident. A connect that
  was killed at that moment can leave it behind; the next connect removes
  it once it is older than that connect's `--timeout`.

The base directory is created with mode 0700. If it already exists with
looser permissions, or a different owner, autospawn refuses to use it.

## What identifies a match

connect computes a fingerprint from the argv it was given after `--` (not
from environment variables, since clients add their own). A second connect
with the same `--name` but a different command gets
`fingerprint_mismatch` and exits 1 with a message pointing at `stop`.
autospawn does not restart the resident on your behalf in that case: if
two client configs for the same name disagree, an automatic restart would
have each one keep restarting the other's resident.

Because the fingerprint covers argv only, changing an environment variable
(such as an `op://` reference) does not change the fingerprint. Run `stop`
after such a change, so the next connect starts a resident that picks up
the new value.

## Security properties

Any process running as your user that can reach `<base>/<name>.sock` can
attach to the resident. The resident then starts its configured program
for that process, in an environment that holds the secrets a wrapper like
`op run` resolved. The caller cannot change the program or its arguments,
but it can use the program in the same way you do, and it can choose the
values of the parameters that `serve` declares. The base directory's
permission check keeps other users out; it does not distinguish between
your own processes.

## Design

See [docs/](docs/README.md) for the architecture, the design decisions,
and the known limitations.

## License

MIT

---

[Japanese](README.ja.md)
