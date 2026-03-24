---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: prompt that is cancelled due to timeout should inform websocket
goal: ""
id: 260
uuid: b3a56bfd-a1f0-4565-b612-16fa6e180448
generatedBy: agent
status: pending
priority: medium
planGeneratedAt: 2026-03-24T00:36:20.721Z
promptsGeneratedAt: 2026-03-24T00:36:20.721Z
createdAt: 2026-03-23T19:17:13.967Z
updatedAt: 2026-03-24T00:36:20.721Z
tasks:
  - title: Define PromptCancelledMessage type
    done: false
    description: "In src/logging/structured_messages.ts: Add a new
      PromptCancelledMessage interface with type prompt_cancelled and requestId
      string (no reason field). Add it to the StructuredMessage union type and
      to structuredMessageTypeList."
  - title: Add sendPromptCancelled() helper and wire into raceWithWebSocket
    done: false
    description: "In src/common/input.ts: Add sendPromptCancelled(promptMessage:
      PromptRequestMessage) function that calls sendStructured() with a
      PromptCancelledMessage. Then in raceWithWebSocket() at the inner catch
      block (line ~177-179 where both channels failed), call
      sendPromptCancelled(promptMessage) before re-throwing the error."
  - title: Handle prompt_cancelled in SessionManager
    done: false
    description: "In src/lib/server/session_manager.ts in
      handleStructuredSideEffects(): Add a handler for prompt_cancelled that
      mirrors the prompt_answered handler — clear session.activePrompt if
      requestId matches, clear deferred prompt event if requestId matches, and
      emit session:prompt-cleared event if anything was cleared and not
      replaying."
  - title: Add tests for prompt cancellation
    done: false
    description: Add unit test in src/common/input.test.ts verifying that when a
      prompt times out in raceWithWebSocket, a prompt_cancelled structured
      message is sent with the correct requestId. Add unit test in
      SessionManager tests verifying that processing a prompt_cancelled message
      clears activePrompt and emits session:prompt-cleared.
tags: []
---

Not sure if this is actually a problem in the web client or if something needs to change with the structured message
system, but when a prompt is cancelled due to time out, it doesn't disappear from the web client.

## Research

### Problem Overview

When a prompt times out on the agent side, the web UI continues to display the prompt because no structured message is sent to inform the server that the prompt was cancelled. The web UI's `activePrompt` state is never cleared, leaving a stale prompt visible that can no longer be answered.

### Root Cause Analysis

The prompt lifecycle has two successful resolution paths that both call `sendPromptAnswered()`:

1. **Terminal wins the race** (`src/common/input.ts:167`): `sendPromptAnswered(promptMessage, value, 'terminal')`
2. **WebSocket wins the race** (`src/common/input.ts:175`): `sendPromptAnswered(promptMessage, wsValue, 'websocket')`

However, when a **timeout** occurs (line 177-179), neither channel resolves — both are cancelled/failed — and the error is re-thrown **without** sending any `prompt_answered` or cancellation message:

```typescript
} catch {
  // WS was also cancelled/failed -- rethrow the original error (likely timeout)
  throw err;
}
```

The same gap exists in the non-headless (terminal-only) paths. Each prompt function (e.g., `promptConfirm` at line 233-244) calls `sendPromptAnswered` only on the success path. When the inquirer prompt throws `AbortPromptError` due to timeout, the error propagates up without any structured message being sent.

### Key Findings

#### Current Structured Message Types

- `prompt_request` — sent when a prompt is created (has `requestId`, `promptType`, `promptConfig`, `timeoutMs`)
- `prompt_answered` — sent when a prompt is successfully resolved (has `requestId`, `value`, `source`)
- **No `prompt_cancelled` type exists** — this is the missing piece

#### Server-Side Prompt Clearing Logic (`src/lib/server/session_manager.ts:1219-1237`)

The `handleStructuredSideEffects()` method clears `session.activePrompt` in two cases:
1. A `prompt_answered` message arrives with a matching `requestId`
2. A new `prompt_request` arrives (clears the previous prompt first, line 1192-1198)

There is no handler for a cancellation/timeout scenario.

#### Client-Side Event Handling (`src/lib/stores/session_state_events.ts:102-120`)

The client store handles two prompt events:
- `session:prompt` — sets `activePrompt`
- `session:prompt-cleared` — clears `activePrompt` if `requestId` matches

These events are emitted by the server's SessionManager. The client-side code needs no changes — it already handles `session:prompt-cleared` correctly. The fix is entirely about ensuring the server receives notification that the prompt was cancelled.

#### Affected Code Path

The fix is needed only in `raceWithWebSocket()` (`src/common/input.ts:133-184`), which is the path used when a HeadlessAdapter is present (i.e., a web UI is connected). Both terminal and WS are cancelled, error re-thrown at line 179 without any notification.

The terminal-only paths (no headless adapter) don't need changes since there's no web UI to display a stale prompt.

#### Relevant Files

| File | Role |
|------|------|
| `src/logging/structured_messages.ts` | Define new `PromptCancelledMessage` type here |
| `src/common/input.ts` | Add `sendPromptCancelled()` calls on timeout/error paths |
| `src/lib/server/session_manager.ts` | Handle the new `prompt_cancelled` message type |
| `src/lib/stores/session_state_events.ts` | No changes needed (already handles `session:prompt-cleared`) |
| `src/common/input.test.ts` | Add test coverage for cancellation message sending |

#### Design Considerations

- **New message type vs. reusing `prompt_answered`**: A new `prompt_cancelled` message type is cleaner because it semantically represents a different outcome (no value was produced). The `prompt_answered` type has a `source` field that doesn't apply to cancellations, and reusing it would require making `value` explicitly nullable and `source` optional — less clean.

- **Where to send the cancellation**: The cancellation message should be sent in the same places where `sendPromptAnswered` is called — inside `src/common/input.ts`. This keeps the prompt lifecycle management centralized.

- **Tunnel adapter path**: When running as a subagent through a tunnel, the tunnel adapter handles its own timeout (`src/logging/tunnel_client.ts`). The prompt_request is sent to the orchestrator, not directly to the web UI. The orchestrator's prompt functions will handle the structured message. So the tunnel path does not need changes — the fix is in the prompt functions that directly interact with the headless adapter.

### Expected Behavior/Outcome

- When a prompt is cancelled (timeout, session end, etc.) in the `raceWithWebSocket` path, a `prompt_cancelled` structured message is sent with the `requestId`.
- The server's `SessionManager` receives this message and clears `session.activePrompt`, emitting `session:prompt-cleared`.
- The web UI reactively removes the stale prompt from display.
- The prompt disappears from the web client within the normal SSE event propagation time (near-instant).

### Acceptance Criteria

- [ ] A new `PromptCancelledMessage` structured message type is defined
- [ ] When a prompt is cancelled (timeout or other failure) in `raceWithWebSocket`, a `prompt_cancelled` message is sent with the matching `requestId`
- [ ] The `SessionManager` handles `prompt_cancelled` and clears the active prompt
- [ ] The web UI prompt disappears when a timeout occurs
- [ ] All new code paths are covered by tests

### Dependencies & Constraints

- **Dependencies**: Relies on existing `StructuredMessage` union type, `sendStructured()`, and `SessionManager` event system.
- **Technical Constraints**: The cancellation message must be sent before the timeout error propagates to callers, since callers may log or take actions that produce other structured messages (which could cause ordering issues if the prompt is still considered "active").

### Implementation Notes

- **Recommended Approach**: Add a new `PromptCancelledMessage` type (no `reason` field) and a `sendPromptCancelled()` helper. Add the cancellation call in `raceWithWebSocket()`'s failure path only. Handle `prompt_cancelled` in `handleStructuredSideEffects()` the same way as `prompt_answered` for clearing purposes.
- **Potential Gotchas**: The `raceWithWebSocket` function's catch block at line 169-180 needs careful handling — the cancellation should only be sent when both channels fail (the current `throw err` path), not when the WS channel wins the race (which is a success, not a cancellation).

## Implementation Guide

### Step 1: Define the `PromptCancelledMessage` type

In `src/logging/structured_messages.ts`:

1. Add a new interface `PromptCancelledMessage` after `PromptAnsweredMessage` (around line 258):
   - `type: 'prompt_cancelled'`
   - `requestId: string` — matches the original `prompt_request`
   - No `reason` field — keep it simple
2. Add `PromptCancelledMessage` to the `StructuredMessage` union type (after `PromptAnsweredMessage`)
3. Add `'prompt_cancelled'` to `structuredMessageTypeList`

### Step 2: Add `sendPromptCancelled()` helper

In `src/common/input.ts`:

1. Add a new function `sendPromptCancelled(promptMessage: PromptRequestMessage)` similar to `sendPromptAnswered()`.
2. It should call `sendStructured()` with a `PromptCancelledMessage` containing the `requestId`.

### Step 3: Send cancellation in `raceWithWebSocket()`

In the `raceWithWebSocket()` function (`src/common/input.ts:133-184`):

At line 177-179, before re-throwing the error, send the cancellation:

```typescript
} catch {
  // WS was also cancelled/failed -- send cancellation and rethrow (likely timeout)
  sendPromptCancelled(promptMessage);
  throw err;
}
```

This is the only code path that needs the fix. The terminal-only paths (no headless adapter) don't need changes because there's no web UI connected to display a stale prompt.

### Step 4: Handle `prompt_cancelled` in SessionManager

In `src/lib/server/session_manager.ts`, in the `handleStructuredSideEffects()` method (around line 1219):

Add a handler for `prompt_cancelled` that mirrors the `prompt_answered` handler:

```typescript
if (message.type === 'prompt_cancelled') {
  const requestId = message.requestId;
  let cleared = false;

  if (session.activePrompt?.requestId === requestId) {
    session.activePrompt = null;
    cleared = true;
  }
  const internals = this.internals.get(connectionId);
  if (internals?.deferredPromptEvent?.requestId === requestId) {
    internals.deferredPromptEvent = null;
    cleared = true;
  }

  if (cleared && !session.isReplaying) {
    this.emit('session:prompt-cleared', { connectionId, requestId });
  }
}
```

No changes are needed in the client-side store (`session_state_events.ts`) since it already handles `session:prompt-cleared` events.

### Step 5: Add tests

1. **Unit test in `src/common/input.test.ts`**: Verify that when a prompt times out in `raceWithWebSocket`, a `prompt_cancelled` structured message is sent with the correct `requestId`.

2. **Unit test in SessionManager tests**: Verify that when a `prompt_cancelled` structured message is processed, `session.activePrompt` is cleared and `session:prompt-cleared` event is emitted.

### Manual Testing Steps

1. Start the web UI and connect an agent session
2. Trigger a prompt with a short timeout (e.g., permission prompt with 10-second timeout in executor config)
3. Wait for the timeout to fire without answering the prompt
4. Verify the prompt disappears from the web UI
5. Verify the agent continues normally (applies default response)

### Rationale

- **New message type over reusing `prompt_answered`**: Cancellation is semantically distinct — there's no value and no source. A dedicated type is cleaner and avoids ambiguity.
- **Centralized in `input.ts`**: All prompt lifecycle management is already in this file. Adding cancellation here keeps the pattern consistent.
- **Only `raceWithWebSocket` path**: Terminal-only paths don't have a web UI connected, so sending cancellation there would be unnecessary.
- **Using existing `session:prompt-cleared` event**: The client-side already handles this event correctly. No UI changes needed — the existing reactive clearing mechanism works for both answers and cancellations.
