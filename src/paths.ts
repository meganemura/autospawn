// Responsibility: decide where state (socket, log) lives, and refuse to use a
// base directory that another user could have redirected.
//
// Not done here: creating the socket or log file themselves (net/fs callers
// do that); reading MCP_AUTOSPAWN_SOCKET (connect and serve each read it from
// their own environment, at the point where they need it).
//
// Why HOME and not XDG_RUNTIME_DIR/XDG_STATE_HOME/TMPDIR: some MCP clients
// strip most environment variables before they start a server, so a location
// that depends on one of those variables would put each client's server in a
// different place, defeating the sharing this tool exists for. HOME is
// passed through everywhere observed so far.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

// macOS caps struct sockaddr_un.sun_path at 104 bytes including the
// terminating NUL, so 103 usable bytes.
const MAX_SOCKET_PATH_BYTES = 103;

export class PathError extends Error {}

export function baseDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MCP_AUTOSPAWN_DIR;
  // An empty MCP_AUTOSPAWN_DIR counts as unset, the same as a missing one.
  if (override) return override;
  const home = env.HOME ?? os.homedir();
  return path.join(home, ".local", "state", "mcp-autospawn");
}

export function validateName(name: string): void {
  if (!NAME_PATTERN.test(name) || name.startsWith(".")) {
    throw new PathError(
      `invalid --name '${name}': must match ${NAME_PATTERN} and not start with '.'`,
    );
  }
}

function checkPathLength(p: string, label: string): void {
  // Stryker disable next-line StringLiteral: Buffer.byteLength falls back
  // to utf8 for any unrecognized encoding name, the same as Buffer.from
  // (measured), so emptying this string has no observable effect.
  if (Buffer.byteLength(p, "utf8") > MAX_SOCKET_PATH_BYTES) {
    throw new PathError(
      `${label} path is too long for a unix socket (${p}). ` +
        "Set MCP_AUTOSPAWN_DIR to a shorter directory.",
    );
  }
}

export function socketPath(dir: string, name: string): string {
  const p = path.join(dir, `${name}.sock`);
  checkPathLength(p, "socket");
  return p;
}

export function logPath(dir: string, name: string): string {
  return path.join(dir, `${name}.log`);
}

// Not length-checked like socketPath: it never becomes a unix socket
// address, so the sun_path limit does not apply to it.
export function spawnLockPath(dir: string, name: string): string {
  return path.join(dir, `${name}.spawn`);
}

// Ensures the base directory exists with mode 0700, owned by the current
// user. If it already exists but is group- or world-accessible, or owned by
// someone else, refuses: a client never sends secrets over this socket, but
// it does send its MCP traffic. Someone who can redirect this directory (or
// pre-create it) could get a client to connect to a socket they control and
// answer as the MCP server in the resident's place.
export function ensureBaseDir(dir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Stryker disable next-line CallExpression: mkdirSync's own mode
      // above already determines the result exactly for 0o700, since a
      // umask can only clear bits and 0o700 has none set outside the
      // owner -- this chmodSync is a hardening measure against a
      // pathological umask (one that also clears owner bits), not
      // reachable behavior a normal-umask test environment can exercise.
      fs.chmodSync(dir, 0o700);
      return;
    }
    throw err;
  }
  // Stryker disable all: exercising any mutant of this whole check (the
  // condition, or what its body does) needs a directory owned by a
  // different real uid than the test process's own, which needs a
  // second real user account -- not available in this sandbox.
  if (stat.uid !== process.getuid!()) {
    throw new PathError(
      `${dir} is not owned by the current user; refusing to use it`,
    );
  }
  // Stryker restore all
  if ((stat.mode & 0o077) !== 0) {
    throw new PathError(
      `${dir} is accessible to group or other (mode ${(stat.mode & 0o777).toString(8)}); ` +
        `run 'chmod 700 ${dir}' before retrying`,
    );
  }
}
