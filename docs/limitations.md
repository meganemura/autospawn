# Known limitations

These are gaps in autospawn 0.1 that are known and not fixed yet. None of
them leaks a secret to another user.

## connect does not pass on the child's exit code

`connect` exits 0 when the relay ends, whatever exit code the program
returned. An MCP client does not look at it, but a command-line caller
that checks `$?` cannot tell success from failure. See ADR 0007.

## A child that ignores the end of its input can outlive its client

serve keeps each connection half open after the client ends its side, so
a program can still answer input it already got: `connect` ends its
side when its own stdin ends, and then waits for the rest of the output.
serve cannot tell that half close from a client that went away. It stops
the child when the child's next write to the gone client fails, or when
the child exits. A program that neither exits at the end of its input nor
writes anything keeps running until it does one of the two. An MCP server
over stdio exits at the end of its input.

## Renaming a resident leaves the old one running

The name is the only link between a config and its resident. After a
config changes `--name`, nothing connects to the resident under the old
name, and autospawn has no way to know that no config uses it any more.
It keeps running, with its secrets, until `autospawn stop --name <old
name>`, or until its idle timeout.

## No Windows support

autospawn uses Unix domain sockets, POSIX process groups, and file modes.
It runs on macOS and Linux only.
