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

Provider adapters must translate tool arguments into these methods only. They
must not repeat naming, capacity, authorization, or delivery policy. The Claude
MCP adapter is documented in [claude-mcp-bridge.md](claude-mcp-bridge.md); the
Codex dynamic-tool adapter is documented in
[codex-cli-integration.md](codex-cli-integration.md).

## Scope

The manager owns:

- Root `orchestrator` registration and its ready mailbox.
- Name validation, name generation, and the atomic eight-subagent reservation.
- `startAgent()` authorization, preparation, launch, readiness, and rollback.
- `listAgents()` lifecycle visibility.
- `sendAgentMessage()` trusted routing and delivery acknowledgements.
- The mailbox-to-provider drain for each agent.
- Per-subagent lifecycle-controller fan-out for `FinishTimAgent` and `StopTimAgent`.
- One terminal notification and one cleanup path for each subagent.
- Parallel live-subagent teardown.

Each subagent has one internal `AgentLifecycleController`. It owns provider
subscriptions, finish/stop phases, inactivity timers, completed-result and
outbound-delivery metadata, terminal notification policy, and terminal cleanup.
The manager remains responsible for authorization, startup, directory lookup,
ordinary routing, and parallel root fan-out.

The manager does **not** own provider tool installation, orchestration prompts,
or any persistent Claude or Codex provider loop. Provider adapters translate
those provider-specific operations into the lifecycle controls described here.
The Claude adapter that implements those controls over one long-lived
stream-json subprocess is documented in
[persistent-claude-agent.md](persistent-claude-agent.md). The Codex adapter that
implements them over one private app-server process and one Codex thread is
documented in [persistent-codex-agent.md](persistent-codex-agent.md).

## Module layout

| File                            | Contents                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `agent_manager.ts`              | The `AgentManager` facade: option validation, root creation, Start/List/Send, close                       |
| `agent_lifecycle_controller.ts` | Per-subagent lifecycle phases, timers, notifications, and cleanup                                         |
| `agent_manager_types.ts`        | Identity, launch, input-adapter, snapshot, option, and error contracts                                    |
| `agent_directory.ts`            | Authoritative ID/name maps, capacity, naming, reservation, snapshots                                      |
| `agent_startup.ts`              | Per-start cancellation, late-resource tracking, and rollback                                              |
| `agent_mailbox_binding.ts`      | One agent's provider input adapter and its mailbox drain scheduling                                       |
| `agent_names.ts`                | Branded `AgentId` / `AgentName`, parsing, and generated-name construction                                 |
| `agent_process_labels.ts`       | The single display-label formatter                                                                        |
| `agent_preparation.ts`          | The preparation dependency built on the subagent launch service                                           |
| `terminal_notifications.ts`     | Pure final-result selection, duplicate suppression, and notification formatting                           |
| `lifecycle_scheduler.ts`        | The production clock and unreferenced timer implementation                                                |
| `fake_provider.ts`              | Deterministic fake scheduler, preparer, launcher, handle, lifecycle controls, and input adapter for tests |

All files live in `src/tim/agent_messaging/`. `index.ts` exports immutable
identities, snapshots, results, and the narrow lifecycle seams only. Mutable
directory records, reservations, and startup operations stay internal.

## Construction

`createAgentManager(options)` (or `AgentManager.create()`) validates its options,
creates or accepts a session runtime, and returns only after the reserved root
mailbox is ready.

| Option                           | Meaning                                                                    |
| -------------------------------- | -------------------------------------------------------------------------- |
| `sessionRuntime`                 | An existing runtime. When absent, the manager creates and owns one         |
| `orchestratorExecutor`           | Executor recorded for the root identity; defaults to `claude-code`         |
| `agentIdGenerator`               | Synchronous opaque-ID source; defaults to `randomUUID()`                   |
| `slugGenerator`                  | Synchronous slug source for generated names                                |
| `maxAgentIdGenerationAttempts`   | Bounded unique-ID retries                                                  |
| `maxAgentNameGenerationAttempts` | Bounded unique-name retries                                                |
| `agentPreparer`                  | Provider-neutral preparation boundary                                      |
| `agentLauncher`                  | Provider-neutral launch boundary                                           |
| `orchestratorInputAdapter`       | Input boundary for messages addressed to `orchestrator`                    |
| `scheduler`                      | Clock and timers for stop inactivity; defaults to the production scheduler |

Injected generators are what make concurrency, collision, and exhaustion tests
deterministic. The manager reads no global mutable state and never mutates
`process.env`; per-agent environment belongs to the launch request.

`close()` is idempotent. It cancels in-flight starts, waits for each cleanup
operation that has attached, closes the session runtime when it owns it,
disposes every mailbox binding, and clears the directory. Each attached startup
cleanup action (`release()` or `deregister()`) has a 5,000 millisecond bound.
The timer is cleared when the action settles and is unreferenced by the
production scheduler. A timeout is retained as a diagnostic and does not keep
the manager or session teardown pending.

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

## StartTimAgent

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

Every failure path runs one rollback. Startup continuations attach and close a
mailbox or launch handle that resolves _after_ the failure. Rollback does not
await the original registration or launch promise. Late cleanup has a bounded
timeout, and the reservation is released without waiting for an unresolved
provider launch. Failures surface as `launch_failed`, except a manager close
during startup, which surfaces as `manager_closed`.

## ListTimAgents

`listAgents(caller?)` reads the in-memory directory only; registration files are
discovery metadata, not lifecycle truth. When a caller is supplied, it is
validated against the active directory record and that caller is omitted from
the result. The model-facing `ListTimAgents` tool always supplies its trusted
caller identity, so an agent sees only the other active agents. Internal calls
without a caller retain the complete directory view for diagnostics. The result
is a frozen container of frozen rows sorted by creation sequence. Rows carry
public fields only — no prompt text, provider handle, socket path, environment,
or mutable record.

Nonterminal agents are included, which means `finishing` and `stopping` agents
stay visible even though they reject new messages. Terminal entries disappear
once the successor lifecycle owner removes them.

`getAgentSnapshot(id)` returns a richer frozen `AgentRecordSnapshot` (identity,
state, input activity, creation sequence, and the optional process-control and
provider-thread IDs) for diagnostics.

## SendTimAgentMessage

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

## Provider lifecycle controls

Each launch handle carries `lifecycle: AgentProviderLifecycleControls`. This is
the only shutdown boundary the manager uses. It is provider-neutral: no PID,
stdin object, thread ID, MCP request, or provider output DTO crosses it.

| Operation                        | Meaning                                                                |
| -------------------------------- | ---------------------------------------------------------------------- |
| `requestGracefulShutdown(text)`  | Deliver one manager-composed final-status instruction                  |
| `requestCloseAfterCurrentTurn()` | Close once the current turn has finished, never inside a tool callback |
| `requestForcedShutdown()`        | Provider-safe forced termination                                       |
| `subscribe(observer)`            | Receive lifecycle events; returns an unsubscribe function              |

Each control resolves to `'accepted'` or `'already-exited'`. `'accepted'` means
the provider control owns completion and will report a classified exit.
`'already-exited'` is an assertion that the provider is gone; the controller
then synthesizes a natural exit if no separate exit callback arrives. A control
may reject with `AgentProviderControlError`. `AgentProviderForceNotAcceptedError`
is the narrower failure that guarantees no force was accepted and therefore
stays explicitly retryable.

The observer has four events:

| Event                             | Effect                                                                |
| --------------------------------- | --------------------------------------------------------------------- |
| `outputActivity()`                | Resets only this agent's stop-inactivity timer                        |
| `completedAssistantMessage(text)` | Replaces the final-result candidate and also counts as activity       |
| `turnComplete()`                  | Lets a pending finish request run close-after-turn once               |
| `exit(classification, error?)`    | `natural`, `graceful`, `forced`, or `failed`; later calls are ignored |

Only `completedAssistantMessage()` can become terminal content. Streaming
fragments, tool traces, status events, and stderr must arrive as
`outputActivity()`; they reset the timer and never reach the orchestrator.
Providers must therefore make this translation, and the manager captures the
matching directory record when it subscribes, so a stale callback cannot affect
a later agent that reuses the same name.

`validateAgentProviderLifecycleControls()` checks the shape once, in the same
way `validateAgentInputAdapter()` checks the input boundary.

## FinishTimAgent

`finishAgent(caller, request)` is self-only. The argument schema is
`{ message?: string }` with no target field, and the caller must resolve to a
`subagent` record; an orchestrator caller fails with `not_authorized`.

1. The agent must be `running-active`, its provider lifecycle must be bound, and
   the provider must not have exited. An agent in `stopping` is also accepted
   when a graceful stop is already in progress; this covers the agent calling
   FinishTimAgent in response to the stop instruction. Any other case fails with
   `finish_not_available`.
2. For a `running-active` agent, the record moves to `finishing`. For the
   graceful-stop exception, it remains `stopping`. In both cases, the nonblank
   optional message is stored as a final-status fallback, and
   `{ state: 'finishing' }` returns immediately.
3. The handler never closes, interrupts, or ends the provider. The current turn
   continues and its completed assistant message is still captured.
4. When the provider reports `turnComplete()`, the controller calls
   `requestCloseAfterCurrentTurn()` exactly once. The claim is taken before the
   provider call, because a provider can report an exit synchronously from
   inside it.
5. Terminal notification and cleanup start only when a provider exit is
   observed. The FinishTimAgent acknowledgement is not an exit.

Repeat calls are idempotent and return `finishing`. The first accepted fallback
is never replaced. A `finishing` agent that reached that state some other way
(root teardown, for example) rejects FinishTimAgent rather than adopting it. A
FinishTimAgent call during an in-progress graceful stop is accepted as a redundant
completion acknowledgement: its nonblank message becomes the final-result
fallback, while the agent remains `stopping` and the original graceful-stop
cause is preserved. Force can still upgrade a finishing agent.

The completed assistant message of the finishing turn is the authoritative final
result. The fallback is used only when no nonblank completed message exists,
including for a FinishTimAgent call accepted during graceful stop, and it never
enables duplicate suppression.

## StopTimAgent

`stopAgent(caller, request)` requires the orchestrator caller and takes
`{ name, message?, force? }`. The reserved `orchestrator` name fails with
`reserved_name`, a malformed name with `invalid_name`, and an unknown or
terminal subagent with `unknown_target`.

### Graceful stop

Omitted or false `force` is a graceful request. The first one:

1. Moves the record to `stopping` synchronously, before any `await`, so
   concurrent sends and stops observe the new state.
2. Composes one standard final-status instruction. An optional message is
   appended as delimited additional shutdown context; it never replaces the
   standard instruction.
3. Sends that instruction once through `requestGracefulShutdown()`.
4. Returns `{ mode: 'graceful-requested', state: 'stopping' }` without waiting
   for provider exit.

The escalation window is `STOP_AGENT_INACTIVITY_TIMEOUT_MS` (120,000 ms) of
**provider-output inactivity**, not a total-duration cap. An agent that keeps
emitting output can stay alive far longer than two minutes.

The timer is armed after the provider accepts. Output that arrives during the
asynchronous request is recorded with its monotonic time and activity
generation, so acceptance schedules only the interval remaining from the latest
activity and escalates immediately when that deadline has already passed. Every
later `outputActivity()` re-arms from the new activity time. Each re-arm, force
upgrade, and terminal transition bumps a timer generation, because clearing a
timer does not stop a callback that is already queued.

A graceful control failure does not permit a second graceful instruction. The
phase becomes active with the error retained, and the inactivity timer escalates
through the normal force path.

A duplicate graceful call returns `already-stopping`. It sends no second
instruction, creates no second timer, and does not extend the window.

### Forced stop

Explicit `force: true` and timer escalation use the same path. It cancels the
graceful timer, records a force-pending phase before invoking the provider, and
calls `requestForcedShutdown()` once. Force can upgrade a graceful stop or a
finishing agent. An accepted force answers later force calls from the recorded
phase instead of calling the provider again.

Failure handling depends on what the failure proves:

- `AgentProviderForceNotAcceptedError` proves nothing was accepted. The prior
  graceful phase is restored with its timer, the record stays `stopping`, and an
  explicit caller gets `force_failed` so it can retry.
- Any other rejection leaves the outcome unknown. The phase becomes
  force-unknown, the manager never retries the control on its own, later
  explicit calls report the same `force_failed` error, and resources stay in
  place until a classified provider exit arrives.

Automatic escalation and root teardown record these errors without blocking
other agents.

## Terminal convergence and notifications

Natural exit, self-finish, graceful stop, forced stop, provider failure, and
root teardown all converge on one terminal claim per agent. The claim cancels
timers, unsubscribes the provider observer, formats the one notification, stores
that single delivery attempt, and then runs cleanup. Cleanup disposes the
mailbox binding, releases the provider handle, deregisters the mailbox, removes
the directory record, and releases the name and slot — each step guarded, and
the shared terminal promise always resolves in `finally`. Notification and
cleanup failures are logged as diagnostics; they never produce a second
notification and never leave a permanently pending entry.

`terminal_notifications.ts` holds the policy as pure functions, so it is proven
by table-driven tests rather than by a live provider.

| Cause              | Content                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `natural`          | The last completed assistant message, or a no-final-result statement                                      |
| `self-finish`      | The same, falling back to the nonblank FinishTimAgent message                                             |
| `graceful-stop`    | The same as `natural`                                                                                     |
| `forced-stop`      | The last completed message or the explicit no-message marker, plus the fixed stale/out-of-context warning |
| `provider-failure` | A short failure statement; provider diagnostics stay in logs                                              |

Delivery uses the manager's trusted internal message path with the exiting
agent's captured identity, targeting the root registration while its mailbox is
still open. It does not re-enter tool authorization.

### Duplicate suppression

Suppression exists only to avoid repeating a final result the orchestrator
already received. It applies when **all** of these hold:

- The cause is `natural`, `self-finish`, or `graceful-stop`.
- A nonblank completed assistant message exists — a FinishTimAgent fallback is not
  eligible.
- The agent's last **successfully delivered** outbound message targeted exactly
  `orchestrator` and its content is nonblank.
- The two strings are equal after trimming leading and trailing whitespace only.

Comparison keeps case, punctuation, and internal whitespace significant. No
lowercasing, normalization, or fuzzy matching. A later successful message to any
peer replaces the snapshot and defeats suppression; a failed send does not
update the snapshot, so it neither enables nor defeats it. Forced and
provider-failure notifications are never suppressed.

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

A provider may register more than one node. The persistent Codex adapter uses
this label for its logical thread node and adds a sibling
`Codex app-server (<name>)` node for the process it owns.

## Errors

`AgentManagerError` carries a stable `code` and, for mapped transport failures,
the underlying `transportCode`.

| Code                             | Cause                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `invalid_options`                | Bad manager construction options                                                                                  |
| `invalid_request`                | Request failed schema or limit validation                                                                         |
| `manager_closed`                 | The manager closed, including during a start                                                                      |
| `not_authorized`                 | A non-orchestrator caller attempted `startAgent()` or `stopAgent()`, or an orchestrator attempted `finishAgent()` |
| `invalid_name` / `reserved_name` | Name grammar violation or the reserved `orchestrator` name                                                        |
| `name_in_use`                    | Custom-name collision                                                                                             |
| `name_generation_exhausted`      | Bounded generated-name retries exhausted                                                                          |
| `identity_generation_exhausted`  | Bounded opaque-ID retries exhausted                                                                               |
| `agent_limit_reached`            | Eight nonterminal subagents already reserved                                                                      |
| `launch_failed`                  | Preparation, mailbox, launch, or readiness failure                                                                |
| `unknown_sender`                 | The bound caller is not an active identity                                                                        |
| `unknown_target`                 | Unknown, terminal, or stale target                                                                                |
| `target_not_accepting_messages`  | Target is `finishing`, `stopping`, or has no ready mailbox                                                        |
| `transport_error`                | Mailbox transport failure                                                                                         |
| `root_registration_failed`       | Root identity or mailbox could not be established                                                                 |
| `unknown_agent`                  | A lifecycle seam received an unknown ID                                                                           |
| `finish_not_available`           | FinishTimAgent outside an active turn, or after provider exit                                                     |
| `force_failed`                   | Forced shutdown was not accepted, or its outcome is unknown                                                       |

## Preparation dependency

`createAgentPreparation(options)` builds the `AgentPreparation` boundary.
Implementer, tester, and TDD-test agents delegate to
`prepareSubagentExecution()` from the subagent launch service. Reviewers require
an injected `prepareReviewer` hook for collaborative, read-only review context;
this path never calls the formal review handler. `PreparedAgentExecution` is the
prepared subagent execution widened to allow the shared `reviewer` type.

## Lifecycle ownership

The manager creates one lifecycle controller for each subagent. Provider exit
events, finish requests, stop requests, and provider failures converge through
that controller's shared terminal promise and cleanup path. Callers that need
to observe completion use `waitForAgentTerminal(id)`; they must not remove agent
records directly.

`setAgentLifecycleState(id, state)` remains a narrow nonterminal test seam for
the provider-neutral lifecycle tests. It does not perform terminal cleanup.

### Parallel root teardown

Creation registers exactly **one** session-level handler with
`CleanupRegistry`, which calls `close()`. `CleanupRegistry.executeAllAsync()`
awaits handlers in sequence, so the fan-out across subagents happens inside
`close()` instead of one handler per agent.

`close()` is memoized: repeated calls, including a racing registry call, return
the same promise. Once it starts, new starts and messages fail with
`manager_closed`, and any StopTimAgent or FinishTimAgent already in flight joins the
existing terminal promise rather than starting a second shutdown. Every
snapshot entry is stopped or joined first, then all terminal promises are
awaited together, so one slow or failing agent cannot serialize the others. The
orchestrator mailbox and session runtime close last, after every terminal
notification attempt has settled, and the cleanup handler is unregistered.

### Teardown convergence invariants

`close()` marks the manager closed, snapshots every nonterminal subagent, and
starts all stop work before awaiting any terminal promise. It also cancels every
in-flight preparation, mailbox-registration, launch, and readiness boundary.
Startup promises that have no cancellation API are not awaited during close.
Only resources that have attached are cleaned up and included in the close
wait. The manager performs one event-loop drain after the current cleanup set
to catch resources that attach during teardown. A resource that attaches after
that final drain is still released by the cancelled start operation's
idempotent cleanup hook, with the same 5,000 millisecond bound, but it does not
delay manager close or session removal. Its late cleanup result is retained
only for diagnostics owned by that startup operation; it cannot recreate an
agent record or keep the closed session alive.

Every nonterminal agent has an independent output-inactivity path:

- `stopping` agents arm the 120,000 ms deadline after graceful acceptance or
  graceful-control failure. A failed graceful request does not permit another
  graceful instruction; the timer escalates through the normal force path.
- `finishing` agents receive the same independent deadline during root
  teardown, but never receive a second graceful instruction. Provider output
  resets only that agent's timer.
- A provider `'already-exited'` control result is a non-failure assertion that the
  provider has already exited. It is a convergence event: the manager
  controller synthesizes a classified natural exit when the provider does not
  send a separate callback. A failed provider must emit the classified `failed`
  exit event instead. An exit before launch readiness is a `launch_failed`
  startup result and never creates a normal terminal notification.
- A force rejection that does not prove non-acceptance has an unknown outcome.
  The manager reports that error on later explicit force calls and never retries
  the provider control automatically. Root teardown does not issue another
  control and keeps resources until a classified provider exit arrives. A typed
  unaccepted failure remains explicitly retryable.

Forced notifications use the last nonblank completed assistant message. A
whitespace-only completed message is treated as no completed message and uses
the explicit no-result marker. The notification does not include partial output,
tool traces, or shutdown instructions.

## Testing

`fake_provider.ts` provides `FakeAgentPreparer`, `FakeAgentLauncher`,
`FakeAgentLaunchHandle`, and `FakeAgentInputAdapter`. Tests use the **real**
session runtime and mailbox transport and fake only the provider boundary.

The fake adapter exposes explicit controls for ready, active, temporarily
unavailable, and idle states plus recorded received messages, so active
steering, queueing, FIFO drain order, idle turns, and each failure boundary are
exercised without timers or real model processes. Use deferred promises and
explicit state changes rather than sleeps.

`FakeAgentProviderLifecycleControls` does the same for shutdown. It counts
graceful, close-after-turn, and force invocations, records each graceful
instruction, can defer or fail any operation, can report an exit from inside
close-after-turn, and emits output activity, completed assistant messages, turn
completion, and classified exits on demand.

`FakeAgentManagerScheduler` replaces the production clock. Tests advance
simulated time with `advanceBy()` / `advanceTo()` to prove exact 120,000 ms
boundaries, repeated resets, and per-agent timer isolation without waiting two
minutes. It also keeps cancelled timer callbacks so a test can run a stale
callback deliberately and prove it is harmless.
