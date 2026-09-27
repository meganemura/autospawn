# Known limitations

These are gaps in autospawn 0.1 that are known and not fixed yet. None of
them leaks a secret to another user.

## connect does not pass on the child's exit code

`connect` exits 0 when the relay ends, whatever exit code the program
returned. An MCP client does not look at it, but a command-line caller
that checks `$?` cannot tell success from failure. See ADR 0007.

## An inode reused at once can hide a replaced socket

A resident checks every second that its socket path still points at its
own socket, by comparing the device and inode numbers (see "Losing
ownership after binding" in architecture.md). If the socket file is
removed and a new socket at the same path gets the same inode number
straight away, the check does not see the change. The old resident then
keeps running, unreachable, and forever without an idle timeout. With one,
it runs its normal shutdown when the timeout fires, and `server.close()`
deletes the socket file at the path, which now belongs to the new
resident. The new resident's own check then finds its path gone, and it
exits once it has no running children. The next connect starts another
resident, and asks for approval again.
Comparing the file's change time as well would close this gap.

## A connection at the moment of the idle timeout ends the resident

The idle timer starts at startup, and again when the last child closes. A
connection that arrives just before it fires, while `serve` still reads
the connection's header, is served in full: closing the server stops new connections, and
leaves the accepted ones alone. But the resident exits once that
connection ends, where it would otherwise have stayed for another idle
period. The next connect then starts a new resident, and asks for
approval again.

## Renaming a resident leaves the old one running

The name is the only link between a config and its resident. After a
config changes `--name`, nothing connects to the resident under the old
name, and autospawn has no way to know that no config uses it any more.
It keeps running, with its secrets, until `autospawn stop --name <old
name>`, or until its idle timeout.

## No Windows support

autospawn uses Unix domain sockets, POSIX process groups, and file modes.
It runs on macOS and Linux only.
