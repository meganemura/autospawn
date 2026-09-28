// Responsibility: listen on the resident's socket, hand each connection its
// own copy of server-command over stdio, and relay bytes between them.
//
// Not done here: opening a log file. The chain that started this process
// (spawn-chain.ts) already redirected its own stdout/stderr to the log file
// descriptor before exec'ing into whatever ends up running this serve
// command (typically a secrets wrapper). If serve opened the log file
// itself, an 1Password-masking wrapper further up the chain would have
// nothing to mask, since its own stdout/stderr redirection is what applies
// the mask. So serve writes its own diagnostics, and the child's stderr,
// to its own stderr, and never touches the log path.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import { childParamEnv, type Params } from "./params.ts";
import { ensureBaseDir } from "./paths.ts";
import {
  encodeLine,
  isAttachHeader,
  isStopHeader,
  readHeaderLine,
  type ErrReply,
} from "./protocol.ts";

function logLine(message: string): void {
  process.stderr.write(`${new Date().toISOString()} [serve] ${message}\n`);
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AUTOSPAWN_")) delete env[key];
  }
  return env;
}

// Identifies the socket file this resident bound. The inode alone is not
// enough: Linux gives a file created right after another one was removed
// the same inode number, so a replaced socket can look like the old one.
// The change time, in nanoseconds, tells them apart. It is read after
// serve's own chmod, so that chmod does not count as a change.
export type Ownership = { dev: bigint; ino: bigint; ctimeNs: bigint };

export function statOwnership(sockPath: string): Ownership | null {
  try {
    const st = fs.statSync(sockPath, { bigint: true });
    return { dev: st.dev, ino: st.ino, ctimeNs: st.ctimeNs };
  } catch {
    return null;
  }
}

export function sameOwnership(a: Ownership, b: Ownership | null): boolean {
  if (b === null) return false;
  // Stryker disable next-line ConditionalExpression: the socket and its
  // replacement live in the same directory, so they share a device and
  // only the inode can differ. dev guards a case no test can build: a
  // filesystem mounted over the state directory between two checks.
  const sameDevice = a.dev === b.dev;
  return sameDevice && a.ino === b.ino && a.ctimeNs === b.ctimeNs;
}

// connect always sets both variables. A serve without one of them was not
// started by connect, so it has no socket to own or no command to match.
function requireEnv(name: string): never {
  process.stderr.write(
    `autospawn serve: ${name} is not set; serve must be ` +
      "started by 'autospawn connect', not run directly\n",
  );
  process.exit(2);
}

export async function serve(
  idleTimeoutSeconds: number | null,
  serverCommand: readonly string[],
  declaredParams: Params = {},
): Promise<never> {
  const sockPath: string = process.env.AUTOSPAWN_SOCKET ?? requireEnv("AUTOSPAWN_SOCKET");
  const fingerprint: string =
    process.env.AUTOSPAWN_FINGERPRINT ?? requireEnv("AUTOSPAWN_FINGERPRINT");
  ensureBaseDir(path.dirname(sockPath));

  const children = new Set<ChildProcess>();
  // Connections accepted whose handling has not finished: still reading the
  // header, or refused and not yet closed. A connection that becomes a child
  // leaves this count when handleConnection returns.
  let pending = 0;
  let raceLost = false;
  let idleTimer: NodeJS.Timeout | null = null;

  const server = net.createServer({ allowHalfOpen: true });

  // Called at startup, when a child closes, and when a connection's handling
  // ends. The timer runs only while nothing is running and nothing is being
  // set up: a client that connects just before the timeout gets its child,
  // and the resident stays.
  function scheduleIdleCheck(): void {
    if (idleTimeoutSeconds === null) return;
    if (children.size > 0 || pending > 0) return;
    idleTimer = setTimeout(() => {
      logLine(`idle for ${idleTimeoutSeconds}s, stopping`);
      void shutdownOwned();
    }, idleTimeoutSeconds * 1000);
  }

  function cancelIdleCheck(): void {
    clearTimeout(idleTimer ?? undefined);
    idleTimer = null;
  }

  function checkOwnership(ownership: Ownership): void {
    if (raceLost) return;
    const current = statOwnership(sockPath);
    if (!sameOwnership(ownership, current)) {
      raceLost = true;
      logLine("lost ownership of the socket path to another resident; draining");
      if (children.size === 0) exitWithoutUnlink();
    }
  }

  function exitWithoutUnlink(): never {
    // The path now belongs to another resident's socket; calling
    // server.close() here would unlink that resident's file (verified: a
    // net.Server unlinks whatever currently sits at its bind path on
    // close(), even if it is no longer this server's own file). Exiting
    // directly leaves the path untouched.
    process.exit(0);
  }

  // A second call (a signal during a stop, say) closes an already closed
  // server; its callback gets an error and exits 0 the same way.
  function shutdownOwned(): Promise<never> {
    for (const child of children) child.kill("SIGTERM");
    return new Promise<never>(() => {
      // Stryker disable next-line ArrowFunction,CallExpression: close()
      // removes the socket file, so without this exit the next ownership
      // check, within a second, finds the path gone and exits 0 the same
      // way. The explicit exit keeps the shutdown readable in one place.
      server.close(() => process.exit(0));
    });
  }

  // No ownership check here: once the path points at another resident, no
  // new connection can reach this server, since clients connect by path.
  server.on("connection", (socket: Socket) => {
    pending += 1;
    cancelIdleCheck();
    // handleConnection settles every error path itself. There is no catch
    // here on purpose: a throw would be a bug, and an unhandled rejection
    // shows it, where dropping the one connection would hide it.
    void handleConnection(socket).finally(() => {
      pending -= 1;
      scheduleIdleCheck();
    });
  });

  async function handleConnection(socket: Socket): Promise<void> {
    let header: unknown;
    try {
      header = await readHeaderLine(socket);
    } catch {
      socket.destroy();
      return;
    }

    if (isStopHeader(header)) {
      await writeLine(socket, { ok: true });
      // Stryker disable next-line CallExpression: without this end, the
      // connection still closes within a second: close() below removes the
      // socket file, and the ownership check then exits the process.
      socket.end();
      await shutdownOwned();
      return;
    }

    if (!isAttachHeader(header)) {
      await writeLine(socket, errReply("bad_header", "expected attach or stop"));
      socket.destroy();
      return;
    }

    if (header.fingerprint !== fingerprint) {
      await writeLine(socket, errReply("fingerprint_mismatch", "spawn command does not match"));
      socket.destroy();
      return;
    }

    const paramEnv = childParamEnv(header.params ?? {}, declaredParams);
    if (!paramEnv.ok) {
      await writeLine(socket, errReply("bad_param", paramEnv.error));
      socket.destroy();
      return;
    }

    await writeLine(socket, { ok: true });
    spawnChild(socket, paramEnv.value);
    // readHeaderLine paused the socket once it found the header line;
    // spawnChild has now attached the relay listeners, so it is safe to
    // let bytes flow again.
    socket.resume();
  }

  function spawnChild(socket: Socket, paramEnv: Readonly<Record<string, string>>): void {
    const [cmd, ...args] = serverCommand;
    // stdio defaults to three pipes. A command that cannot start reports it
    // through the "error" event below, not a throw; spawn throws only for
    // arguments argv cannot carry, such as a NUL byte, and the catch around
    // handleConnection covers that.
    const child = spawn(cmd!, args, { env: { ...childEnv(), ...paramEnv } });
    children.add(child);

    // A command that cannot start emits "error" and then "close"; the close
    // handler below ends the socket.
    child.on("error", (err) => logLine(`server-command error: ${err.message}`));

    child.stdout!.on("data", (chunk: Buffer) => socket.write(chunk));
    child.stderr!.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    // Stryker disable next-line StringLiteral,CallExpression: a write that races the
    // child's exit fails with EPIPE here. No test can place a write inside
    // that window on purpose; without this listener, it would crash serve.
    child.stdin!.on("error", () => {});

    socket.on("data", (chunk: Buffer) => child.stdin!.write(chunk));
    socket.on("end", () => child.stdin!.end());
    // The socket stays half open after the client ends its side, so a child
    // can still answer input it already got. It closes once the child exits
    // (below), or once a write to a client that went away fails: a socket
    // always emits "close" after "error", so the error listener only keeps
    // that failure from crashing the resident.
    socket.on("close", () => child.kill("SIGTERM"));
    socket.on("error", () => {});

    child.on("close", () => {
      children.delete(child);
      socket.end();
      if (raceLost && children.size === 0) {
        exitWithoutUnlink();
        return;
      }
      scheduleIdleCheck();
    });
  }

  function writeLine(socket: Socket, obj: unknown): Promise<void> {
    return new Promise((resolve) => {
      socket.write(encodeLine(obj), () => resolve());
    });
  }

  function errReply(error: string, message: string): ErrReply {
    return { ok: false, error, message };
  }

  await bindListener(server, sockPath);
  fs.chmodSync(sockPath, 0o600);
  const ownership = statOwnership(sockPath);
  // Stryker disable next-line all: the path exists here, because listen and
  // chmodSync just succeeded on it. This only narrows the type.
  if (ownership === null) throw new Error(`socket ${sockPath} vanished right after listen`);
  scheduleIdleCheck();
  setInterval(() => checkOwnership(ownership), 1000);

  const onSignal = () => {
    if (raceLost) exitWithoutUnlink();
    void shutdownOwned();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  return new Promise<never>(() => {});
}

// Binds sockPath, recovering from a stale socket file left by a resident
// that died without cleaning up. If another resident is actually listening,
// logs and exits 0 instead of stealing the path.
function bindListener(server: net.Server, sockPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let unlinkedOnce = false;

    const onError = (err: NodeJS.ErrnoException) => {
      // Stryker disable next-line ConditionalExpression,BlockStatement: any
      // other listen error also fails the probe below (nothing listens on a
      // path that could not be bound), and that path rejects the same err.
      if (err.code !== "EADDRINUSE") {
        reject(err);
        return;
      }
      const probe = net.connect(sockPath);
      probe.once("connect", () => {
        // Stryker disable next-line CallExpression: process.exit below
        // closes the probe with everything else.
        probe.destroy();
        logLine("another resident is already listening; exiting");
        process.exit(0);
      });
      // A socket that fails is destroyed already, so there is no destroy
      // here.
      probe.once("error", (probeErr: NodeJS.ErrnoException) => {
        // Stryker disable next-line ConditionalExpression: retrying once on
        // another probe error, such as the path vanishing in between, does
        // no harm, since unlinkedOnce still bounds it to a single retry.
        const refused = probeErr.code === "ECONNREFUSED";
        if (refused && !unlinkedOnce) {
          unlinkedOnce = true;
          try {
            fs.unlinkSync(sockPath);
          } catch {
            // ignore: someone else may have already cleaned it up
          }
          server.listen(sockPath);
        } else {
          reject(err);
        }
      });
    };

    server.on("error", onError);
    server.once("listening", () => {
      // Stryker disable next-line StringLiteral,CallExpression: no test can make a
      // listening server emit an error, so keeping onError attached after
      // this point has no effect a test can see.
      server.removeListener("error", onError);
      resolve();
    });
    server.listen(sockPath);
  });
}
