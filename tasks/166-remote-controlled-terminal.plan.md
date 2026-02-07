---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: headless mode
goal: ""
id: 166
uuid: 783bf184-9ec5-4919-bf30-8ae618785f0c
generatedBy: agent
status: pending
priority: medium
parent: 160
references:
  "160": 514cedb9-6431-400a-a997-12d139376146
planGeneratedAt: 2026-02-07T21:27:08.375Z
promptsGeneratedAt: 2026-02-07T21:27:08.375Z
createdAt: 2026-01-12T06:36:28.922Z
updatedAt: 2026-02-07T21:27:08.376Z
tasks:
  - title: Define headless message protocol
    done: false
    description: "Create src/logging/headless_protocol.ts with extensible envelope
      types: HeadlessSessionInfoMessage (sent on every connect with command,
      planId, planTitle, workspacePath, gitRemote), HeadlessOutputMessage (wraps
      TunnelMessage), HeadlessReplayStartMessage, HeadlessReplayEndMessage.
      Export HeadlessMessage union type and HeadlessSessionInfo interface. Reuse
      TunnelMessage from tunnel_protocol.ts for the inner output data."
  - title: Create HeadlessAdapter class
    done: false
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
    done: false
    description: "In handleAgentCommand (src/tim/commands/agent/agent.ts) and
      handleReviewCommand (src/tim/commands/review.ts), after config is loaded:
      check !isTunnelActive(), gather session info (command name, plan ID/title
      from resolved plan, workspace path from getGitRoot(), git remote from 'git
      remote get-url origin'), resolve URL from TIM_HEADLESS_URL env var then
      config.headless.url then default ws://localhost:8123/tim-agent, create
      HeadlessAdapter with url/sessionInfo/currentAdapter, run rest of command
      with runWithLogger(headlessAdapter, ...), destroy adapter on cleanup."
  - title: Add headless config schema
    done: false
    description: "Add headless section to timConfigSchema in
      src/tim/configSchema.ts: headless: z.object({ url: z.string().optional()
      }).optional(). No defaults in schema per CLAUDE.md. Run bun run
      update-schemas to regenerate JSON schema."
  - title: Write HeadlessAdapter tests
    done: false
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
    done: false
    description: "Add section to README.md documenting headless mode: always-on for
      agent/review commands when not tunneled, default URL
      ws://localhost:8123/tim-agent, TIM_HEADLESS_URL env var override,
      headless.url config option, buffer behavior, message protocol envelope
      format including session_info message sent on connect."
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
