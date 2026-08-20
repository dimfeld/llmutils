# Persistent Codex Agent Provider

`startPersistentCodexAgent()` is the Codex side of the `AgentManager` provider
boundary. It keeps one private `codex app-server` process and one Codex thread
alive across many turns for a single named subagent.

This is a separate launch path. `executeCodexStep()` and
`executeCodexStepViaAppServer()` keep their existing signatures, modes, retry
rules, and one-shot lifetime. No ordinary Codex execution, `tim subagent` run,
formal `tim review`, or CLI fallback becomes persistent because of this code.

The provider-neutral manager, mailbox, and lifecycle policy are in
[agent-manager.md](agent-manager.md) and
[agent-messaging.md](agent-messaging.md). The app-server transport and the
dynamic agent-tool protocol are in
[codex-cli-integration.md](codex-cli-integration.md). The Claude equivalent of
this document is [persistent-claude-agent.md](persistent-claude-agent.md).

Like the rest of the `experimental.agentMessaging` stack, the provider exists but
no command activates it yet.

## Module layout

| File                                  | Contents                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `persistent_agent_contract.ts`        | Mode constant, provider-local states, completion facts, and the launch handle type   |
| `persistent_codex_session.ts`         | `startPersistentCodexAgent()` and the validate-before-allocate option checks         |
| `persistent_codex_session_runtime.ts` | `PersistentCodexSessionRuntime`: resources that outlive one turn, plus one close     |
| `persistent_codex_turn_controller.ts` | `PersistentCodexTurnController` and `PersistentCodexInputAdapter`: the state machine |
| `codex_agent_launcher.ts`             | `createCodexAgentLauncher()`: the `AgentLauncher` the manager calls                  |
| `app_server_notifications.ts`         | `normalizeCodexAppServerNotification()`: the one thread/turn/status field parser     |

The runtime owns the connection, output tunnel, subprocess monitor, and logical
thread node. The controller owns turn state, formatting, and every manager
callback. Splitting them keeps per-turn state out of the cleanup path.

## Mode selection

`mode: 'persistent-agent'` (`CODEX_PERSISTENT_AGENT_MODE`) is the only way to
create a reusable Codex provider, and only the persistent launcher passes it.
`validateCodexPersistentAgentLaunchOptions()` runs before any temp directory,
tunnel, socket, process node, or child process is allocated. It rejects:

- a missing or non-`subagent` identity, or a dynamic-tool provider whose bound
  caller is not that exact identity,
- a process label other than `formatAgentProcessLabel('codex-cli', name)`,
- `outputSchema` / `outputSchemaPath` — one agent keeps one thread identity,
- an explicit `appServerMode`, a one-shot `inactivityTimeoutMs`, or
  `terminalInput: true`,
- a missing lifecycle observer or dynamic-tool provider,
- app-server mode being disabled. The `codex exec` fallback cannot host a
  persistent provider.

## Three boundaries

1. **Launch readiness** — `startPersistentCodexAgent()` returns the handle. The
   manager can bind a ready mailbox here. Startup is still in progress.
2. **Input readiness** — `handle.ready` resolves only after the private
   app-server is initialized, the dynamic tools are installed, `thread/start`
   returned, the logical node is registered, and the first turn is submitted.
   Messages that arrive before this stay in the manager mailbox.
3. **Provider completion** — `handle.completion` settles exactly once with the
   classified exit and the last completed assistant message.

## Provider-local states

`CodexPersistentAgentState` is private to the adapter: `starting`,
`running-active-starting`, `running-active`, `running-idle`, `finishing`,
`stopping-gracefully`, `stopping-forced`, `terminal`. Do not copy these into
`ListAgents`. The manager maps provider facts onto its own
`starting`/`running`/`finishing`/`stopping` states, and active versus idle is
input availability, not a public lifecycle state.

`running-active-starting` exists because `turn/start` has been sent but no turn
ID is known yet, so steering is not safe.

## Input contract

`PersistentCodexInputAdapter` implements `AgentInputAdapter`. The AgentManager
mailbox is the only pending-input queue; the adapter holds no message array and
does not use the interactive `UserInputQueue`.

| Provider state                  | `deliver()` result        | Wire effect                        |
| ------------------------------- | ------------------------- | ---------------------------------- |
| `running-active`, turn ID known | `steered`                 | `turn/steer` with `expectedTurnId` |
| `running-idle`                  | `started-idle-turn`       | `turn/start` on the same thread    |
| any other state                 | `temporarily-unavailable` | nothing is sent                    |

Delivery is serialized: a second `deliver()` while one is in flight returns
`temporarily-unavailable` instead of racing the transition. A steer that races
`turn/completed`, or fails without proof of acceptance, is also
`temporarily-unavailable` — never a false acknowledgement. Every state change
runs `syncInputActivity()`, so the manager gets an availability notification and
re-drains the head of the FIFO in order.

Persistent mode installs no terminal, tunnel-user-input, or headless-user-input
callbacks. It still creates the output tunnel used by child tools and logging.

## Turn lifecycle

Each turn gets a generation number, an optional turn ID, a settled flag, and its
own assistant message. The turn ID may arrive from the `turn/start` response or
from a `turn/started` notification in either order; a conflict between the two
fails the provider instead of guessing.

Notifications are filtered to the owned thread, normalized by
`normalizeCodexAppServerNotification()`, and fed to one execution-scoped
formatter. Because the formatter's latest agent message is not turn-scoped, the
controller copies the message onto the current unsettled turn, so a later empty
or failed turn can never report a previous turn's text.

On `turn/completed` (or a guarded idle `thread/status/changed` fallback) the
controller claims the turn once, then:

1. reports `completedAssistantMessage()` when the turn produced non-empty text,
2. reports `turnComplete()`,
3. becomes `running-idle` and signals mailbox drain — the process, thread, and
   connection stay alive.

A non-`completed` status is a provider failure. Persistent turns are never
retried with the one-shot `continue` loop, because a failed turn may already
have accepted messages or tool side effects.

`outputActivity()` is reported for owned-thread notifications that prove
provider progress — `thread/started`, `thread/status/*`, `turn/*`, `item/*`,
`codex/event/*`, `llm/item/*`. Account events, token-usage updates, and the
agent's own echoed user-message items are excluded.

## Lifecycle controls

- **`requestCloseAfterCurrentTurn()`** (FinishAgent) records the request and
  returns immediately. Nothing is closed or interrupted inside the dynamic tool
  callback, so Codex can still return the tool result and its final message. The
  close runs once, after the completed assistant result and `turnComplete()`.
- **`requestGracefulShutdown(text)`** sends the manager-composed instruction
  through the same delivery rules: steer an active turn, start a final turn when
  idle, otherwise wait for a stable state. The accepted turn generation is
  marked, and the provider closes after that turn completes. There is no second
  inactivity timer in the adapter; the manager's timer is fed by
  `outputActivity()`.
- **`requestForcedShutdown()`** is one idempotent promise. It refuses new input,
  records the expected classification before any await, interrupts a known turn,
  and closes the connection. If `turn/start` is still pending, the interrupt
  intent is remembered and one best-effort `turn/interrupt` is sent when the late
  turn ID arrives. Force upgrades a pending finish or graceful request.

`CodexAppServerConnection.close()` performs transport shutdown and the owned
process SIGTERM-to-SIGKILL escalation. Neither the adapter nor the manager
signals a PID.

## Process tree

Persistent agents pass `privateOwner: true` to
`CodexAppServerConnection.create()`, so an inherited
`TIM_CODEX_APP_SERVER_SOCKET` cannot make two agents share one server. Legacy
modes keep inherited-socket selection.

Two nodes are registered per agent, as siblings under the owning `tim` process —
the session process model has no executor-under-executor nesting:

- `Codex app-server (<agent-name>)` — the owned process, with End and Terminate.
- `Codex thread (<agent-name>)` — a logical executor with command
  `codex thread <thread-id>` and the Codex thread ID.

Both End handlers route to the same idempotent graceful path, and every terminal
cleanup marks both nodes exited. Because the thread ID only exists after
`thread/start`, the manager calls `refreshHandleMetadata()` after binding so the
agent record picks up the process-control and thread IDs assigned after the
launch boundary.

## Cleanup and completion

`PersistentCodexSessionRuntime.close()` is a single run-once promise. In order it
stops the subprocess monitor, clears the graceful-end handler, closes the
connection, awaits any in-flight tunnel creation, marks the logical thread
exited, closes the tunnel, and removes the tunnel temp directory. Every step is
error-tolerant; a cleanup failure is combined with the primary error instead of
replacing it.

The expected-closing classification is set before any close so the connection's
`onExit` callback cannot report a false crash. Natural exit, self-finish,
graceful stop, forced stop, process-tree End, crash, transport failure, and root
teardown all converge on one classified `exit()` and one settled `completion`.
Late notifications, late JSON-RPC responses, repeated End requests, and repeated
close calls are ignored. AgentManager still owns terminal notification, mailbox
removal, registration cleanup, and name/slot release; the adapter never sends its
own terminal agent message.

## Testing

| File                                                  | Coverage                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| `persistent_codex_session.test.ts`                    | Option validation before allocation                              |
| `persistent_codex_session.state.test.ts`              | Turn state machine, delivery dispositions, races                 |
| `persistent_codex_session.integration.test.ts`        | Scripted app-server peer over the real session                   |
| `codex_agent_launcher.test.ts`                        | Launch adapter wiring and identity binding                       |
| `codex_agent_launcher.lifecycle.integration.test.ts`  | Finish, graceful, force, crash, and teardown through the manager |
| `codex_agent_launcher.production.integration.test.ts` | Two concurrent agents with the production `AgentManager`         |
| `app_server_notifications.test.ts`                    | Snake-case and camel-case thread/turn field compatibility        |

Tests script JSON-RPC responses and notifications explicitly and use the real
manager. No Codex account and no sleeps are required.
