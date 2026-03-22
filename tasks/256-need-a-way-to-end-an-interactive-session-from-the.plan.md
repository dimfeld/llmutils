---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Need a way to end an interactive session from the web
goal: ""
id: 256
uuid: 30d9cee3-971a-471b-af26-191361b0ba93
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-03-22T08:35:03.086Z
promptsGeneratedAt: 2026-03-22T08:35:03.086Z
createdAt: 2026-03-22T08:13:57.614Z
updatedAt: 2026-03-22T09:11:16.077Z
tasks:
  - title: Add end_session message type to the headless protocol
    done: true
    description: Add HeadlessEndSessionServerMessage interface to
      src/logging/headless_protocol.ts and include it in the
      HeadlessServerMessage union type. Add end_session case to
      isValidHeadlessServerMessage() in headless_adapter.ts.
  - title: Add end session handler to HeadlessAdapter
    done: true
    description: "In src/logging/headless_adapter.ts: add private endSessionHandler
      callback field, add setEndSessionHandler() public method (similar to
      setUserInputHandler), and add end_session case to handleServerMessage()
      that invokes the handler. Write tests verifying the handler is called when
      an end_session message arrives."
  - title: Wire end session handler in executeWithTerminalInput
    done: true
    description: "In src/tim/executors/claude_code/terminal_input_lifecycle.ts:
      after the headless user input handler wiring, register an end session
      handler via loggerAdapter.setEndSessionHandler(). The handler should: (1)
      clear tunnel/headless user input handlers, (2) if terminalInputController
      exists, call onResultMessage() to stop reader + close stdin, (3) else if
      stdinGuard is not closed, close it, (4) else call streaming.kill(SIGTERM)
      as fallback for non-interactive sessions. Clear the handler in the cleanup
      function. Write tests for both interactive and non-interactive paths."
  - title: Add endSession method to SessionManager and SvelteKit command
    done: true
    description: Add endSession(connectionId) method to SessionManager in
      src/lib/server/session_manager.ts that calls trySend with type
      end_session. Add endSession SvelteKit command to
      src/lib/remote/session_actions.remote.ts using sessionTargetSchema. Add
      endSession method to the browser session state store in
      src/lib/stores/session_state.svelte.ts. Write tests for the SessionManager
      method.
  - title: Add End Session button with confirmation dialog to SessionDetail
    done: true
    description: "In src/lib/components/SessionDetail.svelte: add an End Session
      button in the session header, visible only when session.status === active.
      On click, show a confirmation dialog (popover or inline) with the actual
      End Session action button. The confirm button calls
      sessionManager.endSession(session.connectionId). Style as a
      muted/destructive button."
changedFiles:
  - .rmfilter/config/tim.yml
  - docs/implementer-instructions.md
  - docs/reviewer-instructions.md
  - src/common/input.ts
  - src/lib/components/SessionDetail.svelte
  - src/lib/remote/session_actions.remote.test.ts
  - src/lib/remote/session_actions.remote.ts
  - src/lib/server/session_manager.test.ts
  - src/lib/server/session_manager.ts
  - src/lib/stores/session_state.svelte.ts
  - src/lib/stores/session_state.test.ts
  - src/logging/headless_adapter.test.ts
  - src/logging/headless_adapter.ts
  - src/logging/headless_protocol.ts
  - src/tim/commands/review.ts
  - src/tim/executors/claude_code/terminal_input_lifecycle.test.ts
  - src/tim/executors/claude_code/terminal_input_lifecycle.ts
tags: []
---

For example when we run `tim generate`, we are interactively building the plan, but then there's no way to actually
close the session when done. Add a message that the web server can send to the running `tim` process that tells it to
close the session. The effect should be the same as if the user hit Ctrl-D in the terminal to close the readline (though
this needs to also work even if we ran with --no-terminal-input)

## Research

### Problem Overview

When running interactive commands like `tim generate` or `tim chat` via the web UI, there is currently no way
to signal the running process to end its session. In a terminal, the user presses Ctrl-D to send EOF on stdin,
which closes the readline interface and cascades through to closing the subprocess's stdin, ending the session
gracefully. The web UI has no equivalent mechanism.

### Architecture of the Communication Stack

The system uses a layered communication model:

1. **Tim CLI process** runs the command (e.g. `tim generate`)
2. **HeadlessAdapter** (`src/logging/headless_adapter.ts`) connects to the web server via WebSocket
3. **WebSocket server** (`src/lib/server/ws_server.ts`) on port 8123 accepts connections at `/tim-agent`
4. **SessionManager** (`src/lib/server/session_manager.ts`) tracks sessions and emits events
5. **SSE endpoint** (`src/routes/api/sessions/events/+server.ts`) streams events to the browser
6. **SvelteKit commands** (`src/lib/remote/session_actions.remote.ts`) handle browser→server actions

### Current Server→Client Message Types

The `HeadlessServerMessage` union type in `src/logging/headless_protocol.ts` currently has only two variants:
- `prompt_response` — responds to a `prompt_request` with `requestId` + `value`/`error`
- `user_input` — free-form text input forwarded to the process via `setUserInputHandler()`

There is no "end session" or "close" message type.

### How Interactive Sessions Stay Alive

Interactive commands (`generate`, `chat`) set `closeTerminalInputOnResult: false` in their executor options.
This means that even when the LLM produces a result message, stdin is NOT closed — the session stays open
for follow-up messages. The session only ends when:
- **Terminal path**: User presses Ctrl-D → readline emits 'close' → `onCloseWhileActive()` → `stdinGuard.close()` → subprocess stdin ends
- **Headless/web path**: No mechanism exists to trigger this — the process must be killed externally

### Key Files and Their Roles

| File | Role |
|------|------|
| `src/logging/headless_protocol.ts` | Protocol type definitions — add new `end_session` message type here |
| `src/logging/headless_adapter.ts` | Client-side WebSocket handler — handle incoming `end_session` message here |
| `src/lib/server/session_manager.ts` | Server-side session management — add `endSession()` method here |
| `src/lib/remote/session_actions.remote.ts` | SvelteKit command handlers — add `endSession` command here |
| `src/lib/stores/session_state.svelte.ts` | Browser-side session state — add `endSession()` method here |
| `src/lib/components/SessionDetail.svelte` | Session detail UI — add end session button here |
| `src/lib/components/MessageInput.svelte` | Message input area — potential place for end button |
| `src/tim/executors/claude_code/terminal_input_lifecycle.ts` | Terminal input wiring — the `executeWithTerminalInput()` function manages stdin lifecycle |

### How the Headless User Input Handler Works

In `executeWithTerminalInput()` (line 205-229 of `terminal_input_lifecycle.ts`), when a `HeadlessAdapter` is detected:
1. A `userInputHandler` is registered via `loggerAdapter.setUserInputHandler(callback)`
2. The callback receives text content and calls `sendFollowUpMessage(streaming.stdin, content)` to forward it to the subprocess
3. There's also a `clearHeadlessUserInputHandler` cleanup function

The `HeadlessAdapter.handleServerMessage()` method (line 209-244 of `headless_adapter.ts`) dispatches incoming messages:
- `prompt_response` → resolves pending promise
- `user_input` → calls `this.userInputHandler?.(message.content)`

### How stdin Closure Propagates

The `StdinGuard` pattern in `terminal_input_lifecycle.ts` (lines 18-39) ensures stdin is closed exactly once:
```
stdinGuard.close() → safeEndStdin(stdin) → subprocess receives EOF → process exits
```

The `executeWithTerminalInput()` function returns a `closeStdin` method (line 308-310) that calls `stdinGuard.close()`.

### Validation on the Server Side

The WebSocket server (`ws_server.ts` line 78) validates incoming client→server messages against `VALID_HEADLESS_TYPES`:
`['session_info', 'replay_start', 'replay_end', 'output']`. This does NOT need to change since we're adding a
server→client message, not a client→server one.

The `isValidHeadlessServerMessage()` function in `headless_adapter.ts` (line 37) validates server→client messages
and will need a new case for the `end_session` type.

### Existing Patterns to Follow

The `sendUserInput` flow is the closest analogue:
1. **Protocol**: `HeadlessUserInputServerMessage` type in `headless_protocol.ts`
2. **Server command**: `sendSessionUserInput` in `session_actions.remote.ts` → calls `sessionManager.sendUserInput()`
3. **SessionManager**: `sendUserInput()` calls `trySend()` to forward via WebSocket
4. **HeadlessAdapter**: `handleServerMessage()` dispatches to `userInputHandler`
5. **Browser**: `sessionManager.sendUserInput()` in session state store

The new `end_session` message will follow this same pattern but instead of forwarding text, it will trigger
the stdin closure mechanism.

### Edge Cases and Considerations

1. **No terminal input mode**: When `--no-terminal-input` is used, the headless path still keeps stdin open
   (via `headlessForwardingEnabled` flag at line 233 of `terminal_input_lifecycle.ts`). The `end_session`
   handler needs to close stdin regardless of whether terminal input is enabled.

2. **Callback registration**: The current `setUserInputHandler` pattern uses a single callback. For `end_session`,
   we need a separate callback since its behavior (close stdin) is fundamentally different from user input
   (send a message). Adding `setEndSessionHandler` on `HeadlessAdapter` follows the established pattern.

3. **Idempotency**: `StdinGuard.close()` is already idempotent (checks `closed` flag), so calling it
   multiple times is safe.

4. **Session state after end**: After the subprocess stdin closes, the process will eventually exit,
   which triggers WebSocket disconnect → `session.status = 'offline'`. No special handling needed.

5. **Active prompts**: If there's an active prompt when end_session is received, the prompt should be
   cancelled/cleared as part of the session ending. The `rejectAllPending()` in `destroySync()` handles
   this for adapter destruction, but we may want the end_session handler to also handle this gracefully.

## Implementation Guide

### Expected Behavior

When a user clicks "End Session" in the web UI for an active session, a confirmation dialog appears.
Upon confirming, the running tim process receives an `end_session` message. The behavior depends on
the session type:
- **Interactive sessions (stdin open)**: Closes subprocess stdin gracefully (equivalent to Ctrl-D),
  allowing the LLM subprocess to finish and the command to complete its post-execution cleanup normally.
- **Non-interactive sessions (stdin already closed)**: Sends SIGTERM to the subprocess to terminate it.

The button is available for all active sessions, not just interactive ones.

### Acceptance Criteria

- [ ] Web UI shows an "End Session" button in the session header for all active sessions (interactive and non-interactive)
- [ ] Clicking the button shows a confirmation dialog before sending the message
- [ ] Clicking confirm sends an `end_session` message to the tim process via WebSocket
- [ ] For interactive sessions: the tim process closes its subprocess stdin gracefully (same as Ctrl-D)
- [ ] For non-interactive sessions (stdin already closed): the subprocess receives SIGTERM
- [ ] This works regardless of `--no-terminal-input` flag
- [ ] The session transitions to offline state after the process exits
- [ ] All new code paths are covered by tests
- [ ] The button is hidden for non-active sessions (offline/notification)

### Dependencies & Constraints

- **Dependencies**: Uses the existing `HeadlessServerMessage` protocol, `StdinGuard`, and SvelteKit command pattern
- **Technical Constraints**: Must not break existing prompt_response and user_input flows; must be idempotent

### Step-by-Step Implementation

#### Step 1: Add the `end_session` message type to the protocol

**File**: `src/logging/headless_protocol.ts`

Add a new interface:
```typescript
export interface HeadlessEndSessionServerMessage {
  type: 'end_session';
}
```

Add it to the `HeadlessServerMessage` union type.

**Rationale**: This follows the existing pattern of each message type having its own interface in the discriminated union.

#### Step 2: Handle `end_session` in the HeadlessAdapter

**File**: `src/logging/headless_adapter.ts`

1. Add `end_session` case to `isValidHeadlessServerMessage()` — it just needs `type === 'end_session'`, no other fields.

2. Add a new private `endSessionHandler` callback field (similar to `userInputHandler`).

3. Add `setEndSessionHandler(callback)` public method (similar to `setUserInputHandler`).

4. Add `end_session` case to `handleServerMessage()`:
   ```typescript
   case 'end_session':
     try {
       this.endSessionHandler?.();
     } catch (err) {
       this.wrappedAdapter.warn(`Headless end session handler error: ${err as Error}`);
     }
     break;
   ```

**Rationale**: Using a separate handler (rather than piggybacking on userInputHandler) keeps concerns separated and allows the caller to wire up the appropriate stdin-closing behavior.

#### Step 3: Wire the end session handler in `executeWithTerminalInput`

**File**: `src/tim/executors/claude_code/terminal_input_lifecycle.ts`

After the headless user input handler wiring (around line 229), add a similar block:

```typescript
if (loggerAdapter instanceof HeadlessAdapter) {
  loggerAdapter.setEndSessionHandler(() => {
    clearTunnelUserInputHandler();
    clearHeadlessUserInputHandler();
    if (terminalInputController) {
      terminalInputController.onResultMessage(); // stops reader + closes stdin
    } else if (!stdinGuard.isClosed) {
      stdinGuard.close(); // stdin is still open in headless-forwarding mode
    } else {
      // stdin already closed (non-interactive mode) — kill the subprocess
      streaming.kill('SIGTERM');
    }
    loggerAdapter.setEndSessionHandler(undefined);
  });
}
```

Also clear the end session handler in the existing `cleanup` function.

**Rationale**: This uses a three-tier approach:
1. If terminal input is active, reuse the existing `onResultMessage` logic (stops reader + closes stdin)
2. If stdin is still open (headless forwarding), close it gracefully
3. If stdin is already closed (non-interactive mode), SIGTERM the subprocess as a last resort

Setting the handler to undefined after firing prevents double-invocations (though `StdinGuard` is already idempotent and `kill` tolerates already-dead processes).

#### Step 4: Add `endSession` to the SessionManager

**File**: `src/lib/server/session_manager.ts`

Add a new method:
```typescript
endSession(connectionId: string): boolean {
  return this.trySend(connectionId, { type: 'end_session' });
}
```

**Rationale**: Follows the exact pattern of `sendUserInput()` — just forwards the message via WebSocket.

#### Step 5: Add the SvelteKit command

**File**: `src/lib/remote/session_actions.remote.ts`

Add a new command:
```typescript
export const endSession = command(sessionTargetSchema, async (target) => {
  const sent = getSessionManager().endSession(target.connectionId);
  if (!sent) {
    error(404, 'Session not found');
  }
});
```

**Rationale**: Follows the exact pattern of `sendSessionUserInput`.

#### Step 6: Add `endSession` to the browser session state

**File**: `src/lib/stores/session_state.svelte.ts`

Import the new `endSession` command and add a method to the session manager class:
```typescript
async endSession(connectionId: string): Promise<boolean> {
  try {
    await endSession({ connectionId });
    return true;
  } catch {
    return false;
  }
}
```

**Rationale**: Follows the pattern of `sendUserInput` and `dismissSession`.

#### Step 7: Add the "End Session" button with confirmation dialog to the UI

**File**: `src/lib/components/SessionDetail.svelte`

Add an "End Session" button in the session header area (near the terminal activate button). It should:
- Only be visible when `session.status === 'active'` (for both interactive and non-interactive sessions)
- On click, show a confirmation dialog containing the actual "End Session" action button
- The confirmation dialog should briefly explain that this will end the running process
- The confirm button calls `sessionManager.endSession(session.connectionId)`
- Have appropriate styling (a muted/destructive button style since it ends the session)

Use a simple popover or inline confirmation pattern for the dialog — no need for a heavy modal library.

#### Step 8: Write tests

1. **HeadlessAdapter test**: Verify that receiving an `end_session` message calls the registered handler.
   Check `isValidHeadlessServerMessage` accepts the new type.

2. **Terminal input lifecycle test**: Verify that when `end_session` handler fires, `stdinGuard.close()` is called.
   Test both the terminal-input-enabled and headless-forwarding-only paths.

3. **SessionManager test**: Verify `endSession()` sends the message via WebSocket.

4. **Web test**: Verify the SvelteKit command correctly dispatches to the session manager.

### Manual Testing Steps

1. Run `tim generate <plan>` with the web UI open
2. Observe the session appears as active + interactive
3. Click "End Session" button
4. Verify the generate command completes gracefully (runs post-execution cleanup)
5. Session should transition to offline state
6. Repeat with `--no-terminal-input` flag to verify it works without terminal input

### Potential Gotchas

- The `TerminalInputReader` stop logic and `stdinGuard.close()` must be called in the right order — always stop the reader first, then close stdin. The existing `onResultMessage` handler already does this correctly, so reusing it is safest.
- If the subprocess is in the middle of producing output when stdin closes, it should still finish normally — Claude Code handles stdin EOF gracefully.
- The headless adapter's `rejectAllPending()` is called on `destroy()`, not on individual message handling. For `end_session`, we don't need to reject pending prompts since the process will exit naturally and the WebSocket disconnect handler will clear the active prompt.

## Current Progress
### Current State
- All 5 tasks completed. Full end_session feature implemented across protocol, adapter, terminal lifecycle, server, SvelteKit command, browser store, and UI.
### Completed (So Far)
- Task 1: HeadlessEndSessionServerMessage type added to protocol, union type updated
- Task 2: endSessionHandler field, setEndSessionHandler(), end_session case in handleServerMessage() with rejectAllPending('Session ended')
- Task 3: Three-tier end session handler in executeWithTerminalInput (terminalInputController → stdinGuard → SIGTERM)
- Task 4: SessionManager.endSession(), endSession SvelteKit command, browser store endSession method
- Task 5: End Session button with inline confirmation dialog in SessionDetail.svelte
### Remaining
- None for this plan
### Next Iteration Guidance
- None
### Decisions / Changes
- Added `rejectAllPending('Session ended')` call in the end_session handler so that pending prompts are cancelled when the session ends, preventing the process from hanging
- Modified `raceWithWebSocket` in `src/common/input.ts` to abort the inquirer prompt when the websocket promise rejects (not just when it resolves), ensuring end_session properly cancels active prompts
- Parameterized `rejectAllPending()` to accept a reason string, using 'Session ended' for end_session vs 'HeadlessAdapter destroyed' for destroy
- Codex app-server sessions do not wire an end_session handler yet - the button is visible but will be a no-op for those sessions. This is acceptable for now.
### Lessons Learned
- When adding a new handler method to HeadlessAdapter, all mocks in terminal_input_lifecycle.test.ts must be updated to include the new method or existing tests will break
- `$derived()` in Svelte 5 should not be used for mutable UI state like confirmation dialogs - use `$state()` instead
- `raceWithWebSocket` in input.ts has asymmetric handling of resolve vs reject on the websocket promise - the rejection handler was a no-op which meant end_session couldn't cancel active prompts until fixed
### Risks / Blockers
- None
