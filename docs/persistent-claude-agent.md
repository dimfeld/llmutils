# Persistent Claude Agent Provider

`runClaudeSubprocess()` has two execution modes. The default mode is the
existing one-shot run. The explicit `mode: 'persistent-agent'` selects a Claude
provider that keeps one stream-json subprocess alive across many turns for
`AgentManager`.

This document describes the Claude side of that boundary. The provider-neutral
manager, mailbox, and lifecycle policy are in
[agent-manager.md](agent-manager.md) and
[agent-messaging.md](agent-messaging.md). The stdin rules that both modes share
are in [executor-stdin-conventions.md](executor-stdin-conventions.md).

The persistent provider exists but no command activates it yet, exactly like the
rest of the `experimental.agentMessaging` stack.

## Module layout

| File                                       | Contents                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `persistent_agent_contract.ts`             | Mode constant, provider-local states, completion facts, launch handle, validators |
| `streaming_input.ts`                       | `PersistentClaudeInputWriter`: one serialized, failure-aware stream-json writer  |
| `persistent_agent_lifecycle.ts`            | `PersistentClaudeTurnController`: turn boundary and `AgentInputAdapter`          |
| `persistent_terminal_input_lifecycle.ts`   | The persistent branch of `executeWithTerminalInput()`                            |
| `persistent_claude_session.ts`             | `PersistentClaudeSessionRuntime`: lifecycle controls, completion, finalization   |
| `claude_execution_cleanup.ts`              | `createOrderedClaudeCleanup()`: ordered, run-once resource release               |
| `test-fixtures/stream-json-claude-fixture.mjs` | Local stream-json subprocess used by integration tests                      |

## Mode selection

`mode: 'persistent-agent'` is the only way to create a reusable Claude provider.
Never infer the mode from `terminalInput`, tunnel or headless input, MCP
presence, a process label, an environment variable, or
`experimental.agentMessaging`. `runClaudeSubprocess()` is overloaded, so one-shot
callers keep `Promise<RunClaudeSubprocessResult>` and never see a union.

`--no-session-persistence` stays on the Claude command line in both modes. It
controls Claude's on-disk session storage, which is unrelated to keeping one live
subprocess.

## Three boundaries

Keep these separate. Merging any two of them reproduces the one-shot bug.

1. **Launch readiness** — the subprocess and its stream-json writer exist. The
   handle is returned here; `runClaudeSubprocess()` does not await process exit.
2. **Turn completion** — Claude emits and settles a `result`. The provider
   becomes idle and messageable. This is not completion.
3. **Provider completion** — the subprocess exits or startup fails. The
   `completion` promise settles exactly once with the exit facts.

## Provider-local states

`ClaudePersistentAgentState` is private to the adapter: `spawning`, `active`,
`result-pending-background`, `idle`, `finish-after-result`,
`graceful-stop-active`, `closing`, `exited`, `failed`. Do not copy these into the
public `ListAgents` schema. The manager maps provider facts onto its own
`starting`/`running`/`finishing`/`stopping` states, and active versus idle is
input availability, not a public lifecycle state.

## Input contract

`PersistentClaudeTurnController` implements `AgentInputAdapter`. It sits above
one `PersistentClaudeInputWriter`, which is the only object that touches the
`FileSink`.

- Delivery to an active turn returns `steered`, and only after the stream write
  is accepted.
- Delivery to an idle provider claims the turn **synchronously** — the state
  changes to active and the generation increments before any await — then returns
  `started-idle-turn`. Two concurrent idle sends cannot start two turns.
- A starting, busy, closing, or failed writer returns `temporarily-unavailable`.
  The manager's bounded mailbox FIFO keeps the message and reports `queued`. The
  adapter publishes an availability change so the drain retries in order.
- **The mailbox is the only queue.** The writer never buffers rejected content,
  and the adapter never holds a provider-local queue.
- The writer normalizes synchronous and asynchronous `FileSink.write()` results,
  serializes one write at a time, closes once through `safeEndStdin()`, and
  rejects later writes with `ClaudePersistentInputClosedError`.

`buildSingleUserInputMessageLine()` stays the canonical encoding for both modes.
`sendInitialPrompt()` and `sendFollowUpMessage()` keep their existing
fire-and-forget signatures for one-shot callers.

## Turn lifecycle

Each turn owns one `BackgroundActivityTracker`. A continuation creates a fresh
tracker, so the one-shot tracker semantics — drain grace and stall limits — stay
unchanged.

- A settled result with no background work moves the provider to idle. Stdin and
  the subprocess stay open and `completion` stays pending.
- A result with active background work is provisional
  (`result-pending-background`). Later assistant, user, or background output
  returns the provider to active and clears the accepted result for that turn.
  The turn settles only when the existing drain rules accept it.
- A turn generation guards every asynchronous path. A late write failure can
  never restore stale state over a newer turn, an exit, or a force stop.

## Lifecycle controls

The handle exposes `AgentProviderLifecycleControls` only. Raw stdin, the process
handle, and the PID never cross this boundary.

- `requestCloseAfterCurrentTurn()` backs FinishAgent. It sets a flag; stdin
  closes at the next settled result, so the MCP tool response and the final
  assistant message still complete. Never close stdin inside the MCP handler.
- `requestGracefulShutdown(instruction)` sends one shutdown instruction through
  the same writer — starting a turn when idle, steering when active — and marks
  that turn close-after-result. Repeated calls are idempotent and never create a
  second shutdown turn.
- `requestForcedShutdown()` uses the `SessionExecutorLifecycle` capability
  captured from `onSessionProcessReady()` and its fresh PID/PPID/command/`lstart`
  identity checks (see
  [os-process-interaction.md](os-process-interaction.md)). It never signals a
  caller-supplied PID and never selects a process by display label. Repeated
  calls and a graceful-to-force upgrade are harmless.
- `subscribe(observer)` reports `outputActivity()`, `completedAssistantMessage()`,
  `turnComplete()`, and one `exit()`. The two-minute inactivity policy,
  escalation, terminal notification, and deduplication belong to the manager, not
  to this adapter.

## Output, metadata, and formatting

- Every stdout and stderr chunk calls `onOutputActivity`. `spawnWithStreamingIO()`
  wraps the callback, so a throw or a rejected promise is logged and never ends a
  reader.
- Only fully parsed assistant records and settled result text become lifecycle
  metadata. Decoder fragments, tool use, tool results, status updates, thinking
  output, and stderr text are never a completed assistant message.
- Persistent runs suppress the per-result `agent_session_end` structured message
  and emit the session-end event once, at provider completion. One-shot result
  formatting and its snapshots are unchanged.
- `ClaudePersistentAgentCompletion` carries the exit code, signal, inactivity
  flag, settled result text, and the last completed assistant message.

## Timers

The generic stdout/stderr inactivity kill would eventually kill a healthy idle
agent, so persistent runs pass `disableInactivityKill`. Graceful-stop inactivity
is the manager's policy, driven by the output-activity events above. One-shot
timeout defaults are untouched.

## Cleanup and completion

`createOrderedClaudeCleanup()` owns every per-run resource in one run-once,
ordered sequence: input controller, signal and lifecycle handlers, subprocess
monitor, tunnel server, per-execution temporary directory, and the MCP bridge.
Each step runs even after an earlier failure, and the first error is reported.

Input is marked closed before any sink closes, so a late output callback or
mailbox drain cannot write to a released resource. The completion promise settles
once — for natural exit, startup failure, stream failure, graceful close, and
force stop — after the cleanup-relevant facts are captured. Cleaning up one agent
never touches another: formatter state, writer, tracker, MCP and tunnel
resources, temp directory, labels, observers, and completion are all
execution-scoped.

## Testing

- State-machine behavior uses injected sinks and fake timers.
- `run_claude_subprocess.integration.test.ts` runs the real runner against
  `test-fixtures/stream-json-claude-fixture.mjs` through the `claudeExecutable`
  seam — real pipes, real readers, real mailboxes — including two concurrent
  agents, background-deferred results, and an unexpected exit while idle.
- No test requires network access or an Anthropic account. Do not replace the
  common process module with a broad mock; inject the executable instead.
