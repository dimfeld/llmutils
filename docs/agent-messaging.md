# Agent Messaging

This document is the central operational reference for the experimental
collaborative agent-messaging feature. It covers the configuration flag,
activated orchestration behavior, tool sets, agent roles, naming, capacity,
delivery, lifecycle, shared-workspace coordination, TDD ordering, process
labels, provider requirements, and the advisory-reviewer versus formal-review
distinction.

For lower-level internals, see these companion documents:

- [agent-manager.md](agent-manager.md) — the `AgentManager` core:
  naming, capacity, start, list, send, and the finish/stop/terminal lifecycle.
- [subagent-launch-service.md](subagent-launch-service.md) — reusable one-shot
  preparation and launch service.
- [claude-mcp-bridge.md](claude-mcp-bridge.md) — the internal `tim` MCP server
  for Claude: permission approval, role-scoped agent tools, four installation
  states, MCP config merging, and prompt serialization.
- [persistent-claude-agent.md](persistent-claude-agent.md) — persistent Claude
  provider sessions.
- [codex-cli-integration.md](codex-cli-integration.md) — Codex executor,
  dynamic-tool protocol, and persistent Codex provider sessions.
- [persistent-codex-agent.md](persistent-codex-agent.md) — persistent Codex
  provider sessions.

## Activated collaborative orchestration

When `experimental.agentMessaging` is `true` for a newly started `tim agent`
session, the orchestrator prompt uses collaborative agent tools instead of
synchronous `tim subagent` shell commands. The orchestrator can start, message,
and stop persistent subagents that share one live working directory. Subagents
can message each other and the orchestrator directly. The formal review gate
remains a separate one-shot `tim review` command.

When the flag is absent or `false`, every prompt, tool set, and execution path
keeps the current synchronous `tim subagent` behavior. No messaging runtime,
registry, mailbox, or persistent-agent session is created. Existing one-shot
orchestration is fully compatible.

### New-session snapshot semantics

The flag is read **once** when a root `tim agent` session starts. The resolved
boolean is stored in `ExecutorCommonOptions.agentMessagingEnabled` and forwarded
into `OrchestrationOptions`. A running session cannot change mode mid-run.
Config changes affect only sessions that start after the change. No rebuild is
needed.

When the snapshot is `true`, the root session creates a
`CollaborativeAgentSession` that owns the `AgentManager`, Claude MCP tool
context, Codex dynamic-tool provider, and the shared root
`ClaudePermissionPromptCoordinator`. When the session ends, the manager shuts
down before the coordinator is disposed.

### Orchestrator tool set (flag true)

The root orchestrator receives these tools through the provider transport:

| Tool                  | Purpose                                                                             |
| --------------------- | ----------------------------------------------------------------------------------- |
| `StartTimAgent`       | Start a persistent subagent without waiting for it to finish                        |
| `ListTimAgents`       | Return other active agents' canonical names, types, executors, and lifecycle states |
| `SendTimAgentMessage` | Send context, questions, blockers, decisions, or handoffs                           |
| `StopTimAgent`        | Graceful or forced stop of a named subagent                                         |

The orchestrator does **not** receive `FinishTimAgent`. A subagent can call its own
self-only `FinishTimAgent` after its assignment and final handoff. Before the root
session shuts down, the orchestrator must make sure every subagent has reached a
terminal state (`exited` or `failed`). After a final handoff, it can ask the
subagent to call `FinishTimAgent`; if the subagent cannot finish, the orchestrator
can use `StopTimAgent` and wait for the terminal notification.

### Subagent tool set (flag true, StartTimAgent-created)

A StartTimAgent-created subagent receives only:

| Tool                  | Purpose                                                |
| --------------------- | ------------------------------------------------------ |
| `ListTimAgents`       | Discover other agents' state and canonical reply names |
| `SendTimAgentMessage` | Send useful coordination to any named agent            |
| `FinishTimAgent`      | Mark self as done after final handoff (self-only)      |

Subagents do **not** receive or learn about `StartTimAgent` or `StopTimAgent`.

### Agent types and executors

StartTimAgent supports four agent types and two executors:

| Type          | Description                                                          |
| ------------- | -------------------------------------------------------------------- |
| `implementer` | Edit assigned implementation files, report changes and verification  |
| `tester`      | Inspect/edit test and fixture files, run checks, report results      |
| `tdd-tests`   | Write expected failing tests for a scope, report failure evidence    |
| `reviewer`    | Read-only, advisory: inspect, run non-mutating checks, send findings |

| Executor      | Description            |
| ------------- | ---------------------- |
| `claude-code` | Claude Code subprocess |
| `codex-cli`   | Codex CLI app-server   |

`orchestrator` is a runtime role, not an agent type. The reserved
`orchestrator` name appears in a subagent's `ListTimAgents` result and is
addressable by `SendTimAgentMessage`; it is omitted when the orchestrator calls
`ListTimAgents`.

### Naming

Agent names are 1 to 48 characters of lowercase ASCII letters, digits, and
hyphens, with alphanumeric first and last characters. `orchestrator` is
reserved. A custom name collision with an active agent fails the start request.

When the name is omitted, the manager generates `<type>-<short-slug>` (e.g.
`implementer-moss-7k`) and retries on collision. After `StartTimAgent` returns,
always use the canonical name it returned.

### Capacity

A session allows at most **eight nonterminal subagents**. The reserved
`orchestrator` identity does not count. Agents in `starting`, `running-active`,
`running-idle`, `finishing`, and `stopping` states all hold capacity until
terminal cleanup releases their slots. A ninth concurrent start returns a clear
limit error without allocating a process, mailbox, or name reservation.

### Delivery acknowledgements

`SendTimAgentMessage` reports one of three successful delivery paths:

| Result              | Meaning                                                     |
| ------------------- | ----------------------------------------------------------- |
| `steered`           | Message delivered into the active provider turn immediately |
| `queued`            | Message accepted into the recipient FIFO for later delivery |
| `started-idle-turn` | Message started a new turn on an idle provider session      |

`queued` is a successful acceptance. Do not resend a queued message.

Every subagent must make a result-bearing tim tool call before it ends its work.
It can send its final response to `orchestrator` with `SendTimAgentMessage`, or
it can put its final status in the `FinishTimAgent` message. A normal assistant
response without either tool call is not the result-delivery contract. A
terminal notification confirms lifecycle completion and can carry the explicit
`FinishTimAgent` status.

Messages carry **trusted sender attribution** set by the runtime. No model
argument supplies or replaces the source identity. Recipients see the sender's
canonical name. Provider-visible messages from subagents also include the
sender's opaque ID. This distinguishes an older queued message from a later
agent generation that reuses the same name.

Content is limited to 65,536 UTF-8 bytes per message. Each recipient can hold
at most 100 pending FIFO messages. Oversized content or a full queue returns a
clear error without truncation or eviction.

### Lifecycle states and terminal notifications

| State            | Accepts work | Visible in ListTimAgents |
| ---------------- | ------------ | ------------------------ |
| `starting`       | no           | yes                      |
| `running-active` | yes          | yes                      |
| `running-idle`   | yes          | yes                      |
| `finishing`      | no           | yes                      |
| `stopping`       | no           | yes                      |
| `exited`         | no           | no (terminal)            |
| `failed`         | no           | no (terminal)            |

Natural agent exit and graceful requested exit each produce exactly one terminal
notification to the orchestrator. Forced-stop notifications are never suppressed
and include the last completed assistant message (if available) with a staleness
warning.

### Shared-workspace coordination

All agents share one working directory and see each other's changes immediately.
The orchestrator must assign disjoint file scopes or coordinate ownership before
concurrent mutating work. Read-only review and non-mutating inspection may
overlap freely. The orchestrator owns task selection, final integration, plan
updates, and the completion decision.

### Persistent assignments across phases

`StartTimAgent` creates a persistent subagent. A progress message or interim
handoff does not end its assignment. Any subagent can remain active while
another workflow phase runs, then receive more work through `SendTimAgentMessage`.
Each persistent subagent prompt includes its assigned canonical agent name.
`ListTimAgents` omits the calling agent, so its result contains only other active
agents and cannot make the caller appear to be a second participant.
For example, an implementer can stay active while review runs and receive
accepted findings, while an advisory reviewer can stay active while fixes are
made and then verify the changed scope. `FinishTimAgent` is for the end of the
full assignment, not the end of one turn or workflow phase. The separate
`tim review` command remains the formal review gate.

### TDD per-scope ordering

In TDD mode, the `tdd-tests` agent writes expected failing tests before the
implementer starts for each scope. Independent scopes can run separate TDD
pipelines concurrently. The orchestrator must verify behavioral failure evidence
before starting the implementer. Final testing and formal review run against the
completed implementation.

### Advisory reviewer versus formal `tim review`

A StartTimAgent `reviewer` is a **read-only, advisory** collaborator. It can
inspect evolving work, run non-mutating checks, and send findings to the team.
It cannot edit files or create commits. Its result is not the formal quality
gate.

The authoritative review is the separate one-shot `tim review` command. It runs
with fresh context and **no messaging tools**. It preserves the existing review
iteration policy: full-scope first review, diff-scoped fix verification, closing
full-scope review, severity gate (`critical`/`major` blocking), four ordinary
review bound, structural-only pass, and bounded handoff. See
[review-iteration-policy.md](review-iteration-policy.md).

Enabled orchestrators render `tim review` for formal reviews. Disabled
orchestrators use the equivalent `tim subagent reviewer` alias. The alias
remains available for external compatibility.

### Review phase ownership

Activation changes the command spelling and the delegation mechanism, not who
owns a review:

| Phase                      | Enabled behavior                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Non-batch formal review    | One-shot `tim review <planId> --print --output-file <path>` with `--task-index` scope and `--input(-file)` notes |
| Selected-task batch review | Performed by the orchestrator; an advisory `StartTimAgent` reviewer may add read-only findings only              |
| Final full-plan sequence   | `tim review` after the batch completes every remaining task                                                      |
| Standalone structural pass | `tim review ... --structural-only`, still gated by the `structuralReviewAt` marker                               |

A StartTimAgent reviewer never replaces the formal gate, never becomes the
orchestrator-owned batch review, and never substitutes for a structural or
simplification pass that the marker has already retired. Rejection recording is
unchanged: reviewer-command findings use
`tim review-issues reject ... --from-review <output.json> --issue <n>`, and the
orchestrator's own batch findings use the explicit `--content/--file/--line`
form because that review writes no reviewer output file.

### Review-fix assignments

Formal review invocation context and collaborative fix-agent delegation are
separate. The one-shot formal review keeps its supported `--task-index`,
`--since`, `--input`, `--input-file`, and `--structural-only` options. In an
enabled session, assign an accepted review fix through `StartTimAgent` or
`SendTimAgentMessage` with the owning task, exact files, accepted findings,
constraints, verification steps, and the canonical agent name. Do not replace
that message context with `--task-index`, `--input`, or `--input-file` flags.

Disabled sessions use the legacy `tim subagent` fix path, where the owning task
is passed with `--task-index` and the findings are passed with `--input` or
`--input-file`. The complete scope rules, including completed-task handling,
are in [Review-fix delegation scope](review-iteration-policy.md#review-fix-delegation-scope).

### Process labels

Named Claude and Codex agents appear in the process tree with labels such as
`Claude agent (api-implementer)` and `Codex thread (test-auditor)`. The existing
`ProcessTree.svelte` component renders labels verbatim with no identity or
process-control changes.

### Provider requirements

- **Claude Code**: requires the `tim` MCP bridge installed by
  `setupPermissionsMcp()`. See [claude-mcp-bridge.md](claude-mcp-bridge.md).
- **Codex CLI**: requires app-server experimental dynamic-tool support. The
  `codex exec` fallback cannot host persistent sessions. See
  [codex-cli-integration.md](codex-cli-integration.md).

### Disabled compatibility

When the flag is absent or `false`:

- Orchestrator prompts use synchronous `tim subagent implementer`,
  `tim subagent tester`, `tim subagent tdd-tests`, and
  `tim subagent reviewer` commands.
- No `StartTimAgent`, `ListTimAgents`, `SendTimAgentMessage`, `StopTimAgent`, or
  `FinishTimAgent` tool names appear in prompts or tool sets.
- No session directory, registry, mailbox, or persistent-agent label is created.
- Formal review, planning, proof, chat, direct `tim subagent`, and all
  non-orchestration executor paths remain one-shot with no messaging tools.

### Non-orchestration entry points

Formal `tim review`, planning, proof, chat, direct `tim subagent`, and bare
executor modes never receive messaging tools or persistent-agent behavior,
regardless of the flag value. They receive no `agentToolContext` and therefore
the Claude bridge installs no agent tools, and the Codex runner installs no
dynamic-tool provider. `tim run` is an alias of `tim agent`, so it uses the
same flag-controlled orchestration behavior.

---

The sections below describe the provider-neutral contracts, session storage,
and Unix-socket mailbox transport in `src/tim/agent_messaging/`.

The shared contracts let an orchestrator address, message, and stop its
subagents. The transport gives one trusted session runtime a private namespace
and one mailbox receiver per registered identity. It provides bounded,
acknowledged message delivery for the lifecycle layer.

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
  address. Used by `SendTimAgentMessage`.
- `agentNameSchema` — rejects `orchestrator`. Used where a custom subagent
  name is required.

Default `<type>-<short-slug>` name generation and collision reservation belong
to the manager layer ([agent-manager.md](agent-manager.md)). Filesystem objects
use opaque IDs, not these names.

### Limits

| Constant                             | Value  | Meaning                                |
| ------------------------------------ | ------ | -------------------------------------- |
| `MAX_AGENT_NAME_LENGTH`              | 48     | Name characters                        |
| `MAX_SUBAGENTS_PER_SESSION`          | 8      | Nonterminal subagents per root session |
| `MAX_AGENT_MESSAGE_BYTES`            | 65,536 | Message content, in UTF-8 **bytes**    |
| `MAX_PENDING_MESSAGES_PER_RECIPIENT` | 100    | Queued messages for one recipient      |

`STOP_AGENT_INACTIVITY_TIMEOUT_MS` (120,000) is the shared timing constant for
graceful stop. It measures provider-output inactivity, not total shutdown
duration; the manager owns that policy ([agent-manager.md](agent-manager.md)).

The reserved orchestrator identity does not count against the subagent limit.
`agentMessageContentSchema` measures UTF-8 bytes with `utf8ByteLength()`, not
JavaScript string length; exactly 65,536 bytes is accepted and one more byte is
rejected without truncation. Mailbox framing has a separate limit that includes
the validated JSON envelope and newline.

## Tool schemas

Strict, provider-neutral schemas and inferred types exist for the arguments and
success results of `StartTimAgent`, `ListTimAgents`, `SendTimAgentMessage`, `StopTimAgent`,
and `FinishTimAgent`. They carry no MCP or JSON-RPC wrapper and no provider result
blocks, so later adapters can serialize the same values.

`contracts.ts` is also the single source of the model-facing tool metadata that
every transport installs:

| Export                                                       | Purpose                                 |
| ------------------------------------------------------------ | --------------------------------------- |
| `AGENT_TOOL_NAMES` / `AgentToolName`                         | The five canonical tool names           |
| `ORCHESTRATOR_AGENT_TOOL_NAMES`, `SUBAGENT_AGENT_TOOL_NAMES` | The role allowlists                     |
| `getAgentToolNames(role)`                                    | Role to allowlist lookup                |
| `AGENT_TOOL_DESCRIPTIONS`                                    | Model-facing description per tool       |
| `AGENT_ARGUMENT_SCHEMAS`                                     | Tool name to its strict argument schema |

The Claude MCP bridge and the Codex dynamic-tool adapter both read these values,
so a model sees the same names, descriptions, role sets, and argument shapes on
either transport. Adapter-local names such as `CLAUDE_ORCHESTRATOR_TOOL_NAMES`
and `CODEX_AGENT_ARGUMENT_SCHEMAS` are re-exports, not separate definitions.
Add a tool or change a description here, not in an adapter.

`ListTimAgents` returns a union discriminated on `role`: an orchestrator row has
the literal name `orchestrator` and no `type`; a subagent row has
`role: 'subagent'` and one of the four types.

**Identity is never a model argument.** `SendTimAgentMessage` has no `source`,
`sourceName`, or `caller` field, `StopTimAgent` has no caller-role field, and
`FinishTimAgent` has no target field — it acts on the calling agent only. The
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

## Log file attribution

Log file lines use the format `[HH:MM:SS] [agent-name] message`. The local
`TIM_AGENT_NAME` value supplies the name for direct writes. Tunnel log, raw
output, and structured messages include `agentName`, so the parent keeps the
child's name when it writes the message to the shared log file. The field is
optional for compatibility with older tunnel clients; messages without it use
the current process name, or `orchestrator` when no identity is set.

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

Provider input adapters must treat `deliver()` as a fast accept-or-refuse
operation. When an adapter reports that input is available but refuses a
delivery, `AgentMailboxBinding` makes at most one immediate retry for that
availability version. Further progress requires the adapter to call its
`onAvailabilityChange` listeners. Claude and Codex persistent-session adapters
must emit that notification whenever delivery can make progress again. The full
drain rules are in [agent-manager.md](agent-manager.md).

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

`register()` also accepts `onMessageQueued`, `maxConnections`, and
`recentRequestIdLimit`. `onMessageQueued` fires after a temporarily unavailable
message has been appended to the FIFO, so a consumer can recheck a queue it just
observed as empty. The returned `SessionRegistrationHandle` exposes the published
`registration`, its `receiver`, a `ready` promise, and a generation-bound
`deregister()`.

Each `MailboxReceiver` exposes `registration`, `socketPath`, `ready`,
`isClosed`, `pendingCount`, `leasePending(limit?)`, and `close()`.

`leasePending()` removes one FIFO batch for provider delivery and returns a
`MailboxPendingDeliveryLease` with the messages plus idempotent `acknowledge()`
and `requeue()`. A lease keeps reserving queue capacity until it is resolved, so
in-flight messages still count against the 100-message limit. `requeue()`
restores the batch at the FIFO head in its original order, which keeps message
identity with the lease rather than with the consumer.

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

These file modes isolate the runtime from other operating-system users. The
local socket transports do not authenticate processes that run as the same
user. A same-user process that can inspect the runtime directory can connect
directly and claim a registered agent identity. The Claude MCP parent socket
has the same trust boundary. Therefore, all same-user processes in a session
must be trusted. Use process or user isolation, or add per-agent credentials,
when agents can run hostile shell code.

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
provide or replace them. This binding protects the model-facing API. It does
not authenticate a same-user process that connects to the socket directly, as
described in **Private runtime and registrations**.

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
older message is evicted or truncated. `leasePending()` removes messages in send
order, and their queue slots are released only when the lease is acknowledged.

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
