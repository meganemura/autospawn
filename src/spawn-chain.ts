// Responsibility: the hidden `__spawn` intermediate that connect launches so
// the resident it starts survives connect being killed.
//
// Why this process exists: `detached: true` only protects against a signal
// or kill sent to connect's process group; it does nothing if a host kills
// connect's whole descendant tree by pid (tree-kill, `pkill -P`), which some
// MCP clients do on shutdown or timeout. If that tree-kill reaches the
// resident, every restart re-triggers the 1Password approval this tool
// exists to avoid. This process detaches the real spawn-command from
// connect's process tree, writes its pid, and exits immediately, so nothing
// under connect stays alive for a tree-kill to reach; the chain is
// reparented to launchd (pid 1).
//
// Not done here: waiting for the spawned command to exit, or reporting its
// exit code (connect can no longer observe it once this process exits; it
// infers failure from pid liveness plus a connection attempt instead).
import { spawn } from "node:child_process";
import fs from "node:fs";

export function runSpawnChain(logPath: string, command: readonly string[]): void {
  const [cmd, ...args] = command;
  if (!cmd) {
    process.stderr.write("mcp-autospawn __spawn: empty command\n");
    process.exitCode = 2;
    return;
  }
  const logFd = fs.openSync(logPath, "a", 0o600);
  let child;
  try {
    child = spawn(cmd, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.unref();
  // connect may already be gone (killed while we were starting up); a
  // broken stdout pipe must not crash this process before it can exit.
  process.stdout.on("error", () => {});
  process.stdout.write(`${child.pid}\n`);
}
