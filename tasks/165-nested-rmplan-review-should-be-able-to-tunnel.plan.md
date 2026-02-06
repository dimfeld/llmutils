---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: nested tim review should be able to tunnel output to parent tim
goal: ""
id: 165
uuid: ad5bc044-81a4-4675-b1fa-4e3ca9038000
generatedBy: agent
status: in_progress
priority: medium
planGeneratedAt: 2026-02-06T07:44:40.758Z
promptsGeneratedAt: 2026-02-06T07:44:40.758Z
createdAt: 2026-01-05T07:25:14.011Z
updatedAt: 2026-02-06T09:09:28.261Z
tasks:
  - title: Define JSONL tunnel protocol
    done: true
    description: Create src/logging/tunnel_protocol.ts with shared types for the
      tunnel protocol. Define TunnelMessage type (log/error/warn/debug with args
      array, stdout/stderr with data string). Export the TIM_OUTPUT_SOCKET
      environment variable name as a constant. Add a helper function to
      serialize LoggerAdapter arguments to strings (using util.inspect() for
      non-strings, matching ConsoleAdapter pattern).
  - title: Create tunnel client adapter
    done: true
    description: Create src/logging/tunnel_client.ts with TunnelAdapter class
      implementing LoggerAdapter. Provide async factory function
      createTunnelAdapter(socketPath) that connects via net.connect() and awaits
      connection. Each LoggerAdapter method serializes the call as a JSONL
      message and writes to the socket. Handle write errors gracefully (fall
      back to no-op if socket disconnects). Implement destroy() method. Export
      isTunnelActive() helper that returns true when TIM_OUTPUT_SOCKET env var
      is set. Write tests in src/logging/tunnel_client.test.ts covering all 6
      adapter methods, connection to socket, and graceful error handling.
  - title: Create tunnel server
    done: true
    description: Create src/logging/tunnel_server.ts with
      createTunnelServer(socketPath) function that creates a Unix domain socket
      server. Server listens for connections and parses incoming JSONL messages.
      For each parsed message, calls the appropriate logging function from
      src/logging.ts (log, error, warn, writeStdout, writeStderr, debugLog).
      Handle message framing across TCP chunks using line splitting (similar to
      createLineSplitter in process.ts). Register cleanup with CleanupRegistry
      to close server and unlink socket file. Return object with server and
      close() method. Write tests in src/logging/tunnel_server.test.ts covering
      message re-emission, multiple connections, malformed message handling, and
      cleanup.
  - title: Write tunnel integration tests
    done: true
    description: "Create src/logging/tunnel_integration.test.ts with end-to-end
      tests: create a tunnel server, create a tunnel client adapter connected to
      it, send messages through the adapter and verify they are re-emitted by
      the server. Test all message types (log, error, warn, stdout, stderr,
      debug). Test connection/disconnection lifecycle. Test that multi-level
      nesting works (output goes to root)."
  - title: Integrate tunnel server into executors
    done: false
    description: "Modify all three executor files to create a tunnel server and pass
      TIM_OUTPUT_SOCKET env var to child processes. In claude_code.ts: create
      tunnel server in executeReviewWithClaudeCode() (around line 595) and in
      the normal execution path (around line 1116), add TIM_OUTPUT_SOCKET to
      env, clean up in finally block. In claude_code_orchestrator.ts: create one
      shared tunnel server per orchestration session, pass to all
      spawnAndLogOutput calls. In codex_cli/codex_runner.ts: same pattern. All
      executors should use the same createTunnelServer utility from
      tunnel_server.ts."
  - title: Install tunnel adapter at CLI startup
    done: false
    description: "In src/tim/tim.ts: after loadEnv() and before
      program.parseAsync(), check if process.env.TIM_OUTPUT_SOCKET is set. If
      set, await createTunnelAdapter(socketPath) to connect. Wrap
      program.parseAsync() in runWithLogger(tunnelAdapter, ...) to install as
      default logger. This completely replaces console output in child processes
      (tunnel-only mode). Register adapter cleanup with CleanupRegistry to
      ensure socket is flushed and closed on exit."
  - title: Handle review mode dual output with tunnel
    done: false
    description: "In src/tim/commands/review.ts: modify the withReviewLogger helper
      (lines 267-275) to check isTunnelActive(). When tunnel is active, skip
      installing reviewPrintQuietLogger or reviewPrintVerboseLogger — let the
      tunnel adapter (installed at tim.ts level) handle all output. For the
      final review output (lines 612-616): when isPrintMode && isTunnelActive(),
      write to BOTH process.stdout.write() directly (for executor capture) AND
      log() (for tunnel to parent). Update or add review tests to verify
      behavior when TIM_OUTPUT_SOCKET is set."
changedFiles:
  - docs/direct_mode_feature.md
  - docs/next-ready-feature.md
  - src/logging/tunnel_client.test.ts
  - src/logging/tunnel_client.ts
  - src/logging/tunnel_integration.test.ts
  - src/logging/tunnel_protocol.test.ts
  - src/logging/tunnel_protocol.ts
  - src/logging/tunnel_server.test.ts
  - src/logging/tunnel_server.ts
  - src/tim/assignments/auto_claim.test.ts
  - src/tim/commands/compact.test.ts
  - src/tim/commands/import/issue_tracker_integration.test.ts
  - src/tim/commands/renumber.test.ts
  - test-plans/rmplan.yml
tags: []
---

When running the review from inside Claude, we don't print anything in order to not fill up Claude's context window, but it would still be useful to see the output on the console.

Implement a way  for the processes to write to the root tim process which can then re-emit on its
own stdout and stderr.

## Suggested Implementation

Parent process creates a unix socket, and passes it to the child process via environment variable. Create a new logger
adapter that writes messages as JSONL to that socket. At startup, we check if the environment variable is set, and if
it is, we install the adapter instead of the default console logger.

In review mode, we also skip installing the custom LoggerAdapter if the environment variable is set. Notably for this
case, when --print is set, for the final message with the review contents we need to BOTH print to the console AND write to the socket.

## Research

### Problem Statement

When tim spawns a nested review process inside an LLM executor (e.g. Claude Code), the nested `tim review` command suppresses its output to avoid filling up Claude's context window. However, this means the human operator sees nothing on their terminal during what can be a long-running review. The goal is to enable nested tim processes to tunnel their log output back to the root tim process, which can then re-emit it on its own stdout/stderr.

### Key Findings

#### Logging Architecture

The logging system uses an **AsyncLocalStorage-based adapter pattern** (`src/logging/adapter.ts`). All logging calls (`log()`, `error()`, `warn()`, `writeStdout()`, `writeStderr()`, `debugLog()`) go through the `LoggerAdapter` interface, which is resolved from `AsyncLocalStorage` or falls back to a default adapter.

**Key files:**
- `src/logging/adapter.ts` — `LoggerAdapter` interface, `runWithLogger()`, `getLoggerAdapter()`
- `src/logging/console.ts` — `ConsoleAdapter` class (logs to console + file)
- `src/logging/silent.ts` — `SilentAdapter` class (logs to file only, used in tests)
- `src/logging.ts` — Public API (`log()`, `error()`, etc.) that delegates to the current adapter

The `LoggerAdapter` interface has 6 methods:
```typescript
interface LoggerAdapter {
  log(...args: any[]): void;
  error(...args: any[]): void;
  warn(...args: any[]): void;
  writeStdout(data: string): void;
  writeStderr(data: string): void;
  debugLog(...args: any[]): void;
}
```

#### Review Command Output Control

The review command (`src/tim/commands/review.ts`) has two special `LoggerAdapter` instances for `--print` mode:

1. **`reviewPrintVerboseLogger`** (lines 201-221): Redirects all output to stderr so that only the final JSON goes to stdout.
2. **`reviewPrintQuietLogger`** (lines 223-231): Suppresses all output entirely (all methods are no-ops).

The `withReviewLogger` helper (lines 267-275) conditionally wraps execution in one of these loggers:
```typescript
const withReviewLogger = <T>(cb: () => T) => {
  if (isPrintMode) {
    const logger = options.verbose ? reviewPrintVerboseLogger : reviewPrintQuietLogger;
    return runWithLogger(logger, cb);
  } else {
    return cb();
  }
};
```

The final formatted review output is printed at line 612-616 via `log()`, which goes through the current adapter.

#### Nested Process Spawning & Environment Variables

When executors spawn nested tim processes, they pass environment variables for context:
- `TIM_EXECUTOR` — Set to `'claude'` or `'codex'` to indicate parent executor type (detected via `getParentExecutor()` in `src/common/process.ts`)
- `TIM_NOTIFY_SUPPRESS` — Set to `'1'` to suppress nested notification events
- `TIM_INTERACTIVE` — Set to `'0'` to disable interactive prompts

These are set in:
- `src/tim/executors/claude_code.ts` (lines 678-684, 1318-1324)
- `src/tim/executors/claude_code_orchestrator.ts` (lines 120-125, 170-175, 225-230)
- `src/tim/executors/codex_cli/codex_runner.ts` (lines 89-96)

#### Existing Unix Socket Pattern

The codebase already has a Unix socket IPC pattern in the Claude Code executor for permission requests (`src/tim/executors/claude_code.ts`, lines 767-855):
- Uses `net.createServer()` to create a Unix domain socket server
- Socket path is generated in a temp directory: `path.join(tempMcpConfigDir, 'permissions.sock')`
- Messages are sent as JSON over the socket, with newline-delimited responses
- The server is cleaned up in a `finally` block with `server.close()`

The client side is in `src/tim/executors/claude_code/permissions_mcp.ts` which connects with `net.connect()`.

#### Process Output Streaming

`spawnAndLogOutput()` in `src/common/process.ts` (lines 137-304) streams stdout/stderr from child processes, with:
- Optional `formatStdout`/`formatStderr` callbacks for transforming output
- Inactivity timeout detection
- Quiet mode support (captures but doesn't print)
- Uses `writeStdout()`/`writeStderr()` from the logging system to emit output

The parent executor already sees child process stdout/stderr through `spawnAndLogOutput()`. The issue is that when the child process is running inside Claude's context, intermediate tim logging is suppressed (via `reviewPrintQuietLogger`), so the parent executor's output streaming shows nothing useful from the review.

#### Cleanup Registry

`src/common/cleanup_registry.ts` provides a singleton `CleanupRegistry` for registering cleanup handlers that run on process exit/SIGINT/SIGTERM. This should be used to clean up the socket server and socket file.

### Architectural Decisions

**Why Unix socket over other IPC methods:**
- Already an established pattern in the codebase (permissions MCP socket)
- Works across process boundaries (unlike AsyncLocalStorage)
- Lower overhead than HTTP or named pipes
- Natural fit for JSONL streaming
- Socket file path can be passed via a single environment variable

**JSONL Protocol Design:**
Each message sent over the socket should be a single JSON line with:
- `type` field: `'log'`, `'error'`, `'warn'`, `'stdout'`, `'stderr'`, `'debug'`
- `args` field: Array of stringified arguments (for log/error/warn/debug)
- `data` field: String data (for stdout/stderr)

The parent socket server reads JSONL, parses each message, and calls the appropriate logging function on its own side.

**Environment Variable:** `TIM_OUTPUT_SOCKET` — path to the Unix domain socket for output tunneling.

### Files to Create or Modify

**New files:**
- `src/logging/tunnel_client.ts` — `TunnelAdapter` class implementing `LoggerAdapter`, sends JSONL to the socket
- `src/logging/tunnel_server.ts` — Socket server that receives JSONL and re-emits via local logging
- `src/logging/tunnel_protocol.ts` — Shared types and constants for the JSONL protocol
- Tests for the above

**Modified files:**
- `src/tim/executors/claude_code.ts` — Create tunnel socket server alongside permission socket, pass `TIM_OUTPUT_SOCKET` env var
- `src/tim/executors/claude_code_orchestrator.ts` — Same as above
- `src/tim/executors/codex_cli/codex_runner.ts` — Same as above
- `src/tim/commands/review.ts` — When `TIM_OUTPUT_SOCKET` is set, use `TunnelAdapter` instead of/in addition to the quiet logger. For `--print` mode: when the final review output is printed, send it via the tunnel AND emit to local stdout.
- `src/tim/tim.ts` — At startup, check for `TIM_OUTPUT_SOCKET` and install `TunnelAdapter` as the default logger

### Edge Cases & Considerations

1. **Socket connection failures**: The tunnel adapter should be resilient — if the socket disconnects or errors, it should fall back to silent behavior rather than crashing the child process.
2. **Multiple nested levels**: If process A spawns B which spawns C, C should tunnel to A (the root). The simplest approach: B passes through `TIM_OUTPUT_SOCKET` unchanged to C, so all output goes to the root.
3. **Cleanup**: The socket file must be cleaned up on process exit. Use `CleanupRegistry`.
4. **Message framing**: JSONL (newline-delimited JSON) is simple and handles framing naturally.
5. **Backpressure**: If the parent is slow to read, the socket buffer may fill. For logging output, this is unlikely to be a problem, but the client should handle write errors gracefully.
6. **Binary data**: The `writeStdout`/`writeStderr` methods take strings, so no binary concerns.
7. **`--print` mode dual output**: When `--print` is set AND the tunnel is active, the final review output must go to both the tunnel (via `log()`) and local stdout (via direct `process.stdout.write()`). This is the ONE exception to the tunnel-only rule.

## Implementation Guide

### Step 1: Define the JSONL Tunnel Protocol

Create `src/logging/tunnel_protocol.ts` with shared types:

```typescript
type TunnelMessage =
  | { type: 'log' | 'error' | 'warn' | 'debug'; args: string[] }
  | { type: 'stdout' | 'stderr'; data: string };
```

Define the environment variable name as a constant: `TIM_OUTPUT_SOCKET`.

Also define a helper to serialize `LoggerAdapter` arguments to strings (similar to how `ConsoleAdapter` and `SilentAdapter` convert args).

### Step 2: Create the Tunnel Client Adapter

Create `src/logging/tunnel_client.ts` with a `TunnelAdapter` class implementing `LoggerAdapter`:

- Provide an async factory function `createTunnelAdapter(socketPath: string): Promise<TunnelAdapter>` that connects to the socket using `net.connect()` and awaits the connection before returning. This is called at startup in `tim.ts` with a top-level await.
- Each `LoggerAdapter` method serializes the call as a JSONL message and writes it to the socket
- Handle write errors gracefully — if the socket disconnects after initial connection, fall back to no-op behavior (don't crash)
- Implement `destroy()` method to close the socket connection
- The tunnel-only mode means this adapter completely replaces console output — no local console logging

The args should be stringified before sending (using `util.inspect()` for non-string values, matching the pattern in `ConsoleAdapter`).

Also export an `isTunnelActive()` helper function that returns true when the tunnel adapter is installed (i.e., `TIM_OUTPUT_SOCKET` is set). This helper is used by the review command to adjust its behavior.

### Step 3: Create the Tunnel Server

Create `src/logging/tunnel_server.ts` with:

- `createTunnelServer(socketPath: string): Promise<net.Server>` — Creates a Unix domain socket server
- The server listens for connections and parses incoming JSONL messages
- For each message, it calls the appropriate logging function from `src/logging.ts` (e.g., `log()`, `error()`, `writeStdout()`, etc.)
- Handle message framing: buffer data across TCP chunks using line splitting (similar to `createLineSplitter()` in `process.ts`)
- Register cleanup with `CleanupRegistry` to close the server and unlink the socket file on exit
- Return an object with the server and a `close()` method

### Step 4: Integrate Tunnel Server into Executors

Modify the executors that spawn nested tim processes to create a tunnel server and pass the socket path:

**In `src/tim/executors/claude_code.ts`:**
- In `executeReviewWithClaudeCode()` (around line 595): Create a tunnel server alongside the existing permission socket
- Add `TIM_OUTPUT_SOCKET: tunnelSocketPath` to the env passed to `spawnAndLogOutput()` (alongside `TIM_EXECUTOR`, `TIM_NOTIFY_SUPPRESS`)
- Clean up the tunnel server in the `finally` block (alongside the permission socket cleanup)
- Do the same for the normal execution path (around line 1116)

**In `src/tim/executors/claude_code_orchestrator.ts`:**
- Same pattern in the orchestrator's `spawnAndLogOutput()` calls

**In `src/tim/executors/codex_cli/codex_runner.ts`:**
- Same pattern when spawning codex with `spawnAndLogOutput()`

### Step 5: Install Tunnel Adapter in Child Processes

**In `src/tim/tim.ts`** (the CLI entry point):
- After `loadEnv()` and before `program.parseAsync()`, check if `process.env.TIM_OUTPUT_SOCKET` is set
- If set, await `createTunnelAdapter(socketPath)` to connect to the socket
- Use `runWithLogger(tunnelAdapter, () => program.parseAsync(process.argv))` to install it as the default logger for the entire process
- This completely replaces console output — the child produces no direct console output (tunnel-only mode)

This ensures all logging in the child process goes through the tunnel by default.

### Step 6: Handle Review Mode Dual Output

**In `src/tim/commands/review.ts`:**

The current logic at lines 267-275 installs a quiet/verbose logger when in `--print` mode. When `TIM_OUTPUT_SOCKET` is set:

- If `--print` mode is active: We still want the final review output to go to stdout (so the executor can capture it from the process's stdout), BUT we also want all logging to go through the tunnel.
- When `isTunnelActive()` returns true, do NOT install the `reviewPrintQuietLogger` or `reviewPrintVerboseLogger`. Instead, let the tunnel adapter (already installed at the `tim.ts` level) handle all output. The parent process will see all the output via the tunnel.
- For the final review output (lines 612-616): when `isPrintMode && isTunnelActive()`, write the final output to BOTH `process.stdout.write()` directly (so the executor can capture it from the child's stdout) AND through `log()` (which goes to the tunnel for the parent to see).

The key insight: when running under an executor with a tunnel, the review's quiet logger is counterproductive — the whole point of the tunnel is to get the output to the parent. So skip the quiet logger entirely when the tunnel is active.

### Step 7: Tests

Write tests for:

1. **Tunnel protocol** (`src/logging/tunnel_protocol.test.ts`):
   - Message serialization/deserialization
   - Argument stringification

2. **Tunnel client adapter** (`src/logging/tunnel_client.test.ts`):
   - Connects to a socket and sends messages
   - Handles connection failures gracefully
   - Test all 6 LoggerAdapter methods

3. **Tunnel server** (`src/logging/tunnel_server.test.ts`):
   - Creates a server, receives JSONL messages, re-emits via logging
   - Handles multiple concurrent connections
   - Handles malformed messages gracefully
   - Cleanup works correctly

4. **Integration test** (`src/logging/tunnel_integration.test.ts`):
   - End-to-end: server + client adapter, verify messages flow through
   - Test with multiple message types
   - Test connection/disconnection lifecycle

5. **Review mode test** — Update existing review tests to verify behavior when `TIM_OUTPUT_SOCKET` is set

### Manual Testing Steps

1. Run `tim agent <plan>` which spawns a nested `tim review`
2. Verify that review output appears on the parent terminal in real-time
3. Verify the review still completes successfully and the executor captures the final output
4. Test with `--print` and `--verbose` flags
5. Test cleanup: kill the parent process and verify no orphaned socket files remain

### Rationale for Key Decisions

- **Putting tunnel installation in `tim.ts`**: This ensures ALL logging in the child process goes through the tunnel, not just review logging. This is the simplest approach and matches the stated goal of "writing to the root tim process."
- **JSONL over raw text**: Preserves log level information so the parent can route messages appropriately (stdout vs stderr, log vs error).
- **Graceful fallback**: If the socket connection fails, the child should continue working. The tunnel is a nice-to-have for operator visibility, not a critical path.
- **Passing `TIM_OUTPUT_SOCKET` through nested levels**: If B spawns C, C connects to A's socket directly. This avoids relay overhead and complexity.

### Acceptance Criteria

- [ ] Nested tim processes can tunnel their output to the root tim process via a Unix socket
- [ ] The root tim process re-emits tunneled output on its own stdout/stderr with appropriate routing
- [ ] The tunnel adapter falls back gracefully if the socket is unavailable
- [ ] Socket files are cleaned up on process exit
- [ ] `--print` mode continues to work correctly (executor captures final output from stdout)
- [ ] Multiple nested levels work (output goes to root)
- [ ] All new code paths are covered by tests
- [ ] No regressions in existing review functionality

### Dependencies & Constraints

- **Dependencies**: Uses existing `net` module (already imported in `claude_code.ts`), existing `LoggerAdapter` interface, existing `CleanupRegistry`
- **Technical Constraints**: Must not break the executor's ability to capture review output from stdout. Must handle async socket connection during process startup.

### Potential Gotchas

- **AsyncLocalStorage inheritance**: When `tim.ts` wraps `program.parseAsync()` in `runWithLogger()`, all async operations spawned within inherit the tunnel adapter. But some code may bypass this by using `runWithLogger()` to install a different adapter (like the review's quiet logger). The review code uses `isTunnelActive()` to skip installing its own loggers when the tunnel is active.
- **Socket connection timing**: Handled by awaiting the socket connection at startup in `tim.ts` before running any commands.
- **Process exit timing**: The child process may exit before all buffered messages are flushed to the socket. Need to ensure flushing on exit (register with cleanup registry or handle in process exit).

## Current Progress
### Current State
- Core tunnel infrastructure (protocol, client, server) is fully implemented and tested
- 62 tests passing across 4 test files with 243 assertions
### Completed (So Far)
- Task 1: JSONL tunnel protocol (`src/logging/tunnel_protocol.ts`) with TunnelMessage type, TIM_OUTPUT_SOCKET constant, serializeArg/serializeArgs helpers
- Task 2: Tunnel client adapter (`src/logging/tunnel_client.ts`) with TunnelAdapter class, createTunnelAdapter factory, isTunnelActive helper, graceful disconnect handling
- Task 3: Tunnel server (`src/logging/tunnel_server.ts`) with createTunnelServer, JSONL parsing, line splitting for TCP chunks, CleanupRegistry integration with proper unregister on close
- Task 4: Integration tests (`src/logging/tunnel_integration.test.ts`) covering all message types, multi-client, disconnect/reconnect, large messages, rapid bursts
### Remaining
- Task 5: Integrate tunnel server into executors (claude_code.ts, claude_code_orchestrator.ts, codex_runner.ts)
- Task 6: Install tunnel adapter at CLI startup in tim.ts
- Task 7: Handle review mode dual output with tunnel in review.ts
### Next Iteration Guidance
- Task 5 (executor integration) and Task 6 (CLI startup) are closely related and should be done together
- Task 7 (review mode) depends on Task 6 being complete
### Decisions / Changes
- debugLog() sends `type: 'debug'` directly instead of delegating to log() — keeps the protocol type meaningful
- TunnelAdapter also writes to log file locally (via writeToLogFile) in addition to sending over socket
- close() on tunnel server calls unregister() on CleanupRegistry to prevent double-close errors
### Risks / Blockers
- None
