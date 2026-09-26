# mcp-autospawn

Attach-or-spawn launcher for stdio MCP servers. A client starts
`mcp-autospawn connect`. If a resident is already running, connect attaches
to it. If not, connect starts one and every later client shares it.

## Background: why this exists

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

mcp-autospawn starts one resident process with the secret already resolved,
and every client attaches to that one resident. Approval happens once, at
the first start.

## Install

```sh
npm install -g mcp-autospawn
```

## Example: 1Password

Every example below uses placeholder names. Replace `example`,
`Private/example-api`, and the paths with your own.

### mcp.json (Cursor and similar clients)

```json
{
  "mcpServers": {
    "example": {
      "command": "mcp-autospawn",
      "args": [
        "connect", "--name", "example", "--",
        "op", "run", "--",
        "mcp-autospawn", "serve", "--",
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
include the directories that hold `op`, `node`, and `mcp-autospawn`.

### Claude Code

```sh
claude mcp add-json -s user example '{
  "command": "mcp-autospawn",
  "args": [
    "connect", "--name", "example", "--",
    "op", "run", "--",
    "mcp-autospawn", "serve", "--",
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
command = "mcp-autospawn"
args = [
  "connect", "--name", "example", "--",
  "op", "run", "--",
  "mcp-autospawn", "serve", "--",
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
depends on, run `mcp-autospawn stop --name example` so the next connect
starts a fresh resident with the new values.

## Commands

### `mcp-autospawn connect --name <name> [--timeout <seconds>] -- <command...>`

Attaches to the resident named `<name>`, starting it from `<command...>` if
none answers yet. Relays stdin to the resident and the resident's output to
stdout, byte for byte; all diagnostics go to stderr. `--timeout` (default
120 seconds) bounds how long connect waits for a freshly started resident
to come up — long enough for a person to approve a 1Password prompt.

### `mcp-autospawn serve [--idle-timeout <seconds>] -- <command...>`

Listens on the resident's socket and starts `<command...>` as a fresh child
for every connection it accepts. Only `connect` starts `serve`; running it
directly fails, since it needs environment variables that `connect` sets.
With `--idle-timeout`, serve exits once it has had zero connections for
that many seconds. Without it, serve runs until stopped.

### `mcp-autospawn stop --name <name>`

Asks the resident named `<name>` to shut down. Exits 0 whether or not one
was running.

## Files

mcp-autospawn keeps a socket and a log file per name, under a base
directory:

- `$MCP_AUTOSPAWN_DIR` if set, otherwise `$HOME/.local/state/mcp-autospawn`.
- `<base>/<name>.sock`, `<base>/<name>.log`.

The base directory is created with mode 0700. If it already exists with
looser permissions, or a different owner, mcp-autospawn refuses to use it.

## What identifies a match

connect computes a fingerprint from the argv it was given after `--` (not
from environment variables, since clients add their own). A second connect
with the same `--name` but a different command gets
`fingerprint_mismatch` and exits 1 with a message pointing at `stop`.
mcp-autospawn does not restart the resident on your behalf in that case: if
two client configs for the same name disagree, an automatic restart would
have each one keep restarting the other's resident.

Because the fingerprint covers argv only, changing an environment variable
(such as an `op://` reference) does not change the fingerprint. Run `stop`
after such a change, so the next connect starts a resident that picks up
the new value.

## Security properties

Any process running as your user that can reach `<base>/<name>.sock` can
attach to the resident and use whatever the resident's environment can do —
including the secrets a wrapper like `op run` resolved into it. The base
directory's permission check keeps other users out; it does not
distinguish between your own processes.
