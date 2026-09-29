# 0010. `--arg` puts an enumerated value into the server command's argv

## Status

Accepted.

## Context

Some programs read a value from an argument, not an environment variable,
and have no other way to take it: `<tool> hook '{event}' '--host={host}'`,
called once per event and once per host an agent runs as.

ADR 0008 rejected letting a connection choose an argument at all. A
caller could then choose an argument the config writer never intended.
For a program that ends in `node`, `-e 'console.log(process.env)'` prints
the secret the wrapper resolved. `--config <path>` redirects what a
program reads or writes. That decision still holds for a value with no
other limit on its shape, and a value like that still goes through
`--param`, in the environment.

A value drawn from a short, fixed list is a different, narrower case than
a free-valued `--param`, which already ships. If the config enumerates
`event=session-start,stop` and
`host=claude,cursor,codex`, a connection can only ever produce one of six
command lines. The config writer already named all six, by choosing the
lists. A process that reaches the socket still cannot run a command the
config did not name.

## Decision

`serve --arg <key>=<v1>[,<v2>...]`, repeatable, declares a key and the
values a connection may choose for it. It is part of the fingerprint,
like `--param`'s declaration on `serve`. Only the person who writes the
config chooses the keys and their enumerated values.

- A key matches `--param`'s pattern. The same key cannot be declared by
  both `--arg` and `--param` on one `serve`. Otherwise which side of the
  child it reaches, env or argv, would be unclear.
- Each value must be non-empty. It must pass the same check `--param`
  values pass: no control character, at most 4096 bytes. It must appear
  once in its list.
- In the server command after `--`, `{key}` is replaced with the
  connection's chosen value, for every declared key. `serve` checks two
  things once, at startup, before it binds its socket:
  - a declared `{key}` cannot appear in the command itself (argv[0]).
    Otherwise a connection could pick which program runs, the exact
    argument injection ADR 0008 closed.
  - a declared key must appear somewhere in the rest of the command. One
    that does not is very likely a typo in the config.
- An attach must send every declared `--arg` key, and each value must be
  one of its enumerated list. Either miss gets `bad_param`, the same
  reply a bad `--param` gets.
- The substitution runs once over each argv token. A value that itself
  contains `{` and `}` does not get scanned again for more placeholders.
- `--arg` values never reach the child's environment, and `--param`
  values never reach argv. The two stay on the sides ADR 0008 and this
  decision each cover.

## Consequences

- One resident, and one approval, serves every combination of every
  declared key's values, the same property `--param` already gives
  environment values.
- `{key}` has no escape: a value cannot carry that literal text through
  unchanged. A value with a comma cannot be one of the enumerated values,
  since `,` is the list separator.
- A program still has to treat the chosen value as untrusted input, same
  as any `--param` value.

## Rejected alternatives

- **Any value, refusing one that starts with `-`.** Whether a leading `-`
  is safe depends on the program. A value that reaches a position where
  the program treats it as a subcommand can still change behavior it
  should not.
- **Let the program read the value from an environment variable
  instead.** Works for a program built to look there. Needs a change to
  a program that only reads its own argv, which is the case this decision
  exists for.
- **A wrapper script that turns a connect-time choice into a fixed
  command line.** One script, forwarding its own arguments, could cover
  the six combinations in the example above. It moves the choice out of
  `serve`'s own declaration, though, splitting one decision between the
  script and the hook config it is invoked from.
