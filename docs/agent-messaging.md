# Agent Messaging Transport

This document describes the provider-neutral session storage and Unix-socket
mailbox transport in `src/tim/agent_messaging/`. It does not describe agent
tools, provider sessions, provider adapters, or lifecycle-manager behavior.

The transport gives one trusted session runtime a private namespace and one
mailbox receiver per registered identity. It provides bounded, acknowledged
message delivery for the later lifecycle layer.

## Modules

- `runtime_dir.ts` creates the owner-private temporary root, contained
  `agents` and `sockets` directories, opaque-ID paths, atomic registration
  files, strict reads, and idempotent cleanup.
- `mailbox_protocol.ts` defines the validated request and acknowledgement
  envelopes, stable protocol errors, UTF-8 content limits, and frame encoding.
- `mailbox_framing.ts` decodes bounded JSONL bytes without corrupting
  multibyte UTF-8 characters split across chunks.
- `mailbox_server.ts` implements one Unix receiver, source validation,
  acknowledgement handling, duplicate request replay, and the pending FIFO.
- `mailbox_client.ts` resolves and validates a target snapshot, sends one
  request, waits for its acknowledgement, and maps connection races to stable
  protocol errors.
- `session_runtime.ts` owns registrations and receiver startup order. It
  starts a receiver before publishing its registration and closes receivers
  before removing the runtime root.

The shared identity, name, lifecycle, disposition, and environment contracts
remain in `contracts.ts` and `environment.ts`. The mailbox modules consume
those contracts and do not define provider-specific alternatives.

## Private runtime and registrations

`AgentMessagingRuntimeDirectory.create()` creates a short `fs.mkdtemp()` root
under the platform temporary directory. On Unix, the root and both child
directories use mode `0700`. Registration files use mode `0600`.

Registration and socket filenames contain only opaque agent IDs. Human names
never enter a Unix socket path. Every derived path is checked as a strict
descendant of the exact root created by the runtime. Absolute escapes,
separators in IDs, symlinked components, unexpected entry types, and socket
paths above the conservative Unix limit are rejected.

A registration is published by writing a complete record to a unique temporary
file in `agents`, setting its mode, and atomically renaming it to the derived
`<id>.json` path. The receiver is already listening and its socket has been
validated before the registration becomes visible. A failed write removes its
temporary file and closes its handle. Temporary-name exhaustion reports the
stable runtime-directory error code `temporary_file_exhausted`.

Registration records are discovery metadata. They help a transport client
locate and validate a mailbox, but they are not authoritative lifecycle state.
The session runtime owns active registrations in memory, and its close path is
responsible for stopping receivers before removing registration files, sockets,
and the exact root. Repeated deregistration and close calls are safe.

## JSONL protocol

The mailbox uses protocol version `1`. A frame is one compact JSON object and
one trailing newline. The encoded frame, including that newline, is limited to
512 KiB (`MAX_MAILBOX_FRAME_BYTES`). The limit applies while buffering a
partial line, so an untrusted connection cannot grow parser memory without
bound.

The decoder is byte-oriented and validates UTF-8 across chunk boundaries. It
supports a frame split across chunks, multiple chunks for one character, and
the normal complete-frame path. Empty lines are rejected. A connection that
closes with an incomplete frame is rejected. Invalid UTF-8, invalid JSON,
unsupported protocol versions, unknown fields, invalid identities, wrong
target fields, oversized content, and oversized frames are rejected without
affecting other connections.

Each connection has a strict one-request/one-acknowledgement policy:

1. The client sends exactly one complete `message` request frame.
2. The receiver validates and processes that request once.
3. The receiver sends exactly one correlated `ack` frame.
4. The receiver finishes its write and closes the connection.

Additional frames are rejected. Request IDs are retained in a bounded recent-ID
map. Reusing an ID with the same request fingerprint replays the original
acknowledgement; reusing it for different content returns
`duplicate_message_id`.

## Trusted delivery and dispositions

The wire request contains the protocol version, request ID, source ID and name,
target ID and name, content, and timestamp. The client builds source fields
from a caller-bound trusted identity. A model-facing message input cannot
provide or replace them.

The receiver resolves the source against the active session registrations and
checks the source ID and name before invoking its delivery callback. The target
ID and name must match the receiver that accepted the connection.

The delivery callback returns one of these results:

- `steered`: the active recipient accepted the message for its current turn.
- `started-idle-turn`: the recipient accepted the message to start an idle
  turn.
- `temporarily-unavailable`: immediate provider delivery is not available.

For `temporarily-unavailable`, the receiver stores the validated message in its
per-recipient FIFO and returns `queued` only after the entry is retained. The
FIFO holds at most 100 messages. The 101st message returns `queue_full`; no
older message is evicted or truncated. `drainPending()` removes messages in
send order and releases their queue slots.

Message content is measured with UTF-8 byte length. Exactly 65,536 bytes is
accepted. Larger content is rejected before socket transport or queue
allocation.

## Stable errors and failure channels

Mailbox protocol failures use stable codes including:
`invalid_message`, `message_too_large`, `frame_too_large`, `unknown_source`,
`unknown_target`, `target_not_ready`, `target_stale`, `queue_full`,
`connection_failed`, `ack_timeout`, `invalid_ack`, `runtime_closed`,
`duplicate_message_id`, `unsupported_version`, `invalid_utf8`,
`incomplete_frame`, and `unexpected_frame`.

There are two failure channels. If the receiver can safely recover a valid
request ID, it sends a correlated failure acknowledgement with a stable code.
If no safe ID exists, it closes the connection. The client also reports typed
errors for lookup failures, invalid or stale registration snapshots, refused
connections, premature closes, acknowledgement timeouts, and invalid
acknowledgements. These channels keep malformed input local to one connection
while giving callers prompt, model-convertible results when correlation is
safe.

Missing registrations, malformed or outside-root records, replaced sockets,
refused connections, and a target removed during a send are treated as stale
or connection failures. A send is bound to the exact validated target ID,
registration snapshot, socket path, and socket identity used for that attempt;
the transport does not silently redirect it to a replacement with the same
human name.

## Cleanup and scope

Receiver cleanup first stops acceptance and closes active connections. It then
removes the owned socket. Session cleanup closes all receivers before removing
registrations, child directories, and the exact runtime root. An emergency
cleanup hook provides best-effort removal, while normal callers must await the
session close promise.

This layer does not start provider processes, keep provider sessions alive,
install tools, change prompts, assign lifecycle states, or decide how a
provider steers a turn. It exposes the validated transport callbacks and
handles needed by the later lifecycle and provider plans.
