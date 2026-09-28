# 0008. Per-connection values travel as declared environment variables

## Status

Accepted.

## Context

Some programs need a value that changes on every call, while the secret
stays the same. The first case: an event tool that an agent runs as
`<tool> wait` with a topic, once per task, and several agents with
different topics share one secret.

ADR 0005 makes the fingerprint cover everything after `--`. A value that
changes per call cannot go there: each call would get
`fingerprint_mismatch`, or would need its own `--name`, and so its own
resident and its own approval.

The obvious form, extra arguments that `connect` sends and `serve` appends
to the server command, changes what the socket gives away. Today a
process that can reach the socket can only run the configured command,
with the configured arguments, in an environment that holds the secret.
With appended arguments, it could choose them. If the command ends in
`node` or `sh -c`, `-e 'console.log(process.env)'` reads the secret out.
An option such as `--config <path>` or `--output <path>` redirects what
the program reads or writes. The 1Password approval covered one start of
one command, and appended arguments would stretch it to any command line
that any process of the user builds later.

## Decision

A per-connection value is a named parameter, and it reaches the child
only as an environment variable, under a name the config declares.

- `connect --param <key>=<value>`, repeatable, before `--`. It is not part
  of the fingerprint.
- `serve --param <key>=<ENV_NAME>`, repeatable, after the `serve` in the
  spawn command, so it is part of the fingerprint. Only the person who
  writes the config chooses which keys exist and which variables they
  set.
- `connect` sends the values in the attach header. `serve` starts each
  child with its own environment plus the declared variables for that
  connection. Two connections with different values get two children with
  different values; the resident's own environment does not change.
- `serve` refuses to start when a declared `ENV_NAME` is already set in
  its own environment, or starts with `AUTOSPAWN_`. Otherwise a caller
  could replace a value that the config or the wrapper put there, for
  example the URL that the program sends its credentials to.
- A key that `serve` did not declare is refused, with the attach failing.
- A value that holds a control character (0x00 to 0x1F, or 0x7F), or is
  longer than 4096 bytes, is refused. A newline in a value can forge a log
  line when the program prints it. `connect` checks this for a clear
  error, and `serve` checks it again, since anything can reach the socket
  without `connect`.
- Keys match `^[a-z][a-z0-9_-]{0,31}$`. Declared names match
  `^[A-Za-z_][A-Za-z0-9_]*$`.

## Consequences

- One resident, and one approval, serves every value of a parameter.
- A program has to read the value from its environment. It does not need
  to know about autospawn, since the config picks the variable name.
- A key declared but not sent leaves the variable unset. The program
  decides what that means.
- The program still has to treat the value as untrusted data: autospawn
  checks its shape, not its meaning.

## Rejected alternatives

- **Append arguments, allowed only with `serve --allow-args`.** Simple,
  but it leaves the argument injection to the judgment of whoever writes
  the config, one command at a time.
- **Append arguments that match a pattern declared on `serve`.** Narrower,
  but a pattern that is safe for one program is not safe for another, and
  writing it correctly is its own task.
- **A fixed variable name, such as `AUTOSPAWN_PARAM_<KEY>`.** Safe, but the
  program would need to know about autospawn.
- **No parameters; the program reads the value from its first stdin line.**
  Works today, but only for a program built for it.
