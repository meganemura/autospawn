# 0005. The fingerprint covers argv only, and a mismatch never auto-restarts

## Status

Accepted.

## Context

`connect` needs to tell whether the resident it finds was started with the
same command its own client config asks for. The command's argv is one
input to compare; the environment `connect` was itself started with is
another candidate input, since it could in principle be part of "the same
command."

Once a mismatch is detected, there is a further choice: stop the old
resident and start a new one automatically, or refuse and ask a person to
run `stop` themselves.

## Decision

The fingerprint is `sha256(JSON.stringify(argv))` over the command after
`--`, and nothing else. `connect` reports a mismatch (`fingerprint_mismatch`)
and exits 1 with the `stop` command in its stderr; it never stops the
existing resident itself.

## Consequences

- Two clients that add different environment variables to the same
  otherwise-identical command (which is normal: each client adds its own
  variables) fingerprint identically and share one resident.
- Changing an `op://` reference, or any other environment-only change,
  does not change the fingerprint. The README says to run `stop` after such
  a change; the fingerprint by itself cannot detect it.
- A real argv mismatch is surfaced to a person, with the exact command to
  run, rather than resolved silently.

## Rejected alternatives

- **Include environment variables in the fingerprint.** Would make the
  same logical configuration fingerprint differently depending on which
  client started the resident, since each client adds its own environment
  variables that have nothing to do with the command's identity.
- **Auto-restart on mismatch.** If two client configs for the same `--name`
  disagree (one stale, one current), each one's `connect` would keep
  killing and replacing the resident the other one just started, and every
  connection would risk landing on a resident mid-restart.
