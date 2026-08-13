# Agent Messaging

This document describes the provider-neutral agent-messaging contracts and the
session storage and Unix-socket mailbox transport in
`src/tim/agent_messaging/`. It does not describe provider sessions, provider
adapters, or lifecycle-manager behavior. The reusable one-shot preparation and
launch service a later lifecycle manager will build on is documented in
[subagent-launch-service.md](subagent-launch-service.md).

The shared contracts let an orchestrator address, message, and later stop its
subagents. The transport gives one trusted session runtime a private namespace
and one mailbox receiver per registered identity. It provides bounded,
acknowledged message delivery for the later lifecycle layer.

The contracts and environment helpers are the single source of truth for names,
limits, identity, and lifecycle vocabulary. The transport consumes those
contracts and does not define provider-specific alternatives.

Relevant code:

- `src/tim/agent_messaging/contracts.ts` — provider-neutral constants, enums,
  Zod schemas, inferred types, and lifecycle classification helpers.
- `src/tim/agent_messaging/environment.ts` — internal per-process identity
  variables, the identity union, and pure read/write helpers.
- `src/tim/agent_messaging/runtime_dir.ts` — private session directories,
  registrations, path validation, and cleanup.
- `src/tim/agent_messaging/mailbox_protocol.ts` — mailbox envelopes, limits,
  errors, and JSONL frame encoding.

## The experimental flag

`experimental.agentMessaging` is an optional boolean with **no schema default**.
The canonical enabled check is exact:

```ts
const agentMessagingEnabled = config.experimental?.agentMessaging === true;
```

`mergeConfigs()` merges `experimental` as a nested object, so a local layer can
override `agentMessaging` without dropping unrelated experimental keys.

`src/tim/commands/agent/agent.ts` takes **one** snapshot of the resolved
boolean per root session and puts it in
`ExecutorCommonOptions.agentMessagingEnabled`
(`src/tim/executors/types.ts`). Both orchestration entry points forward it into
`OrchestrationOptions` (`src/tim/executors/shared/orchestration_options.ts`):
`claude_code.ts` and `codex_cli/orchestrator_mode.ts`. The transport itself
does not reread configuration. A running session therefore cannot change mode
mid-run.

## Contract vocabulary

Keep these words distinct; they are not interchangeable.

| Term    | Meaning                                           |
| ------- | ------------------------------------------------- |
| `name`  | Model-facing address used by the tools            |
| `id`    | Opaque runtime identity                           |
| `type`  | Work role of a subagent                           |
| `role`  | Authorization class: `orchestrator` or `subagent` |
| `state` | Lifecycle state                                   |

- Agent types: `implementer`, `tester`, `tdd-tests`, `reviewer`. The
  orchestrator is **not** a fifth type — it is a role.
- Executors: `claude-code`, `codex-cli`.
- Lifecycle states: nonterminal `starting`, `running-active`, `running-idle`,
  `finishing`, `stopping`; terminal `exited`, `failed`. Use
  `isNonterminalAgentLifecycleState()` /
  `isTerminalAgentLifecycleState()` for classification.
- Send acknowledgements: `steered`, `queued`, `started-idle-turn`.
- Stop acknowledgements: `graceful-requested`, `forced`, `already-stopping`.

### Names

An agent name is 1 to 48 characters of lowercase ASCII letters, digits, and
hyphens, with alphanumeric first and last characters. Consecutive hyphens are
allowed. Comparison is exact and case-sensitive: uppercase input is invalid,
and validation never lowercases or trims silently.

Two schemas share the grammar:

- `agentAddressSchema` — any target, including the reserved `orchestrator`
  address. Used by `SendAgentMessage`.
- `agentNameSchema` — rejects `orchestrator`. Used where a custom subagent
  name is required.

Default `<type>-<short-slug>` name generation and collision reservation belong
to the lifecycle layer. Filesystem objects use opaque IDs, not these names.

### Limits

| Constant                             | Value  | Meaning                                |
| ------------------------------------ | ------ | -------------------------------------- |
| `MAX_AGENT_NAME_LENGTH`              | 48     | Name characters                        |
| `MAX_SUBAGENTS_PER_SESSION`          | 8      | Nonterminal subagents per root session |
| `MAX_AGENT_MESSAGE_BYTES`            | 65,536 | Message content, in UTF-8 **bytes**    |
| `MAX_PENDING_MESSAGES_PER_RECIPIENT` | 100    | Queued messages for one recipient      |

The reserved orchestrator identity does not count against the subagent limit.
`agentMessageContentSchema` measures UTF-8 bytes with `utf8ByteLength()`, not
JavaScript string length; exactly 65,536 bytes is accepted and one more byte is
rejected without truncation. Mailbox framing has a separate limit that includes
the validated JSON envelope and newline.

## Tool schemas

Strict, provider-neutral schemas and inferred types exist for the arguments and
success results of `StartAgent`, `ListAgents`, `SendAgentMessage`, `StopAgent`,
and `FinishAgent`. They carry no MCP or JSON-RPC wrapper and no provider result
blocks, so later adapters can serialize the same values.

`ListAgents` returns a union discriminated on `role`: an orchestrator row has
the literal name `orchestrator` and no `type`; a subagent row has
`role: 'subagent'` and one of the four types.

**Identity is never a model argument.** `SendAgentMessage` has no `source`,
`sourceName`, or `caller` field, `StopAgent` has no caller-role field, and
`FinishAgent` has no target field — it acts on the calling agent only. The
runtime binds the caller internally; putting identity in the arguments would
make spoofing part of the public contract. All argument schemas are strict, so
such a field fails validation.

## Internal identity environment

Five internal variables carry per-process identity:
`TIM_AGENT_MESSAGING_DIR`, `TIM_AGENT_ID`, `TIM_AGENT_NAME`, `TIM_AGENT_TYPE`,
and `TIM_AGENT_ROLE`. The orchestrator uses name `orchestrator`, role
`orchestrator`, and no type; a subagent adds one of the four types.

- `withAgentEnvironmentIdentity(inheritedEnv, identity)` returns a **copy** with
  the identity applied. It drops a stale `TIM_AGENT_TYPE` when writing an
  orchestrator identity.
- `readAgentEnvironmentIdentity(env)` returns `undefined` when all five values
  are absent, the typed identity when the combination is complete, and throws
  when any value is present but the combination is incomplete or contradictory.
- Neither helper mutates global `process.env`. Compose environment values per
  process.

These names are **reserved but not public**: they join
`RESERVED_TIM_ENVIRONMENT_VARIABLES` so project environment config cannot
spoof them, and they stay out of `TIM_ENVIRONMENT_CONTEXT_DEFINITIONS` and
`renderBuiltInTimEnvironment()`.

## Boundaries to keep

- Do not import Claude MCP types, Codex app-server types, tunnel protocol
  types, session-server types, or provider implementations into
  `src/tim/agent_messaging/`.
- Do not give the config flag a Zod default, and do not shallow-replace the
  whole `experimental` object during merge.
- Do not add prompt text, tool installation, or provider lifetime changes to
  this transport layer.
- Keep agent mailbox types separate from Claude MCP, Codex JSON-RPC, logging
  tunnel, provider lifetime, and lifecycle-manager logic.

## Modules

- `runtime_dir.ts` creates the owner-private temporary root, contained
  `agents` and `sockets` directories, opaque-ID paths, atomic registration
  files, strict reads, and idempotent cleanup.
- `mailbox_helpers.ts` exports small shared utilities used across the mailbox
  modules: control-character detection, error-message sanitization, filesystem
  identity comparison, and record type guards.
- `mailbox_protocol.ts` defines the validated request and acknowledgement
  envelopes, stable protocol errors, UTF-8 content limits, and frame encoding.
- `mailbox_framing.ts` decodes bounded JSONL bytes without corrupting
  multibyte UTF-8 characters split across chunks.
- `mailbox_connection.ts` owns one receiver-side socket, its JSONL framing,
  peer FIN state, and acknowledgement reply. `mailbox_server.ts` delegates
  per-connection handling to this class.
- `mailbox_server.ts` implements one Unix receiver, source validation,
  acknowledgement handling, duplicate request replay, and the pending FIFO.
- `mailbox_target.ts` captures and validates immutable target snapshots —
  registration file identity, socket identity, and containment checks —
  used by `mailbox_client.ts` before each send attempt.
- `mailbox_client.ts` resolves and validates a target snapshot, sends one
  request, waits for its acknowledgement, and maps connection races to stable
  protocol errors.
- `session_runtime.ts` owns registrations and receiver startup order. It
  starts a receiver before publishing its registration and closes receivers
  before removing the runtime root.

The shared identity, name, lifecycle, disposition, and environment contracts
remain in `contracts.ts` and `environment.ts`. The mailbox modules consume
those contracts and do not define provider-specific alternatives.

## Public API surface

`createAgentMessagingSessionRuntime(options?)` (or
`AgentMessagingSessionRuntime.create()`) is the single entry point. It creates
the private root and returns a runtime with these operations:

| Operation                                   | Result                                                           |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `register({ registration, deliver, ... })`  | Starts a receiver, publishes the registration, returns a handle  |
| `sendMessage(trustedSource, target, input)` | Sends one request and resolves with its `MailboxAcknowledgement` |
| `deregister(reference)`                     | Closes and removes one active generation                         |
| `close()`                                   | Closes all receivers, then removes the exact root                |

`register()` also accepts `maxConnections` and `recentRequestIdLimit`. The
returned `SessionRegistrationHandle` exposes the published `registration`, its
`receiver`, a `ready` promise, and a generation-bound `deregister()`.

Each `MailboxReceiver` exposes `registration`, `socketPath`, `ready`,
`isClosed`, `pendingCount`, `drainPending(limit?)`, and `close()`.

`sendMessage()` takes the caller-bound trusted identity as its **first**
argument, not as part of the message input. The target reference is a name or
ID; the message input carries content only.

Connection and acknowledgement deadlines both default to 5,000 ms
(`DEFAULT_MAILBOX_CONNECTION_TIMEOUT_MS`,
`DEFAULT_MAILBOX_ACKNOWLEDGEMENT_TIMEOUT_MS`). Pass
`connectionTimeoutMs` / `acknowledgementTimeoutMs` to
`createAgentMessagingSessionRuntime()` for deterministic tests.

Runtime-level failures throw `AgentMessagingSessionRuntimeError` with a stable
code: `runtime_closed`, `identity_reserved`, `registration_conflict`,
`registration_failed`, or `invalid_options`. Transport failures throw
`MailboxProtocolError` with the protocol codes listed below.

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

`SessionRegistrationHandle.deregister()` is bound to that handle's registration
generation. If `session.deregister()` receives an `AgentRegistration` object,
it must be the exact object returned by the active handle; a structurally equal
record reread from disk or returned by a listing is intentionally not allowed
to remove a replacement that reused the same ID. Use the handle, name, or ID
when a generation-bound object is not available.

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

The mailbox client must keep the connection open after writing the request until
it receives the acknowledgement. In particular, it must not call
`socket.end(frame)` or otherwise send a peer FIN with the request. Bun does not
provide a reliable half-open accepted socket for this protocol. If the receiver
observes peer FIN before source validation and delivery completes, it closes the
connection without an acknowledgement and does not invoke delivery or add the
message to the pending FIFO. `MailboxClient` follows the required write-then-
wait sequence and closes only after the acknowledgement or a bounded failure.

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
