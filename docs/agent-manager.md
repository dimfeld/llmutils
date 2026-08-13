# Agent Manager

`AgentManager` is the provider-neutral core that an authorized orchestrator uses
to start, list, and message named agents. It is the single owner of active
names, opaque agent IDs, subagent capacity, lifecycle state, and Start/List/Send
authorization.

It builds on two lower layers:

- The contracts and mailbox transport in
  [agent-messaging.md](agent-messaging.md).
- The reusable one-shot preparation and launch service in
  [subagent-launch-service.md](subagent-launch-service.md).

Later provider adapters (Claude MCP tools, Codex dynamic tools) must translate
tool arguments into these methods only. They must not repeat naming, capacity,
authorization, or delivery policy.

## Scope

The manager owns:

- Root `orchestrator` registration and its ready mailbox.
- Name validation, name generation, and the atomic eight-subagent reservation.
- `startAgent()` authorization, preparation, launch, readiness, and rollback.
- `listAgents()` lifecycle visibility.
- `sendAgentMessage()` trusted routing and delivery acknowledgements.
- The mailbox-to-provider drain for each agent.

The manager does **not** own `FinishAgent`, `StopAgent` execution, provider exit
convergence, terminal notifications, final-message deduplication, teardown of
live subagents, provider tool installation, orchestration prompts, or any
persistent Claude or Codex provider loop. Those belong to the successor
lifecycle plan. Only the two narrow seams described in
[Successor seams](#successor-seams) exist here.

## Module layout

| File                       | Contents                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `agent_manager.ts`         | The `AgentManager` facade: option validation, root creation, Start/List/Send, close |
| `agent_manager_types.ts`   | Identity, launch, input-adapter, snapshot, option, and error contracts              |
| `agent_directory.ts`       | Authoritative ID/name maps, capacity, naming, reservation, snapshots                |
| `agent_startup.ts`         | Per-start cancellation, late-resource tracking, and rollback                        |
| `agent_mailbox_binding.ts` | One agent's provider input adapter and its mailbox drain scheduling                 |
| `agent_names.ts`           | Branded `AgentId` / `AgentName`, parsing, and generated-name construction           |
| `agent_process_labels.ts`  | The single display-label formatter                                                  |
| `agent_preparation.ts`     | The preparation dependency built on the subagent launch service                     |
| `fake_provider.ts`         | Deterministic fake preparer, launcher, handle, and input adapter for tests          |

All files live in `src/tim/agent_messaging/`. `index.ts` exports immutable
identities, snapshots, results, and the narrow lifecycle seams only. Mutable
directory records, reservations, and startup operations stay internal.

## Construction

`createAgentManager(options)` (or `AgentManager.create()`) validates its options,
creates or accepts a session runtime, and returns only after the reserved root
mailbox is ready.

| Option                           | Meaning                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `sessionRuntime`                 | An existing runtime. When absent, the manager creates and owns one |
| `orchestratorExecutor`           | Executor recorded for the root identity; defaults to `claude-code` |
| `agentIdGenerator`               | Synchronous opaque-ID source; defaults to `randomUUID()`           |
| `slugGenerator`                  | Synchronous slug source for generated names                        |
| `maxAgentIdGenerationAttempts`   | Bounded unique-ID retries                                          |
| `maxAgentNameGenerationAttempts` | Bounded unique-name retries                                        |
| `agentPreparer`                  | Provider-neutral preparation boundary                              |
| `agentLauncher`                  | Provider-neutral launch boundary                                   |
| `orchestratorInputAdapter`       | Input boundary for messages addressed to `orchestrator`            |

Injected generators are what make concurrency, collision, and exhaustion tests
deterministic. The manager reads no global mutable state and never mutates
`process.env`; per-agent environment belongs to the launch request.

`close()` is idempotent. It cancels in-flight starts, deregisters mailboxes,
closes the session runtime when it owns it, disposes every mailbox binding, and
clears the directory.

### Root orchestrator identity

Creation registers exactly one root identity: name `orchestrator`, role
`orchestrator`, a stable opaque ID, and state `running-idle`. It is always first
in `listAgents()` because it holds creation sequence `0`, and it never consumes
one of the eight subagent slots. If root registration or mailbox readiness
fails, the partial registration and any manager-owned runtime are closed and the
call throws `root_registration_failed`.

## Identity vocabulary

Keep these separate; each has its own field and, where useful, its own branded
type.

| Concept            | Type                | Notes                                                            |
| ------------------ | ------------------- | ---------------------------------------------------------------- |
| Agent ID           | `AgentId`           | Opaque, stable across state changes, never derived from the name |
| Agent name         | `AgentName`         | The model-facing address                                         |
| Process-control ID | `ProcessControlId`  | OS process-registry identity from the launch handle              |
| Provider thread ID | `ProviderThreadId`  | Provider-level logical thread                                    |
| Process label      | `AgentProcessLabel` | Display metadata only                                            |

An opaque ID, not a name, appears in registration and socket filenames. A
display label is never an identity or a process-control selector.

Lifecycle state and provider input availability are also different concepts.
`AgentInputActivity` is one of `not-ready`, `active`, `temporarily-unavailable`,
or `idle`. It updates `running-active` / `running-idle` in the shared lifecycle
vocabulary; the manager does not add a second public state union.

## Names, capacity, and reservation

Names follow the shared grammar in [agent-messaging.md](agent-messaging.md): 1 to
48 characters of lowercase ASCII letters, digits, and hyphens with alphanumeric
boundaries. `orchestrator` is reserved for every subagent request.

- **Custom names fail on first collision** (`name_in_use`). The manager never
  renames, numbers, or redirects a user-supplied name, and no slot is consumed.
- **Omitted names** are generated as `<type>-<slug>` through the injected slug
  generator, with bounded retries and `name_generation_exhausted` on failure.
  `buildGeneratedAgentName()` validates the slug as its own name component _and_
  the complete name, so a slug such as `-worker` cannot form `tester--worker`.

`AgentDirectory.reserve()` is one synchronous critical section. It counts
nonterminal subagents, enforces `MAX_SUBAGENTS_PER_SESSION` (8), selects the
name, allocates the opaque ID, and inserts the `starting` record into both the
ID and name maps **before any `await`**. Two concurrent starts competing for the
last slot therefore cannot both succeed. If future work needs an asynchronous
step inside this method, add an explicit lock.

`starting`, `running-active`, `running-idle`, `finishing`, and `stopping` all
hold a slot. The orchestrator does not. A failed start releases its slot and
name, so both can be reused immediately.

## StartAgent

`startAgent(caller, request)` accepts the caller-bound identity separately from
the request object. The caller is `{ id, role }` only; names, executors, types,
and source identity are always read from manager state.

Order, which is behavior rather than style:

1. Reject a closed manager.
2. Resolve the caller against the directory and require role `orchestrator`.
   Anything else fails with `not_authorized` **before** any allocation. Matching
   the name `orchestrator` is not sufficient — the stable ID must resolve.
3. Validate type, executor, initial message, and custom name.
4. Reserve name, ID, and slot synchronously in state `starting`.
5. Prepare through `AgentPreparation`, then confirm the prepared type and
   executor match the reservation.
6. Register the mailbox and await its `ready` promise.
7. Launch through `AgentLauncher` with the formatted process label, bind the
   handle's input adapter, and await launch-handle readiness.
8. Return the frozen `{ name, id, type, executor, state }` result.

The readiness boundary is deliberate: the call returns after the launch handle
exists and the mailbox is listening and registered, but **before** provider
input readiness and before assignment completion. Input readiness can resolve
before launch readiness; until both hold, the public state stays `starting` and
messages stay queued in the mailbox FIFO. The manager never awaits
`handle.completion`.

Every failure path runs one rollback. `AgentStartupTracker` keeps the pending
mailbox-registration and launch promises so a resource that resolves _after_ the
failure is still closed, then releases the reservation. Cleanup errors never
block the release — otherwise a failed provider release would permanently
consume a name and a slot. Failures surface as `launch_failed`, except a
manager close during startup, which surfaces as `manager_closed`.

## ListAgents

`listAgents()` reads the in-memory directory only; registration files are
discovery metadata, not lifecycle truth. It returns a frozen container of frozen
rows sorted by creation sequence, so the orchestrator is always first. Rows carry
public fields only — no prompt text, provider handle, socket path, environment,
or mutable record.

Nonterminal agents are included, which means `finishing` and `stopping` agents
stay visible even though they reject new messages. Terminal entries disappear
once the successor lifecycle owner removes them.

`getAgentSnapshot(id)` returns a richer frozen `AgentRecordSnapshot` (identity,
state, input activity, creation sequence, and the optional process-control and
provider-thread IDs) for diagnostics.

## SendAgentMessage

`sendAgentMessage(caller, request)` takes `{ name, message }` and nothing else.
There is no `source` field: the trusted source is derived from the bound caller
identity, so a fabricated sender in tool arguments is impossible by contract and
rejected by the strict schema.

Checks run in this order:

1. Reject an oversized message with `invalid_request` and the transport code
   `message_too_large`, then validate the arguments schema. A syntactically bad
   target name reports `invalid_name`.
2. Resolve the caller; a missing, stale, or role-mismatched identity fails with
   `unknown_sender`.
3. Resolve the target name to an exact record. Unknown or terminal targets fail
   with `unknown_target`.
4. Reject `finishing` and `stopping` targets, and any target without a ready
   mailbox, with `target_not_accepting_messages`.
5. Send through the session runtime with the resolved source and target.

The result is a frozen `{ name, messageId, delivery }`, where `messageId` is the
acknowledged request ID and `delivery` is `steered`, `queued`, or
`started-idle-turn`. The manager creates no second queue; the plan-413 mailbox
FIFO owns capacity (100 messages) and ordering. Mailbox failures map to
`unknown_sender`, `unknown_target`, or `transport_error`, and the original stable
transport code stays available on `AgentManagerError.transportCode`.

## Mailbox binding and drain scheduling

`AgentMailboxBinding` owns one agent's input adapter and the drain from its
mailbox FIFO to the provider. Its invariant: **when pending work exists and
delivery is possible, exactly one drain is scheduled.**

- Immediate delivery is attempted only when the record is current and
  nonterminal, the adapter is ready and not `not-ready` or
  `temporarily-unavailable`, the launch is ready, no drain is running, and the
  FIFO is empty. Otherwise the message falls back to the FIFO as `queued`.
- The drain guard is armed **synchronously before** provider code runs, because
  an adapter may emit an availability notification from inside `deliver()`. That
  callback must not start a second drain.
- Draining uses `receiver.leasePending(1)`. A lease reserves FIFO capacity until
  it is acknowledged or requeued, so in-flight messages still count against the
  100-message limit and a requeue restores the batch at the FIFO head in order.
- A provider `deliver()` that returns `temporarily-unavailable` **or throws**
  gets at most one `setImmediate` retry per availability version. Further
  progress requires the adapter to call its `onAvailabilityChange` listeners.
- `onMessageQueued` from the receiver rechecks the FIFO after a fallback is
  appended, which covers a drain that observed an empty queue just before a
  concurrent append.

Provider input adapters must therefore treat `deliver()` as a fast
accept-or-refuse operation and must emit an availability notification whenever
delivery can make progress again.

## Process labels

`formatAgentProcessLabel(executor, name)` is the only place these strings are
built:

- `claude-code` → `Claude agent (<name>)`
- `codex-cli` → `Codex thread (<name>)`

The label travels in the launch request as display metadata for the process
tree. Never address, match, or control a process by its label.

## Errors

`AgentManagerError` carries a stable `code` and, for mapped transport failures,
the underlying `transportCode`.

| Code                             | Cause                                                      |
| -------------------------------- | ---------------------------------------------------------- |
| `invalid_options`                | Bad manager construction options                           |
| `invalid_request`                | Request failed schema or limit validation                  |
| `manager_closed`                 | The manager closed, including during a start               |
| `not_authorized`                 | A non-orchestrator caller attempted `startAgent()`         |
| `invalid_name` / `reserved_name` | Name grammar violation or the reserved `orchestrator` name |
| `name_in_use`                    | Custom-name collision                                      |
| `name_generation_exhausted`      | Bounded generated-name retries exhausted                   |
| `identity_generation_exhausted`  | Bounded opaque-ID retries exhausted                        |
| `agent_limit_reached`            | Eight nonterminal subagents already reserved               |
| `launch_failed`                  | Preparation, mailbox, launch, or readiness failure         |
| `unknown_sender`                 | The bound caller is not an active identity                 |
| `unknown_target`                 | Unknown, terminal, or stale target                         |
| `target_not_accepting_messages`  | Target is `finishing`, `stopping`, or has no ready mailbox |
| `transport_error`                | Mailbox transport failure                                  |
| `root_registration_failed`       | Root identity or mailbox could not be established          |
| `unknown_agent`                  | A lifecycle seam received an unknown ID                    |

## Preparation dependency

`createAgentPreparation(options)` builds the `AgentPreparation` boundary.
Implementer, tester, and TDD-test agents delegate to
`prepareSubagentExecution()` from the subagent launch service. Reviewers require
an injected `prepareReviewer` hook for collaborative, read-only review context;
this path never calls the formal review handler. `PreparedAgentExecution` is the
prepared subagent execution widened to allow the shared `reviewer` type.

## Successor seams

Two narrow methods exist for the successor lifecycle plan and perform no
completion, notification, or provider work:

- `setAgentLifecycleState(id, state)` — subagent-only nonterminal transition,
  used to reach `finishing` and `stopping`.
- `removeTerminalAgent(id)` — subagent-only removal of authoritative state after
  the lifecycle owner has cleaned the resources.

## Testing

`fake_provider.ts` provides `FakeAgentPreparer`, `FakeAgentLauncher`,
`FakeAgentLaunchHandle`, and `FakeAgentInputAdapter`. Tests use the **real**
session runtime and mailbox transport and fake only the provider boundary.

The fake adapter exposes explicit controls for ready, active, temporarily
unavailable, and idle states plus recorded received messages, so active
steering, queueing, FIFO drain order, idle turns, and each failure boundary are
exercised without timers or real model processes. Use deferred promises and
explicit state changes rather than sleeps.
