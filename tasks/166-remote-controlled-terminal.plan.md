---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: headless mode
goal: ""
id: 166
uuid: 783bf184-9ec5-4919-bf30-8ae618785f0c
generatedBy: agent
status: done
priority: medium
parent: 160
references:
  "160": 514cedb9-6431-400a-a997-12d139376146
planGeneratedAt: 2026-02-07T21:27:08.375Z
promptsGeneratedAt: 2026-02-07T21:27:08.375Z
createdAt: 2026-01-12T06:36:28.922Z
updatedAt: 2026-02-08T00:24:47.019Z
tasks:
  - title: Define headless message protocol
    done: true
    description: "Create src/logging/headless_protocol.ts with extensible envelope
      types: HeadlessSessionInfoMessage (sent on every connect with command,
      planId, planTitle, workspacePath, gitRemote), HeadlessOutputMessage (wraps
      TunnelMessage), HeadlessReplayStartMessage, HeadlessReplayEndMessage.
      Export HeadlessMessage union type and HeadlessSessionInfo interface. Reuse
      TunnelMessage from tunnel_protocol.ts for the inner output data."
  - title: Create HeadlessAdapter class
    done: true
    description: "Create src/logging/headless_adapter.ts implementing LoggerAdapter.
      Constructor takes url, sessionInfo (HeadlessSessionInfo), and optional
      wrapped LoggerAdapter (defaults to ConsoleAdapter). Wraps adapter for
      local output. Buffers all output as serialized HeadlessOutputMessage
      strings. Manages WebSocket connection with states: disconnected,
      connecting, connected, draining. On connect: sends session_info, then
      replay_start, flushes buffer, sends replay_end. Uses pendingMessages array
      with single drainLoop for race-condition-free sending. Implements buffer
      cap (default 10MB, drops oldest). Reconnects on each write when
      disconnected (rate-limited to 5s between attempts). Provides destroy() for
      graceful shutdown and destroySync() for signal handlers."
  - title: Install HeadlessAdapter in agent and review commands
    done: true
    description: "In handleAgentCommand (src/tim/commands/agent/agent.ts) and
      handleReviewCommand (src/tim/commands/review.ts), after config is loaded:
      check !isTunnelActive(), gather session info (command name, plan ID/title
      from resolved plan, workspace path from getGitRoot(), git remote from 'git
      remote get-url origin'), resolve URL from TIM_HEADLESS_URL env var then
      config.headless.url then default ws://localhost:8123/tim-agent, create
      HeadlessAdapter with url/sessionInfo/currentAdapter, run rest of command
      with runWithLogger(headlessAdapter, ...), destroy adapter on cleanup."
  - title: Add headless config schema
    done: true
    description: "Add headless section to timConfigSchema in
      src/tim/configSchema.ts: headless: z.object({ url: z.string().optional()
      }).optional(). No defaults in schema per CLAUDE.md. Run bun run
      update-schemas to regenerate JSON schema."
  - title: Write HeadlessAdapter tests
    done: true
    description: "Create src/logging/headless_adapter.test.ts. Test: buffering
      without server (verify local output works, messages buffered), connection
      and buffer flush (use Bun.serve() WebSocket server, verify session_info
      sent first then replay markers then buffered messages), streaming after
      connection, disconnect and reconnect (verify session_info re-sent and
      buffer replayed), buffer cap (exceed max, verify oldest dropped), rapid
      message ordering, graceful shutdown via destroy(), no server available
      (verify no errors), session_info content verification. Follow patterns
      from tunnel_integration.test.ts."
  - title: Update README with headless mode documentation
    done: true
    description: "Add section to README.md documenting headless mode: always-on for
      agent/review commands when not tunneled, default URL
      ws://localhost:8123/tim-agent, TIM_HEADLESS_URL env var override,
      headless.url config option, buffer behavior, message protocol envelope
      format including session_info message sent on connect."
changedFiles:
  - README.md
  - docs/direct_mode_feature.md
  - docs/next-ready-feature.md
  - schema/tim-config-schema.json
  - schema/tim-plan-schema.json
  - src/logging/headless_adapter.test.ts
  - src/logging/headless_adapter.ts
  - src/logging/headless_protocol.ts
  - src/tim/assignments/auto_claim.test.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/compact.test.ts
  - src/tim/commands/import/issue_tracker_integration.test.ts
  - src/tim/commands/renumber.test.ts
  - src/tim/commands/review.notifications.test.ts
  - src/tim/commands/review.ts
  - src/tim/configSchema.test.ts
  - src/tim/configSchema.ts
  - src/tim/headless.test.ts
  - src/tim/headless.ts
  - test-plans/rmplan.yml
  - tim-gui/.swiftlint.yml
  - tim-gui/AGENTS.md
  - tim-gui/docs/index.md
  - tim-gui/docs/liquid-glass/appkit.md
  - tim-gui/docs/liquid-glass/overview.md
  - tim-gui/docs/liquid-glass/patterns.md
  - tim-gui/docs/liquid-glass/swiftui.md
  - tim-gui/docs/modern-swift.md
  - tim-gui/docs/swift-concurrency.md
  - tim-gui/docs/swift-testing-playbook.md
  - tim-gui/docs/toolbar/swiftui-features.md
tags: []
---

We have some method of exposing all the terminal output over a socket and also allowing terminal input into that socket. There is an existing
tunneling system by which a child process can send data to a parent process.  This is kind of different, since a
non-tunneling process needs to instead proactively send data to a parent server.

The way this will work is that there should be an HTTP websocket server, with a
default of `ws://localhost:8123/tim-agent`. Every time we write output, we should see if we are connected, and if so, send the output on the existing socket connection. If not, try to connect. Failing to connect should be a no-op, since it is possible that the listening process is not running. 

We only want to do this connection on long-running commands such as agent or review, and only when we are not running in tunneled mode already.

We should also buffer all of the output from the process so that when we connect initially, we can send all the existing output so far to the connection.

The design of this should ensure that we don't have race conditions when two logs come in very quickly back to back,
particularly when first connecting. We'll want to use some kind of singleton for the connection which can then buffer incoming output if it's currently sending output and then send the buffer after the existing send or connect is done.

This should use WebSocket connections (to support future bidirectional communication). The default URL is `ws://localhost:8123/tim-agent`.

## Expected Behavior/Outcome

When a long-running tim command (`agent` or `review`) starts and is not already in tunneled mode, it creates a `HeadlessAdapter` that wraps the normal `ConsoleAdapter`. This adapter:

1. **Outputs locally as usual** — all logging still goes to the console and log file.
2. **Buffers all output** from the start of the process.
3. **Attempts to connect** to a configurable WebSocket endpoint (default `ws://localhost:8123/tim-agent`).
4. **On successful connection**, sends all buffered output to the server, then streams subsequent output in real-time.
5. **On failed connection**, silently continues — the headless server may not be running, and that's fine.
6. **On disconnect**, buffers output again and retries connection on next write (rate-limited), replaying the buffer on reconnect.

### States
- **Disconnected/Buffering**: No WebSocket connection. All output buffered locally. Reconnect attempted on each write (rate-limited).
- **Connecting**: WebSocket handshake in progress. Output buffered.
- **Connected/Streaming**: WebSocket open. Buffer flushed, new output sent immediately.
- **Draining**: Process shutting down. Attempt to flush final output before closing.

## Key Findings

### Product & User Story
A headless monitoring server (e.g., TimGUI or a web dashboard) needs to observe what `tim agent` or `tim review` is doing in real-time, even when it didn't launch the process. This is different from the existing tunnel system where the parent process spawns the child and sets up the socket. Here, the tim process proactively reaches out to a server that may or may not be listening.

### Design & UX Approach
- The feature is **always on** for long-running commands (`agent`, `review`) when not in tunneled mode. No flag or config needed to enable.
- The default WebSocket URL is `ws://localhost:8123/tim-agent`, overridable via `TIM_HEADLESS_URL` env var or config.
- Connection failures are silent — no error messages pollute the output.
- The same `LoggerAdapter` interface is used, so all existing logging code works unchanged.
- Output is buffered from the start so the monitoring server gets full context even if it connects late or reconnects after a brief disconnection.
- Reconnection is attempted on every write when disconnected (no exponential backoff — just try on each write).

### Technical Plan & Risks
- **WebSocket library**: Bun has native WebSocket client support via `new WebSocket(url)` (browser-compatible API). This avoids adding a dependency.
- **Race conditions**: The adapter must serialize connection attempts and buffer flushes. A queue-based approach where `send()` appends to a buffer and a single async loop drains it prevents interleaving.
- **Buffer growth**: If the server is never available, the buffer grows unboundedly. Should cap at a reasonable size (e.g., 10MB) and drop oldest entries.
- **Interaction with existing tunnel**: When `isTunnelActive()` is true, the headless adapter should NOT be installed — the tunnel already forwards output to a parent process.

### Pragmatic Effort Estimate
This is a moderate-sized feature. The core adapter is straightforward since it follows the existing `LoggerAdapter` pattern. The main complexity is in the connection state machine and race-condition-free buffering.

## Acceptance Criteria

- [ ] Long-running commands (`agent`, `review`) always attempt to connect to a WebSocket endpoint (default `ws://localhost:8123/tim-agent`) when not in tunneled mode.
- [ ] All output is buffered from process start and replayed on initial connection.
- [ ] Connection failures are silent no-ops — no error output to the user.
- [ ] Rapid sequential log calls do not cause race conditions or message reordering.
- [ ] Buffer has a configurable max size; oldest messages are dropped when exceeded.
- [ ] The adapter properly cleans up the WebSocket on process exit.
- [ ] All new code paths are covered by tests.

## Dependencies & Constraints

- **Dependencies**: Relies on existing `LoggerAdapter` interface (`src/logging/adapter.ts`), `ConsoleAdapter` (`src/logging/console.ts`), and the `isTunnelActive()` check from `src/logging/tunnel_client.ts`.
- **Technical Constraints**: Must use Bun's native WebSocket client (no external dependency). Must not break existing tunnel behavior. Must handle the case where the WebSocket server is not running.

## Implementation Notes

### Recommended Approach
Create a new `HeadlessAdapter` class that implements `LoggerAdapter` and wraps `ConsoleAdapter`. It maintains a buffer of all output and manages a WebSocket connection with automatic reconnection. The adapter is installed in the `agent` and `review` command handlers when tunneling is not active.

### Potential Gotchas
- Bun's `WebSocket` is the browser-standard API, not the `ws` npm package. It uses event-based callbacks (`onopen`, `onmessage`, `onerror`, `onclose`).
- The `readyState` property on WebSocket can be checked synchronously but connection is async.
- Need to handle the case where `WebSocket` constructor itself throws (e.g., invalid URL).
- The WebSocket message format uses an extensible envelope: `{ type: "output", message: TunnelMessage }` for log output. This leaves room for future message types like `{ type: "prompt", ... }` for interactive prompts, `{ type: "status", ... }` for process state, etc.
- The adapter wraps `ConsoleAdapter` for local output, so it must call through to the wrapped adapter for every method.

## Research

### Overview
This feature adds a "headless mode" to tim's long-running commands. Unlike the existing tunnel system (where a parent process creates a Unix socket server and passes the path to child processes via `TIM_OUTPUT_SOCKET`), headless mode has the tim process proactively connect outward to an external WebSocket server. This enables monitoring tools to observe tim output without having spawned the process.

### Existing Logging Architecture

The logging system is built around a `LoggerAdapter` interface (`src/logging/adapter.ts`) with these methods:
- `log(...args)`, `error(...args)`, `warn(...args)`, `debugLog(...args)` — console-level logging
- `writeStdout(data)`, `writeStderr(data)` — direct stream writing

Adapters are bound to async execution contexts via `AsyncLocalStorage` (`adapterStorage`). The `runWithLogger(adapter, callback)` function sets the adapter for the duration of the callback. All logging functions in `src/logging.ts` (`log()`, `error()`, `warn()`, etc.) retrieve the current adapter from the storage and fall back to a default `ConsoleAdapter`.

### Existing Adapters

1. **`ConsoleAdapter`** (`src/logging/console.ts`): Writes to `console.log`/`console.error`/`console.warn` and to the log file via `writeToLogFile()`. This is the default.

2. **`TunnelAdapter`** (`src/logging/tunnel_client.ts`): Sends JSONL messages over a Unix domain socket. Also writes to the log file. Used when `TIM_OUTPUT_SOCKET` env var is set. Key behaviors:
   - `send()` writes `JSON.stringify(message) + '\n'` to the socket
   - Falls back to no-op if socket disconnects (`connected` flag)
   - `destroySync()` for synchronous cleanup, `destroy()` for async graceful shutdown

3. **`SilentAdapter`** (`src/logging/silent.ts`): Suppresses all output. Used in tests.

### Tunnel System Architecture

The existing tunnel system (`src/logging/tunnel_server.ts` and `tunnel_client.ts`) uses Unix domain sockets:
- **Server side**: `createTunnelServer(socketPath)` creates a `net.Server` listening on a Unix socket. It receives JSONL messages and dispatches them to the logging system via `dispatchMessage()`.
- **Client side**: `createTunnelAdapter(socketPath)` connects to the socket and returns a `TunnelAdapter`.
- **Detection**: `isTunnelActive()` checks if `TIM_OUTPUT_SOCKET` env var is set.
- **Message protocol**: `TunnelMessage` types — `TunnelArgsMessage` (log/error/warn/debug with string[] args) and `TunnelDataMessage` (stdout/stderr with string data). Serialized as JSONL.

### Entry Point — Tunnel Installation

In `src/tim/tim.ts` lines 1179-1197, the `run()` function checks for `TIM_OUTPUT_SOCKET`:
- If set: creates a `TunnelAdapter` and runs the CLI within `runWithLogger(tunnelAdapter, ...)`.
- If connection fails: clears the env var and falls back to normal console output.
- If not set: runs normally with the default `ConsoleAdapter`.

### Long-Running Commands

**Agent command** (`src/tim/commands/agent/agent.ts`):
- Entry: `handleAgentCommand(planFile, options, globalCliOptions)`
- Registered in `tim.ts` lines 519-588 via `createAgentCommand()`
- Uses standard `log()`, `warn()`, `error()` throughout
- Opens its own log file via `openLogFile()`

**Review command** (`src/tim/commands/review.ts`):
- Entry: `handleReviewCommand(planFile, options, command)`
- Line 269: Checks `isTunnelActive()` to decide whether to install custom loggers for `--print` mode
- Uses standard logging functions throughout

### Configuration System

Config is defined in `src/tim/configSchema.ts` using Zod schemas. Key patterns:
- **No defaults in schemas** (per CLAUDE.md) — defaults applied in `getDefaultConfig()` or at read sites
- Schema is `timConfigSchema`, output type is `TimConfig`
- Config loaded via `loadEffectiveConfig()` in `src/tim/configLoader.ts`
- Schema has sections for various features: `notifications`, `paths`, `executors`, `review`, `planning`, etc.

### Key Files Reference

| File | Purpose |
|------|---------|
| `src/logging/adapter.ts` | `LoggerAdapter` interface, `AsyncLocalStorage`, `runWithLogger()` |
| `src/logging/console.ts` | `ConsoleAdapter` — default console + file logging |
| `src/logging/tunnel_client.ts` | `TunnelAdapter`, `isTunnelActive()`, `createTunnelAdapter()` |
| `src/logging/tunnel_server.ts` | `createTunnelServer()`, message dispatch |
| `src/logging/tunnel_protocol.ts` | `TunnelMessage` types, serialization |
| `src/logging/common.ts` | Log file management (`openLogFile`, `writeToLogFile`, `closeLogFile`) |
| `src/logging.ts` | Public logging API (`log`, `error`, `warn`, etc.) |
| `src/tim/tim.ts` | CLI entry, tunnel adapter installation (lines 1179-1197) |
| `src/tim/commands/agent/agent.ts` | Agent command handler |
| `src/tim/commands/review.ts` | Review command handler |
| `src/tim/configSchema.ts` | Config schema and `getDefaultConfig()` |
| `src/tim/configLoader.ts` | `loadEffectiveConfig()` |
| `src/logging/tunnel_integration.test.ts` | Integration tests for tunnel system (good pattern reference) |

### Bun WebSocket Client

Bun supports the standard browser `WebSocket` API natively. Usage:
```typescript
const ws = new WebSocket('ws://localhost:8123/tim-agent');
ws.onopen = () => { /* connected */ };
ws.onmessage = (event) => { /* received data */ };
ws.onerror = (event) => { /* error */ };
ws.onclose = (event) => { /* closed */ };
ws.send(data); // send string or binary data
ws.close(); // close connection
ws.readyState; // WebSocket.CONNECTING, OPEN, CLOSING, CLOSED
```

No external dependency needed.

## Implementation Guide

### Step 1: Define the headless message protocol

**File**: `src/logging/headless_protocol.ts`

Define an extensible envelope type for WebSocket messages:

```typescript
// Session info sent on every connect/reconnect, before any output
interface HeadlessSessionInfoMessage {
  type: 'session_info';
  command: string;          // e.g. 'agent' or 'review'
  planId?: number;          // the plan ID being operated on
  planTitle?: string;       // the plan title
  workspacePath?: string;   // absolute path to the workspace/repo
  gitRemote?: string;       // git remote URL (origin)
}

// Output messages wrap the existing TunnelMessage type
interface HeadlessOutputMessage {
  type: 'output';
  message: TunnelMessage;
}

// Replay markers
interface HeadlessReplayStartMessage { type: 'replay_start'; }
interface HeadlessReplayEndMessage { type: 'replay_end'; }

// Future message types can be added here, e.g.:
// interface HeadlessPromptMessage { type: 'prompt'; ... }

type HeadlessMessage =
  | HeadlessSessionInfoMessage
  | HeadlessOutputMessage
  | HeadlessReplayStartMessage
  | HeadlessReplayEndMessage;
```

This reuses the existing `TunnelMessage` types from `src/logging/tunnel_protocol.ts` for the actual log data, wrapped in an envelope that identifies the message category. Each WebSocket `send()` call sends one JSON-serialized `HeadlessMessage`.

**On every connect/reconnect**, the sequence is:
1. Send `session_info` — identifies which command, plan, workspace, and git remote this process is for.
2. Send `replay_start` — signals that buffered history follows.
3. Send all buffered `output` messages.
4. Send `replay_end` — signals that live streaming begins.

The `session_info` is sent on every connection (not just the first), so the server always knows context even after a reconnect. The `HeadlessAdapter` constructor accepts a `HeadlessSessionInfo` object containing the command, plan, and workspace details, which are gathered by the command handler before creating the adapter.

### Step 2: Create the HeadlessAdapter class

**File**: `src/logging/headless_adapter.ts`

Create a new `HeadlessAdapter` class implementing `LoggerAdapter` that wraps a `ConsoleAdapter`. Constructor signature: `new HeadlessAdapter(url: string, sessionInfo: HeadlessSessionInfo, wrappedAdapter?: LoggerAdapter)`.

The adapter has these responsibilities:

1. **Delegates all logging to the wrapped adapter** (defaults to `ConsoleAdapter`) so local output works normally.
2. **Buffers all output** as serialized `HeadlessOutputMessage` strings.
3. **Manages a WebSocket connection** to an external server.
4. **Sends `session_info` on every connect/reconnect** with the command, plan, workspace path, and git remote, followed by replay of the buffer.

**Connection state machine**:
- Start in `disconnected` state.
- On first log call (or on construction), attempt to connect.
- While connecting, buffer all messages.
- On open, send `session_info`, then `replay_start`, flush the buffer, send `replay_end`, then switch to streaming mode.
- On close/error, switch back to disconnected, start buffering again.
- On process exit, attempt to flush and close gracefully.

**Key design for race-condition prevention**:
Use a simple approach: all messages go into a `pendingMessages: string[]` array. A single `drainLoop` promise chains sends sequentially. When a message is added:
1. Push to `pendingMessages`.
2. If `drainLoop` is not running and WebSocket is open, start it.
3. `drainLoop` shifts messages one-by-one from `pendingMessages` and calls `ws.send()`.
4. When `pendingMessages` is empty, `drainLoop` stops.

This ensures ordering and prevents race conditions because there's only one writer.

**Buffer cap**: Keep a `maxBufferSize` (default 10MB). Track total buffer size. When exceeded, drop oldest messages. This prevents unbounded memory growth when the server is never available.

**Reconnection**: On every write, if disconnected and not currently connecting, attempt to reconnect. This is simple and ensures we reconnect as soon as there's new output. Use a minimum interval (e.g., 5 seconds) between connection attempts to avoid hammering the server on rapid writes. The connection attempt is fire-and-forget — the write is buffered regardless.

Reference: Follow the patterns in `src/logging/tunnel_client.ts` for the adapter interface implementation and `src/logging/tunnel_protocol.ts` for message types.

### Step 3: Install the HeadlessAdapter in command handlers

**Files**: `src/tim/commands/agent/agent.ts`, `src/tim/commands/review.ts`

In `handleAgentCommand` and `handleReviewCommand`, early in the function (before main work begins):
1. Check `!isTunnelActive()`.
2. If not tunneled, gather session info: command name (`'agent'` or `'review'`), plan ID and title (from the resolved plan file), workspace path (from `getGitRoot()` or `process.cwd()`), git remote URL (from `git remote get-url origin`, failing silently if not available).
3. Resolve the URL in priority order: `TIM_HEADLESS_URL` env var > `config.headless.url` > default `ws://localhost:8123/tim-agent`.
4. Create a `HeadlessAdapter` with the URL, session info, and the current adapter.
5. Run the rest of the command within `runWithLogger(headlessAdapter, ...)`.
6. On cleanup, call `headlessAdapter.destroy()`.

No CLI flags are needed — headless is always on for these commands when not tunneled.

**Config schema addition** (`src/tim/configSchema.ts`): Add a minimal `headless` section:
```
headless: z.object({
  url: z.string().optional().describe('WebSocket URL for headless output streaming'),
}).optional()
```
Per CLAUDE.md, do not set defaults in the schema. The default URL is applied at read time in the command handlers. Also run `bun run update-schemas` to regenerate the JSON schema.

### Step 4: Write tests

**File**: `src/logging/headless_adapter.test.ts`

Test cases to cover:
1. **Buffering without server**: Create adapter, log several messages, verify they're buffered and local output still works.
2. **Connection and flush**: Start a local WebSocket server in the test, create adapter, log messages before connection, verify all buffered messages arrive after connection.
3. **Streaming after connection**: After connection is established, log new messages and verify they arrive promptly.
4. **Disconnect and reconnect**: Connect, disconnect the server, log messages (should buffer), restart server, verify buffered messages arrive.
5. **Buffer cap**: Log enough messages to exceed the buffer cap, verify oldest are dropped.
6. **Race conditions**: Send many messages rapidly, verify ordering is preserved.
7. **Graceful shutdown**: Call `destroy()`, verify pending messages are flushed.
8. **No server available**: Verify adapter works normally (local output) when no server exists.
9. **Replay markers**: Verify `replay_start` and `replay_end` messages bracket the buffer replay on connect/reconnect.

For the test WebSocket server, Bun has `Bun.serve()` with WebSocket support built in.

### Step 5: Update the README

Add a section documenting the headless mode feature:
- What it does (always-on output streaming for agent/review commands)
- Default URL (`ws://localhost:8123/tim-agent`)
- How to override the URL via `TIM_HEADLESS_URL` env var or `headless.url` in config
- Buffer behavior

### Manual Testing Steps

1. Start a simple WebSocket echo server: `bun -e "Bun.serve({ port: 8123, fetch(req, server) { if (server.upgrade(req)) return; return new Response('OK'); }, websocket: { open(ws) { console.log('connected'); }, message(ws, msg) { console.log('received:', msg); }, close(ws) { console.log('closed'); } } })"`
2. Run `tim agent <planId>` and verify messages appear on the server.
3. Start `tim agent` without the server running, verify no errors.
4. Start the server mid-run, verify buffered output arrives.
5. Kill the server mid-run, verify tim continues without errors.

### Rationale

- **Wrapping ConsoleAdapter rather than replacing it**: Local output must always work. The headless connection is supplementary.
- **Reusing TunnelMessage protocol**: Consistency with the existing tunnel system. The monitoring server can share parsing logic.
- **WebSocket over raw TCP/Unix socket**: Future bidirectional communication (e.g., sending commands back to the agent). WebSocket also works over HTTP which is easier to proxy, firewall, and debug.
- **Command-level installation rather than top-level**: Headless mode only makes sense for long-running commands. Installing it for quick commands like `tim list` would be wasteful.

## Current Progress
### Current State
- `tim review` headless cleanup now guards `headlessAdapter.destroy()` in `finally` so adapter cleanup failures do not suppress notifications or hide the original review error.
- README headless documentation now explicitly says `tim review --print` installs a separate output adapter for executor capture.
- Headless URL resolution now treats invalid non-`ws://`/`wss://` values as misconfiguration and falls back to the default endpoint.
- `review` documents why it uses explicit headless adapter lifecycle management instead of the helper wrapper.
- Reviewer-requested documentation/comments/test-latency follow-ups for this iteration are applied.

### Completed (So Far)
- Implemented the headless protocol and adapter, with reconnect/replay behavior and coverage.
- Installed headless command helpers and command wiring for `agent` and `review`, plus config schema support and README documentation.
- Applied reviewer follow-up test hardening in `headless_adapter` tests.
- Refactored `review` headless context management from `enterWith` mutation to scoped `runWithLogger` execution.
- Added coverage that `handleReviewCommand` does not call `createHeadlessAdapterForCommand` when already running inside a `HeadlessAdapter` logger context.
- Added direct review-command integration coverage for standalone headless creation/cleanup behavior.
- Wrapped review-command headless adapter teardown in a defensive `try/catch` in `finally`.
- Clarified README note for why headless streaming is disabled in `tim review --print`.
- Documented README headless defaults for the 10MB replay buffer cap and the 5-second reconnect interval.
- Added a `destroy()` control-flow comment in `HeadlessAdapter` clarifying the disconnect-during-drain fast-cleanup path.
- Updated `headless` URL tests for fallback behavior and changed `createHeadlessAdapterForCommand` test URL to `ws://127.0.0.1:9/tim-agent` to avoid slow default destroy timing.

### Remaining
- None.

### Next Iteration Guidance
- Keep command-level headless installation using helper APIs (`createHeadlessAdapterForCommand` / `runWithLogger`) and avoid direct async-local storage mutation in command handlers.
- Maintain explicit tunnel-aware behavior in tests so standalone-headless and tunneled paths stay deterministic.
- If cleanup contracts change, preserve the invariant that notification delivery is best-effort even when headless teardown fails.

### Decisions / Changes
- Kept headless behavior best-effort and non-fatal for invalid/unreachable endpoints.
- Replaced the targeted `finally` adapter-restore workaround with a scoped logger-context pattern aligned with `agent` command behavior.
- Preserved existing print-mode logging behavior and tunnel gating.
- Kept review-specific lifecycle management but made cleanup non-blocking for post-review notifications.
- Invalid configured headless URLs now fall back to the default URL instead of repeatedly attempting known-bad schemes.

### Risks / Blockers
- None

## Unresolved Review Issues

### Tasks Worked On

- Define headless message protocol
- Create HeadlessAdapter class
- Write HeadlessAdapter tests

### Review Output

# Code Review Report
**Plan:** 166 - headless mode
**Date:** 2/7/2026, 1:24:40 PM
**Base Branch:** main

## Summary
- **Total Issues:** 5
- **Files Reviewed:** 4

### Issues by Severity
- Critical: 0
- Major: 1
- Minor: 4
- Info: 0

### Issues by Category
- Performance: 1
- Bug: 1
- Testing: 3

## Issues Found
### Major Issues

#### 1. The test 'destroySync() closes a real open socket without throwing' (line 775) is flaky. It relies on `waitFor(() => (adapter as any).socket?.readyState === WebSocket.OPEN)` with a 3-second timeout, which failed during our test run with 'Timed out waiting for condition'. The test creates a real WebSocket connection and depends on the connection establishing within the timeout, which is sensitive to system load and test runner overhead (especially in verbose mode). Similarly, the reconnect rate-limiting test (line 555) uses tight timing margins — a 50ms sleep (line 575) before asserting no reconnection happened, and `reconnectIntervalMs + 20` ms wait (line 578) before asserting reconnection did happen. Under system load, these margins may be insufficient.
**Category:** testing
**File:** src/logging/headless_adapter.test.ts:575-580, 775-795


**Suggestion:** For the flaky `destroySync` test, consider adding a retry or increasing the waitFor timeout. For the reconnect rate-limiting test, increase the margins (e.g., 150ms instead of 50ms for the burst window, and +100ms instead of +20ms for the interval wait). Alternatively, make the reconnect interval controllable and use a larger value (like 500ms) with proportionally larger margins.

### Minor Issues

#### 1. The reconnect test (line 386, 'replays buffered output after disconnect and reconnect') verifies that post-reconnect live messages have higher sequence numbers than replayed messages, but does not explicitly assert that the live message `post-reconnect-live` appears *after* the `replay_end` marker in the raw server message stream. The test filters to `type === 'output'` only (line 449-453), discarding control messages. A consumer of this protocol needs the guarantee that live messages come after `replay_end` — the test should verify this positional relationship directly.
**Category:** testing
**File:** src/logging/headless_adapter.test.ts:449-461


**Suggestion:** Add an assertion that finds the index of `replay_end` and the index of the `post-reconnect-live` output message in the unfiltered `server.messages` array, and asserts the output index is greater than the replay_end index.

#### 2. The 'flushes output written while destroy() is draining' test (line 662) calls `adapter.writeStdout('written-during-destroy\n')` after `await waitFor(() => (adapter as any).state === 'draining')`, but this `waitFor` may return immediately since `destroy()` sets `state = 'draining'` synchronously on line 115 before any `await`. The actual intent is to write a message while the drain loop is actively sending buffered output. If the drain loop finishes before the test's `writeStdout` call, the test would still pass but wouldn't be testing the intended scenario (writing during active drain). The test also does `await waitFor(() => outputs.length >= total + 1)` *after* `await destroyPromise`, but `destroy()` closes the socket before returning — the server-side message array should already be populated by that point, making this waitFor either instant or relying on Bun's server-side buffering.
**Category:** testing
**File:** src/logging/headless_adapter.test.ts:662-701


**Suggestion:** This test could be made more robust by verifying the adapter's internal state shows the drain loop was active when the write occurred. Consider logging internal state or using a larger buffer to ensure the drain is still in progress when the mid-drain write happens.

#### 3. In `destroy()` (line 113-144), when the socket is in CONNECTING state, `waitForSocketConnect` is called with `connectWaitMs = Math.floor(timeoutMs / 2)`. If `waitForSocketConnect` times out (i.e., the socket never opens or errors), execution falls through to line 123 which checks `this.socket.readyState !== WebSocket.OPEN`. If the socket is *still* CONNECTING after the timeout, the code calls `this.socket.close()` (line 125). Then line 131 checks `this.socket.readyState === WebSocket.OPEN` — this is false, so the drain is skipped entirely. This is correct behavior. However, there's a subtle issue: after calling `this.socket.close()` on a CONNECTING socket, the `onclose` handler (line 243) will fire, calling `handleDisconnect` which sets `this.socket = undefined`. But `destroy()` already sets `this.socket = undefined` on line 142. This double-cleanup is harmless but worth noting. More importantly, if the `onopen` callback fires *after* `waitForSocketConnect` times out but *before* line 123 executes (during a microtask yield), the socket transitions to OPEN, and line 123's condition `readyState !== OPEN` becomes false. Then line 131 picks it up correctly and drains. This edge case is handled correctly.
**Category:** bug
**File:** src/logging/headless_adapter.ts:113-144


**Suggestion:** No action needed — this is handled correctly. Noted for completeness.

#### 4. In `enforceBufferLimit` (line 178-198), when history exceeds the max buffer size, entries are dropped from the front of `history` using `shift()` (O(n) array operation), and for each dropped entry, a linear scan of `queue` is done via `findIndex` (O(n)). If the buffer cap is hit frequently with a large buffer, this becomes O(n²). For the default 10MB buffer this is unlikely to be a practical concern, but with many small messages the arrays could grow large before hitting the byte cap.
**Category:** performance
**File:** src/logging/headless_adapter.ts:178-198


**Suggestion:** Acceptable for now given the 10MB default and the fact that this is supplementary logging infrastructure. If performance becomes a concern, consider using a circular buffer or linked list.

## Recommendations
- The protocol design is solid — extensible envelope type, sequence numbers that survive reconnections, and clear replay markers. The state machine and generation-based drain loop invalidation are well-designed.
- The race condition analysis shows the code is carefully written with the synchronous shift-after-send invariant (line 314-315 before the await on line 316) being critical to correctness. This invariant should have a more prominent comment explaining that violating it would corrupt the queue/history shared-reference relationship.
- Consider adding an explicit integration-style test that verifies the full reconnect→handshake→live-streaming sequence from the server's perspective, asserting on the raw message ordering including control messages (session_info, replay_start, replay_end) interspersed with output messages.

## Action Items
- [ ] Fix the flaky test 'destroySync() closes a real open socket without throwing' — increase timeout or add retry logic to handle slow WebSocket connections under load.
- [ ] Increase timing margins in the reconnect rate-limiting test (line 555) to avoid flakiness under CI load — use wider margins for the burst window check (line 575) and the post-interval check (line 578).
- [ ] Add an assertion in the reconnect test (line 386) verifying that `post-reconnect-live` appears after `replay_end` in the unfiltered server message array, not just that it has a higher sequence number.

## Unresolved Review Issues

### Tasks Worked On

- Install HeadlessAdapter in agent and review commands
- Add headless config schema
- Update README with headless mode documentation

### Review Output

# Code Review Report
**Plan:** 166 - headless mode
**Date:** 2/7/2026, 2:24:42 PM
**Base Branch:** main

## Summary
- **Total Issues:** 4
- **Files Reviewed:** 32

### Issues by Severity
- Critical: 0
- Major: 0
- Minor: 4
- Info: 0

### Issues by Category
- Bug: 1
- Compliance: 1
- Other: 2

## Issues Found
### Minor Issues

#### 1. In src/tim/commands/agent/agent.ts:216-225, when a plan file is specified directly, the fallback readPlanFile call catches all errors silently (line 223 `catch {}`), swallowing potential file-not-found or invalid YAML errors. While functionally harmless since timAgent() will validate the file later, this silent catch can make debugging confusing if the plan file path is subtly wrong.
**Category:** bug
**File:** src/tim/commands/agent/agent.ts:216-225


**Suggestion:** Add a debug log inside the catch block to aid troubleshooting. The silent catch is acceptable since timAgent() will provide the real error.

#### 2. The headless adapter is only installed via runWithLogger for the inner executeReviewFlow callback (line 1036), not for the plan resolution output that occurs earlier (lines 338-368). Similarly in agent.ts, only output inside timAgent() is captured, not the plan resolution output before it. The plan states 'all output is buffered from process start' but the implementation only captures output from inside the long-running command body. Early plan selection messages like 'Auto-selected plan: ...' are not streamed.
**Category:** other
**File:** src/tim/commands/review.ts:374-1039


**Suggestion:** If full output capture is desired, install the headless adapter earlier — before plan resolution. The current approach may be intentional since the core review/agent work is where most output occurs. Document the decision if keeping current behavior.

#### 3. In src/tim/commands/review.ts:381-388, readPlanFile is called solely to extract id and title for the headless session info. This same plan file will be read again inside gatherPlanContext (called at line 402 within executeReviewFlow). This is a redundant file read — minor since it's local I/O.
**Category:** other
**File:** src/tim/commands/review.ts:381-388


**Suggestion:** Acceptable as-is given the design constraints (adapter must be created before the flow to capture output). The double-read is negligible.

#### 4. The headless config object uses .strict() (line 116 of configSchema.ts), but no other top-level config sections use .strict(). This inconsistency means unknown fields in headless will cause validation errors while unknown fields in other sections are silently ignored.
**Category:** compliance
**File:** src/tim/configSchema.ts:116


**Suggestion:** Either remove .strict() for consistency with the rest of the schema, or document why headless is intentionally stricter.

## Recommendations
- The protocol and adapter design is solid — extensible envelope types, sequence numbers surviving reconnections, and clear replay markers. The implementation correctly fulfills the three plan tasks under review.
- The review command's manual headless lifecycle management (instead of using runWithHeadlessAdapterIfEnabled) is well-justified by the comment at lines 375-377 and properly handles cleanup in the finally block before notifications.
- The agent command's integration is clean — it wraps the entire timAgent call via runWithHeadlessAdapterIfEnabled, which handles both the normal and error paths correctly with destroy in a finally block.
- Config schema tests appropriately cover the new headless section including the .strict() behavior validation.

## Action Items
- [ ] Consider removing .strict() from the headless config schema object to match the pattern used by all other config sections, or add a comment explaining the intentional inconsistency.
- [ ] Consider adding a debug-level log in the fallback readPlanFile catch block in agent.ts (line 223) to aid troubleshooting when plan metadata extraction fails silently.
