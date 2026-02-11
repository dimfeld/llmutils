---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: support asking for input via websocket
goal: ""
id: 171
uuid: d6b2c0b6-90fc-4f04-8e2b-feab3fd4f9d0
generatedBy: agent
status: done
priority: medium
parent: 160
references:
  "160": 514cedb9-6431-400a-a997-12d139376146
planGeneratedAt: 2026-02-11T08:48:58.287Z
promptsGeneratedAt: 2026-02-11T08:48:58.287Z
createdAt: 2026-02-11T08:28:18.284Z
updatedAt: 2026-02-11T09:14:41.895Z
tasks:
  - title: Add HeadlessServerMessage types to headless protocol
    done: true
    description: "Add HeadlessPromptResponseServerMessage interface and
      HeadlessServerMessage discriminated union to
      src/logging/headless_protocol.ts. Define { type: prompt_response,
      requestId: string, value?: unknown, error?: string }. This is the
      server→client message envelope for the websocket protocol."
  - title: Add PromptAnsweredMessage structured message type
    done: true
    description: "Add PromptAnsweredMessage to src/logging/structured_messages.ts
      with fields: type prompt_answered, requestId, promptType, value, source
      (terminal | websocket). Add to StructuredMessage union and
      structuredMessageTypeList. Also add validation for prompt_answered in
      src/logging/tunnel_server.ts isValidStructuredMessagePayload()."
  - title: Add incoming message handling to HeadlessAdapter
    done: true
    description: "Modify src/logging/headless_adapter.ts to support receiving
      messages from the websocket server. Add: (1) pendingPrompts Map<string,
      PendingPromptRequest> for tracking in-flight prompt requests, (2)
      socket.onmessage handler in maybeConnect() that parses JSON and dispatches
      to handleServerMessage(), (3) handleServerMessage() that resolves pending
      prompts on value responses and logs+ignores error responses, (4)
      waitForPromptResponse(requestId) returning { promise, cancel } where
      cancel removes entry and rejects, (5) rejectAllPending() called only from
      destroy()/destroySync() NOT on disconnect, (6)
      isValidHeadlessServerMessage() validation function. Pending prompts must
      survive websocket disconnects."
  - title: Add raceWithWebSocket helper and modify prompt functions
    done: true
    description: "Modify src/common/input.ts to add dual-channel racing. Add
      getHeadlessAdapter() helper to detect HeadlessAdapter. Add
      raceWithWebSocket<T>() helper that: registers ws pending prompt, sets up
      AbortController triggered by ws response, composes with timeout signal via
      AbortSignal.any(), runs inquirer, catches AbortPromptError when ws wins,
      sends prompt_answered structured message. Modify all four prompt functions
      (promptConfirm, promptSelect, promptInput, promptCheckbox) to use
      raceWithWebSocket when HeadlessAdapter is active. Also add
      sendPromptAnswered() to the existing terminal-only path for protocol
      consistency. Add sendPromptAnswered helper function."
  - title: Write HeadlessAdapter prompt tests
    done: true
    description: "Add tests to src/logging/headless_adapter.test.ts (new or
      existing) using a real Bun.serve websocket server. Test:
      waitForPromptResponse resolves on value response, error responses are
      ignored (promise stays pending), cancel() rejects the promise, destroy()
      rejects all pending, unknown requestIds ignored, malformed messages
      ignored, pending prompts survive ws disconnect, reconnection re-attaches
      onmessage handler."
  - title: Write input.ts dual-channel racing tests
    done: true
    description: "Add tests to src/common/input.test.ts for the headless
      dual-channel path. Test: ws responds first and terminal is cancelled,
      terminal responds first and ws wait is cancelled, prompt_answered
      structured message sent after resolution from either source, timeout
      cancels both channels, ws disconnect during prompt degrades to
      terminal-only, tunnel mode still takes priority over headless mode. Use
      real websocket server and mock inquirer (existing test pattern)."
  - title: Create manual headless prompt testing harness
    done: true
    description: Create scripts/manual-headless-prompt-harness.ts that starts a
      websocket server displaying received prompt_request messages and allows
      sending prompt_response messages back. Demonstrates dual-channel racing
      behavior for manual testing. Can be based on the existing
      tim-agent-listener.ts and manual-tunnel-prompt-harness.ts patterns.
changedFiles:
  - README.md
  - package.json
  - scripts/manual-headless-prompt-harness.ts
  - scripts/manual-tunnel-prompt-harness.ts
  - src/common/input.test.ts
  - src/common/input.ts
  - src/common/terminal.test.ts
  - src/logging/console_formatter.ts
  - src/logging/headless_adapter.test.ts
  - src/logging/headless_adapter.ts
  - src/logging/headless_protocol.ts
  - src/logging/structured_messages.test.ts
  - src/logging/structured_messages.ts
  - src/logging/tunnel_client.test.ts
  - src/logging/tunnel_client.ts
  - src/logging/tunnel_integration.test.ts
  - src/logging/tunnel_prompt_handler.test.ts
  - src/logging/tunnel_prompt_handler.ts
  - src/logging/tunnel_protocol.ts
  - src/logging/tunnel_server.test.ts
  - src/logging/tunnel_server.ts
  - src/testing.ts
  - src/tim/commands/agent/agent.integration.test.ts
  - src/tim/commands/agent/agent.summary_file.integration.test.ts
  - src/tim/commands/agent/agent.test.ts
  - src/tim/commands/agent/agent.timeout.integration.test.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/agent/agent_batch_mode.test.ts
  - src/tim/commands/agent/batch_mode.ts
  - src/tim/commands/cleanup-temp.test.ts
  - src/tim/commands/find_next_dependency.test.ts
  - src/tim/commands/review.test.ts
  - src/tim/commands/subagent.test.ts
  - src/tim/commands/subagent.ts
  - src/tim/configSchema.test.ts
  - src/tim/configSchema.ts
  - src/tim/executors/claude_code/orchestrator_integration.test.ts
  - src/tim/executors/claude_code/orchestrator_prompt.test.ts
  - src/tim/executors/claude_code/orchestrator_prompt.ts
  - src/tim/executors/claude_code/permissions_mcp_setup.test.ts
  - src/tim/executors/claude_code/permissions_mcp_setup.ts
  - src/tim/executors/claude_code.test.ts
  - src/tim/executors/claude_code.ts
  - src/tim/executors/claude_code_model_test.ts
  - src/tim/executors/codex_cli/codex_runner.ts
  - src/tim/executors/types.ts
  - src/tim/issue_utils.ts
  - src/tim/planSchema.ts
  - src/tim/tim.ts
  - src/tim/workspace/workspace_auto_selector.ts
tags: []
---

We currently support tunneling mode for soliciting various inputs in src/common/input.ts. We should also support doing
this over the websocket protocol if we are connected and NOT in tunneling mode.

The basic idea is the same, we send a message and wait for a response. The main difference here is that we want
to be able to answer the prompt via either the terminal or websocket.

If we get an answer via websocket, we should cancel the terminal prompt, and we can do this using an abort controller similar to how we do timeouts right now.

Once we get an answer, either way, we should send a structured message containing the prompt response. This will be a signal for the WebSocket server to show the response and cancel its own version of the prompt, if necessary.

## Expected Behavior/Outcome

When a HeadlessAdapter (websocket) is active and not in tunnel mode, prompt functions (`promptConfirm`, `promptSelect`, `promptInput`, `promptCheckbox`) should:

1. **Send** the `prompt_request` structured message over the websocket (already happens via `sendStructured`)
2. **Start** the local terminal inquirer prompt simultaneously
3. **Listen** for a `prompt_response` message from the websocket server
4. **Race** the terminal and websocket responses -- whichever arrives first wins
5. **Cancel** the losing channel (abort the inquirer prompt if websocket answers first; the websocket server handles its own cancellation)
6. **Broadcast** a new `prompt_answered` structured message with the result and source, so the websocket server can display/dismiss its UI

### States

- **Idle**: No active prompt. HeadlessAdapter is passively connected.
- **Awaiting Dual Response**: A prompt is active on both terminal and websocket. Either can resolve it.
- **Resolved via Terminal**: User answered in terminal. `prompt_answered` message sent to websocket so server can cancel its prompt UI.
- **Resolved via WebSocket**: Server sent `prompt_response`. Terminal prompt is aborted via AbortController. `prompt_answered` message sent for confirmation.
- **Timed Out**: If `timeoutMs` is specified, both channels are cancelled after the timeout.
- **Disconnected**: If the websocket disconnects during a prompt, the terminal prompt continues as the sole input source.

## Key Findings

### Product & User Story
As a developer using tim with a monitoring dashboard, I want to answer prompts (tool permissions, confirmations, etc.) from either the terminal or the dashboard UI, so that I can interact with running agents from whichever interface is most convenient.

### Design & UX Approach
- **Dual-channel prompting**: Both terminal and websocket are active simultaneously when HeadlessAdapter is connected
- **First-wins semantics**: Whichever channel responds first is the authoritative answer
- **Graceful degradation**: If websocket disconnects, terminal-only mode continues seamlessly
- **No behavior change for tunnel mode**: Tunnel mode (subagents) continues to work exclusively through the tunnel, unchanged

### Technical Plan & Risks
- **Risk: Race condition cleanup** -- When one channel wins, the other must be cancelled cleanly. AbortController handles the terminal side; a `cancel()` method on pending websocket promises handles the server side. When the websocket wins, the AbortPromptError from inquirer should be caught and ignored.
- **Risk: HeadlessAdapter message handling** -- Currently HeadlessAdapter has no `onmessage` handler on its WebSocket. Adding incoming message parsing introduces a new code path.
- **Risk: Reconnection during prompt** -- The websocket may reconnect mid-prompt. The prompt_request is in the replay buffer, so the server gets it on reconnect and can still respond. Pending prompts are kept alive across disconnects (NOT rejected on ws disconnect, only on adapter destroy).

### Pragmatic Effort Estimate
Small-to-medium effort. The existing TunnelAdapter pattern provides a strong template. Main work is in:
1. Adding receive capability to HeadlessAdapter (~100 lines)
2. Modifying the 4 prompt functions in input.ts to add the dual-channel race (~150 lines, mostly shared helper)
3. Adding new structured message types (~20 lines)
4. Tests (~200 lines)

## Acceptance Criteria

- [ ] When HeadlessAdapter is active and not tunneled, prompts are answerable from both terminal and websocket
- [ ] When a websocket response arrives, the terminal inquirer prompt is cancelled immediately
- [ ] When a terminal response arrives, the websocket pending promise is cleaned up
- [ ] After resolution from either source, a `prompt_answered` structured message is sent via `sendStructured`
- [ ] Timeout behavior works correctly: both channels are cancelled when timeout fires
- [ ] WebSocket disconnection during a prompt degrades gracefully to terminal-only
- [ ] Existing tunnel mode behavior is unchanged
- [ ] Existing non-headless terminal-only behavior is unchanged
- [ ] All new code paths are covered by tests

## Dependencies & Constraints

- **Dependencies**: Relies on existing HeadlessAdapter (`src/logging/headless_adapter.ts`), prompt functions (`src/common/input.ts`), and structured message types (`src/logging/structured_messages.ts`)
- **Technical Constraints**: Must not break existing tunnel mode or non-headless mode. The HeadlessAdapter's websocket reconnection and buffer management must remain stable.

## Implementation Notes

### Recommended Approach
See the Implementation Guide below for the detailed step-by-step approach. The key architectural decision is to add `pendingPrompts` tracking to HeadlessAdapter (mirroring TunnelAdapter's pattern) and create a shared `raceWithWebSocket` helper used by all four prompt functions.

### Design Decisions (Confirmed)
- **`prompt_answered` sent unconditionally** in all non-tunnel cases (both headless and terminal-only) for simplicity. Includes the response `value`.
- **Proper `HeadlessServerMessage` envelope type** in `headless_protocol.ts` (discriminated union, not raw JSON).
- **Pending prompts survive ws disconnect** -- only rejected on `destroy()`/`destroySync()`. The terminal is always available as fallback, and ws might reconnect.
- **Register pending prompts even when ws is disconnected** -- the ws might reconnect (e.g., user is away and prompt has no timeout).
- **Error responses from ws are logged and ignored** -- terminal continues as fallback. Only `value` responses win the race.
- **AbortPromptError from inquirer is caught and ignored** when ws wins the race.

### Potential Gotchas
- The HeadlessAdapter wraps another adapter. When checking `getLoggerAdapter()`, we get the HeadlessAdapter directly since it's set via `runWithLogger`. The `instanceof HeadlessAdapter` check works correctly.
- The AbortController used for websocket cancellation of the terminal prompt must compose correctly with any existing timeout AbortController. Using `AbortSignal.any()` is the cleanest approach.
- When the websocket reconnects (new socket created in `maybeConnect()`), the `onmessage` handler must be re-attached to the new socket.
- The `cancel()` on the websocket pending promise should reject it. Add `.catch(() => {})` to the `wsPromise` to suppress unhandled rejection when terminal wins and cancel rejects the ws promise.

## Research

### Overview

This feature extends the existing prompt system to support answering prompts from a websocket-connected dashboard in addition to the terminal. The codebase already has a sophisticated tunneling protocol for prompt forwarding between parent/child processes, and a HeadlessAdapter for streaming output over websocket. This plan bridges the two by adding input reception to the HeadlessAdapter.

### Key File Analysis

#### `src/common/input.ts` -- Prompt Function Hub
The central module for all user prompts. Contains four public functions (`promptConfirm`, `promptSelect`, `promptInput`, `promptCheckbox`) and supporting helpers.

**Current flow (non-tunnel)**:
1. Build a `PromptRequestMessage` via `buildPromptRequest()` (assigns UUID `requestId`)
2. Check `getTunnelAdapter()` -- if active, delegate entirely to tunnel
3. Send `sendStructured(promptMessage)` for visibility (this goes through the HeadlessAdapter if active)
4. Create optional timeout via `createTimeoutSignal(timeoutMs)`
5. Call the appropriate `@inquirer/prompts` function with optional abort signal
6. Clean up timeout in `finally` block

**Key observation**: Step 3 already sends the prompt request over websocket when HeadlessAdapter is active. The websocket server already receives `prompt_request` messages -- we just need to handle responses coming back.

#### `src/logging/headless_adapter.ts` -- WebSocket Output Adapter
Currently **output-only**. Key characteristics:
- Wraps another `LoggerAdapter` (usually `ConsoleAdapter`) and forwards all calls to both the wrapped adapter and the websocket
- Manages reconnection with rate limiting (`reconnectIntervalMs`, default 5s)
- Buffers messages in a queue with history replay on reconnect
- Has `enqueueTunnelMessage()` for outgoing, but NO incoming message handler
- Socket lifecycle: `disconnected` → `connecting` → `connected` → (on destroy) `draining`
- Sets `socket.onopen`, `socket.onerror`, `socket.onclose` but **NOT** `socket.onmessage`

**Critical gap**: The `maybeConnect()` method creates new WebSocket instances on reconnect. Any `onmessage` handler must be attached each time a new socket is created.

#### `src/logging/tunnel_client.ts` -- TunnelAdapter (Reference Pattern)
The TunnelAdapter provides the exact pattern we need to replicate in HeadlessAdapter:
- `pendingPrompts: Map<string, PendingPromptRequest>` tracks in-flight requests
- `sendPromptRequest(message, timeoutMs)` sends and returns a promise
- `handleServerMessage(message)` processes incoming `prompt_response` messages
- `rejectAllPending(error)` cleans up on disconnect

**Key difference for HeadlessAdapter**: TunnelAdapter uses the tunnel exclusively (no local terminal). HeadlessAdapter needs to support BOTH channels simultaneously.

#### `src/logging/headless_protocol.ts` -- Headless Message Types
Currently defines only client→server messages:
- `HeadlessSessionInfoMessage` (session metadata)
- `HeadlessOutputMessage` (wrapped tunnel message with sequence number)
- `HeadlessReplayStartMessage` / `HeadlessReplayEndMessage`

**Needs extension**: Must add server→client message types for prompt responses.

#### `src/logging/structured_messages.ts` -- Structured Message Types
Contains 27 structured message types in the `StructuredMessage` union. Includes `PromptRequestMessage` (already sent when prompts start). Does NOT include any response/answer type.

**Needs extension**: Add a `PromptAnsweredMessage` type for broadcasting prompt results.

#### `src/logging/tunnel_protocol.ts` -- Tunnel Protocol Types
Defines `TunnelPromptResponseMessage` with `{ type: 'prompt_response', requestId, value?, error? }`. This is the tunnel-level protocol, separate from StructuredMessage. We can reuse this same format for the websocket server→client direction.

#### `src/tim/headless.ts` -- HeadlessAdapter Initialization
Shows how HeadlessAdapter is created and used:
- `runWithHeadlessAdapterIfEnabled()` wraps callbacks with HeadlessAdapter via `runWithLogger()`
- `createHeadlessAdapterForCommand()` creates standalone instances
- URL resolution from env var `TIM_HEADLESS_URL` or config, default `ws://localhost:8123/tim-agent`
- `getLoggerAdapter()` inside that context returns the HeadlessAdapter directly

### Existing Patterns to Leverage

1. **PendingPromptRequest pattern** from TunnelAdapter: Map of requestId → {resolve, reject, timer}
2. **`createTimeoutSignal()` pattern** from input.ts: AbortController with setTimeout
3. **`isPromptTimeoutError()`** detection: Already handles AbortPromptError and timeout messages
4. **`sendStructured()`** for broadcasting: Goes through the current adapter chain
5. **Message validation** patterns from tunnel_client.ts: `isValidServerTunnelMessage()`

### Callers of Prompt Functions (Impact Analysis)

- `promptConfirm`: Called in `agent.ts` (continue after review), `batch_mode.ts` (continue with tasks), `workspace_auto_selector.ts` (clear stale lock)
- `promptSelect`: Called in `claude_code.ts` (tool permissions), `permissions_mcp_setup.ts` (MCP tool permissions)
- `promptInput`, `promptCheckbox`: No direct callers yet (only in tests/harness), but the infrastructure should be ready

### Architectural Hazards

1. **Socket recreation on reconnect**: `maybeConnect()` creates new WebSocket instances. The `onmessage` handler must be attached in `maybeConnect()` alongside `onopen`/`onerror`/`onclose`.
2. **Abort signal composition**: When both timeout AND websocket cancellation are needed, we need to combine two abort sources. `AbortSignal.any([signal1, signal2])` is available in modern Node.js/Bun.
3. **Thread safety of pendingPrompts**: JavaScript is single-threaded, but async operations interleave. The Map operations are safe as long as we don't yield between check-and-delete.
4. **HeadlessAdapter destruction during prompt**: `destroy()` and `destroySync()` need to reject pending prompts, same as TunnelAdapter does.

## Implementation Guide

### Step 1: Add Server-to-Client Message Types to Headless Protocol

**File**: `src/logging/headless_protocol.ts`

Add a proper `HeadlessServerMessage` discriminated union for messages the websocket server can send to the client. Define a dedicated `HeadlessPromptResponseServerMessage` interface (not reusing `TunnelPromptResponseMessage`, since this is a separate protocol with its own envelope):

```typescript
export interface HeadlessPromptResponseServerMessage {
  type: 'prompt_response';
  requestId: string;
  value?: unknown;
  error?: string;
}

export type HeadlessServerMessage = HeadlessPromptResponseServerMessage;
```

This union is extensible for future server→client message types.

### Step 2: Add `PromptAnsweredMessage` Structured Message Type

**File**: `src/logging/structured_messages.ts`

Add a new `PromptAnsweredMessage` to the `StructuredMessage` union. This message is broadcast after a prompt is resolved (from either terminal or websocket) so the websocket server can update its UI.

```typescript
export interface PromptAnsweredMessage extends StructuredMessageBase {
  type: 'prompt_answered';
  requestId: string;
  promptType: PromptType;
  value?: unknown;
  error?: string;
  source: 'terminal' | 'websocket';
}
```

Add `'prompt_answered'` to `structuredMessageTypeList` and `PromptAnsweredMessage` to the `StructuredMessage` union.

### Step 3: Add Incoming Message Handling to HeadlessAdapter

**File**: `src/logging/headless_adapter.ts`

This is the core infrastructure change. Add:

1. **`pendingPrompts` map**: `Map<string, PendingPromptRequest>` tracking in-flight prompt requests (same pattern as TunnelAdapter). Note: entries persist across websocket disconnects -- they are NOT rejected on disconnect since terminal is still active and ws might reconnect.
2. **`onmessage` handler**: Attached in `maybeConnect()` alongside the existing `onopen`/`onerror`/`onclose` handlers. Parses incoming JSON, validates as `HeadlessServerMessage`, and dispatches to `handleServerMessage()`.
3. **`handleServerMessage()` method**: For `prompt_response` with a `value`, looks up `requestId` in `pendingPrompts` and resolves. For error responses, log a warning and ignore (do NOT resolve/reject -- let terminal handle it).
4. **`waitForPromptResponse(requestId)` method**: Public method that creates a pending entry and returns `{ promise, cancel }`. The `cancel()` function removes the entry from the map and rejects the promise. Callers must add `.catch(() => {})` to the returned promise to suppress unhandled rejections when terminal wins.
5. **Cleanup in `destroy()` / `destroySync()`**: Call `rejectAllPending()` to clean up any in-flight prompts. This is the ONLY place pending prompts are rejected (not on ws disconnect).
6. **`rejectAllPending()` method**: Iterates pendingPrompts, rejects each, clears timers.

**Important**: In `maybeConnect()`, after `socket = new WebSocket(this.url)`, add:
```typescript
socket.onmessage = (event) => {
  // Parse the message data
  const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
  try {
    const parsed = JSON.parse(data);
    if (isValidHeadlessServerMessage(parsed)) {
      this.handleServerMessage(parsed);
    }
  } catch {
    // Malformed JSON -- silently ignore
  }
};
```

Add a validation function `isValidHeadlessServerMessage()` following the same pattern as `isValidServerTunnelMessage()` in tunnel_client.ts.

### Step 4: Modify Prompt Functions for Dual-Channel Racing

**File**: `src/common/input.ts`

This is the main behavioral change. Create a shared helper and modify all four prompt functions.

#### 4a: Add `getHeadlessAdapter()` helper

```typescript
function getHeadlessAdapter(): HeadlessAdapter | undefined {
  const adapter = getLoggerAdapter();
  return adapter instanceof HeadlessAdapter ? adapter : undefined;
}
```

Import `HeadlessAdapter` from `../logging/headless_adapter.js`.

#### 4b: Create `raceWithWebSocket()` helper

This helper encapsulates the dual-channel racing logic. It:

1. Registers a pending prompt on the HeadlessAdapter via `waitForPromptResponse(requestId)`
2. Creates a combined AbortSignal from both the timeout (if any) and a websocket-wins abort
3. Starts the inquirer prompt with the combined signal
4. Races the inquirer promise against the websocket promise
5. Cleans up the loser
6. Sends a `prompt_answered` structured message
7. Returns the result

The approach: attempt the terminal inquirer prompt, but set up the websocket promise to abort the terminal if ws responds first. If terminal completes normally, it won. If terminal was aborted, check if ws has the answer.

Sketch:
```typescript
async function raceWithWebSocket<T>(
  headlessAdapter: HeadlessAdapter,
  promptMessage: PromptRequestMessage,
  runInquirer: (signal?: AbortSignal) => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const { promise: wsPromise, cancel: cancelWs } = headlessAdapter.waitForPromptResponse(promptMessage.requestId);
  // Suppress unhandled rejection (cancel() rejects the promise)
  wsPromise.catch(() => {});

  const wsAbortController = new AbortController();
  // When ws resolves, abort the terminal prompt
  wsPromise.then(() => wsAbortController.abort(), () => {});

  // Combine ws-abort signal with optional timeout signal
  let timeoutCleanup: (() => void) | undefined;
  const signals: AbortSignal[] = [wsAbortController.signal];
  if (timeoutMs != null && timeoutMs > 0) {
    const timeout = createTimeoutSignal(timeoutMs);
    signals.push(timeout.signal);
    timeoutCleanup = timeout.cleanup;
  }
  const combinedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  try {
    // Attempt terminal prompt -- may complete or be aborted by ws/timeout
    const value = await runInquirer(combinedSignal);
    // Terminal won
    cancelWs();
    sendPromptAnswered(promptMessage, value, 'terminal');
    return value;
  } catch (err) {
    // Terminal was aborted. Was it because ws responded?
    cancelWs(); // Clean up ws regardless
    try {
      const wsValue = await wsPromise;
      // WS won (promise already resolved before cancel was called)
      sendPromptAnswered(promptMessage, wsValue, 'websocket');
      return wsValue as T;
    } catch {
      // WS was also cancelled/failed -- rethrow the original error (likely timeout)
      throw err;
    }
  } finally {
    timeoutCleanup?.();
  }
}

function sendPromptAnswered(
  promptMessage: PromptRequestMessage,
  value: unknown,
  source: 'terminal' | 'websocket',
): void {
  sendStructured({
    type: 'prompt_answered',
    timestamp: new Date().toISOString(),
    requestId: promptMessage.requestId,
    promptType: promptMessage.promptType,
    value,
    source,
  });
}
```

#### 4c: Modify each prompt function

The non-tunnel path in each function changes from "just call inquirer" to "check for HeadlessAdapter and race if present". The existing terminal-only path also sends `prompt_answered` for protocol consistency. Example for `promptConfirm`:

```typescript
// After the tunnel check and sendStructured...
const headlessAdapter = getHeadlessAdapter();
if (headlessAdapter) {
  return raceWithWebSocket(
    headlessAdapter,
    promptMessage,
    (signal) => inquirerConfirm({ message, default: defaultValue }, { signal }),
    timeoutMs,
  );
}

// Existing timeout-only path (also sends prompt_answered now)
let timeout = ...;
try {
  const value = await inquirerConfirm({ message, default: defaultValue }, timeout ? { signal: timeout.signal } : undefined);
  sendPromptAnswered(promptMessage, value, 'terminal');
  return value;
} finally {
  timeout?.cleanup();
}
```

### Step 5: Update Tunnel Server Validation for New Structured Message

**File**: `src/logging/tunnel_server.ts`

The `isValidStructuredMessagePayload()` function validates all structured message types. Add validation for `prompt_answered`:
- Check `requestId` is string
- Check `promptType` is valid PromptType
- Check `source` is 'terminal' or 'websocket'

### Step 6: Write Tests

**Files**: `src/common/input.test.ts`, `src/logging/headless_adapter.test.ts`

#### HeadlessAdapter Tests (`headless_adapter.test.ts`):
- Test that `waitForPromptResponse()` resolves when a matching `prompt_response` with `value` is received
- Test that error responses from server are logged/ignored (promise stays pending, not rejected)
- Test that `cancel()` removes the pending entry and rejects the promise
- Test that `destroy()` rejects all pending prompts
- Test that unknown requestIds are silently ignored
- Test that malformed incoming messages are silently ignored
- Test that reconnection re-attaches the onmessage handler
- Test that pending prompts survive websocket disconnect (NOT rejected)

Use a real WebSocket server (Bun.serve with websocket handlers) to test the full flow, similar to how `input.test.ts` uses real Unix sockets for tunnel tests.

#### Input Function Tests (`input.test.ts`):
- Test dual-channel mode: websocket responds first, terminal is cancelled
- Test dual-channel mode: terminal responds first, websocket wait is cancelled
- Test that `prompt_answered` structured message is sent after resolution from either source
- Test timeout in dual-channel mode cancels both channels
- Test websocket disconnect during prompt falls back to terminal-only
- Test that tunnel mode is still preferred over headless mode (tunnel check comes first)

### Step 7: Update Manual Testing Harness

**File**: `scripts/manual-tunnel-prompt-harness.ts` (or a new `scripts/manual-headless-prompt-harness.ts`)

Create or extend a manual testing harness that:
1. Starts a websocket server that displays received prompt requests
2. Allows manually sending prompt responses from the server
3. Demonstrates the dual-channel racing behavior

### Manual Testing Steps

1. Start a websocket server (use `tim-agent-listener.ts` or a modified version that can send prompt responses)
2. Run a tim agent command with `--headless` enabled
3. When a prompt appears in the terminal, verify it also shows up on the websocket server
4. Answer from the terminal -- verify `prompt_answered` message appears on server
5. Trigger another prompt, this time answer from the websocket server -- verify terminal prompt is cancelled
6. Test with timeout -- verify both channels cancel after timeout
7. Disconnect the websocket during a prompt -- verify terminal continues working

## Current Progress
### Current State
- All 7 tasks are complete. The feature is fully implemented, tested, and reviewed.
### Completed (So Far)
- Task 1: HeadlessPromptResponseServerMessage and HeadlessServerMessage union added to headless_protocol.ts
- Task 2: PromptAnsweredMessage added to structured_messages.ts, validation added to tunnel_server.ts
- Task 3: HeadlessAdapter now handles incoming messages: pendingPrompts map, onmessage handler, handleServerMessage(), waitForPromptResponse(), rejectAllPending()
- Task 4: raceWithWebSocket() helper and getHeadlessAdapter()/sendPromptAnswered() added to input.ts. All four prompt functions modified for dual-channel racing. Terminal-only path also sends prompt_answered.
- Task 5: 10 tests in headless_adapter.test.ts covering all prompt handling paths
- Task 6: 7 tests in input.test.ts covering dual-channel racing paths
- Task 7: Manual testing harness at scripts/manual-headless-prompt-harness.ts
### Remaining
- None
### Next Iteration Guidance
- None - all tasks complete
### Decisions / Changes
- Error responses from ws: delete the pending entry after logging (don't leave it leaking), but do NOT reject the promise - terminal continues as fallback
- Removed unused error?: string field from PromptAnsweredMessage (was never populated)
- isValidHeadlessServerMessage allows prompt_response with no value and no error (resolves with undefined) - this is intentional
### Risks / Blockers
- None
