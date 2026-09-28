# 0009. Frame the output, so connect can exit with the child's status

## Status

Accepted.

## Context

`connect` relays the child's output as a raw byte stream and exits 0 when
the stream ends, whatever the child returned. An MCP client does not look
at the exit code, but a command-line caller does: `autospawn connect ...
-- ... tool fetch && next-step` runs `next-step` even when `fetch`
failed. docs/limitations.md lists this gap.

The raw stream leaves no room for the status. Any byte the child writes
can appear in it, so no marker at its end can be told apart from output.

Two versions can meet on one socket. A resident keeps running across an
upgrade of autospawn, so a new `connect` can reach an old `serve`, and an
old `connect`, still in a client's config, can reach a new `serve`.

## Decision

Frame the direction from `serve` to `connect`, when both sides support it.

- `connect` adds `"frames": 1` to its attach header. A `serve` that
  supports frames replies `{"ok":true,"frames":1}`, and from then on sends
  frames. A `serve` that does not know the field replies `{"ok":true}`,
  and `connect` falls back to the raw relay. A new `serve` that gets an
  attach without the field relays raw, too.
- A frame is one type byte, a 4-byte big-endian length, and that many
  bytes of payload.
  - Type 1, data: a chunk of the child's stdout.
  - Type 2, exit: a JSON object `{"code":<n|null>,"signal":<name|null>}`,
    sent once, after the child's stdout ends and the child exits. It is the
    last frame.
- The direction from `connect` to `serve` stays a raw stream: it is the
  child's stdin, and its end is the end of the stream.
- `connect` exits with the child's code. A child ended by a signal gives
  128 plus the signal's number, as a shell does, and a command that
  cannot start gives 127. A framed connection that closes before an exit
  frame gives 1, with a message on stderr.

## Consequences

- A command-line caller can rely on `$?`.
- Each chunk of output costs 5 extra bytes.
- `serve`'s own log still receives the child's stderr. Carrying stderr to
  the caller would need a third frame type; this decision leaves it out.
- The raw relay stays, for mixed versions, and has to keep working.

## Rejected alternatives

- **A marker at the end of the raw stream.** Output can contain any byte
  sequence, so escaping would touch every byte, which is framing with more
  steps.
- **The status in a file that connect reads after the stream ends.** It
  adds a file per connection, and a race between the file and the close.
- **A second socket connection for the status.** Two connections per
  client, and a way to pair them.
- **Frames with no negotiation.** A mixed pair would misread each other's
  bytes. The resident outlives an upgrade, so the pair is not rare.
