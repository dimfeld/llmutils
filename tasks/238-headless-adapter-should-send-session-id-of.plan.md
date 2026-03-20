---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: headless adapter should send directory of switched-to workspace instead
  of current directory
goal: After workspace switching, the headless adapter sends an updated
  session_info message so the web UI groups the session under the correct
  workspace directory.
id: 238
uuid: edf0d437-8849-47af-b357-17137cea7db3
generatedBy: agent
status: pending
priority: medium
planGeneratedAt: 2026-03-20T19:09:25.484Z
promptsGeneratedAt: 2026-03-20T19:09:25.484Z
createdAt: 2026-03-19T01:16:52.190Z
updatedAt: 2026-03-20T19:09:25.484Z
tasks:
  - title: Add updateSessionInfo method to HeadlessAdapter
    done: false
    description: "In src/logging/headless_adapter.ts: remove `readonly` from
      `sessionInfo` field. Add a public `updateSessionInfo(patch:
      Partial<HeadlessSessionInfo>)` method that merges the patch into
      `this.sessionInfo` via Object.assign, then if the WebSocket is connected,
      enqueues a `session_info` control payload (using `enqueueControlPayload`)
      and triggers the drain loop to send it immediately."
  - title: Add updateHeadlessSessionInfo helper in headless.ts
    done: false
    description: "In src/tim/headless.ts: add an exported
      `updateHeadlessSessionInfo(patch: Partial<HeadlessSessionInfo>)` function
      that calls `getLoggerAdapter()`, checks `instanceof HeadlessAdapter`, and
      if so calls `adapter.updateSessionInfo(patch)`. Otherwise silently
      no-ops."
  - title: Call updateHeadlessSessionInfo after workspace setup
    done: false
    description: "In src/tim/workspace/workspace_setup.ts: after the
      `sendStructured({ type: workspace_info, ... })` call (around line 354),
      add a call to `updateHeadlessSessionInfo({ workspacePath: workspace.path
      })`. Only workspacePath needs updating since gitRemote stays the same."
  - title: Add HeadlessAdapter.updateSessionInfo tests
    done: false
    description: "In src/logging/headless_adapter.test.ts: add tests for
      updateSessionInfo: (1) merges patch into sessionInfo correctly, (2) sends
      session_info message immediately when connected, (3) updated info is used
      on reconnect handshake, (4) updates stored info even when disconnected."
  - title: Add updateHeadlessSessionInfo helper tests
    done: false
    description: "In src/tim/headless.test.ts: add tests for
      updateHeadlessSessionInfo: (1) calls updateSessionInfo when
      HeadlessAdapter is active logger, (2) no-ops when no headless adapter is
      active."
  - title: Add session_info re-send test in session manager
    done: false
    description: "In src/lib/server/session_manager.test.ts: add a test verifying
      that sending a second session_info message on the same connection
      correctly updates the session groupKey, workspacePath, and projectId, and
      emits a session:update event."
tags: []
---

If this is not possible due to the timing of the headless adapter setup, then we should have a way to send a message
that updates the directory of the current session. We should make sure that everything that consumes the directory (web
UI grouping, for example) can respond to changes in the project directory.

## Research

### Problem Statement

When a tim agent session switches to a workspace directory after startup, the headless adapter still reports the original directory (the git root where the command was launched) to the web UI. This causes the session to appear grouped under the wrong project/directory in the web interface.

### Timing Analysis

The key timing issue:

1. **`runWithHeadlessAdapterIfEnabled()`** is called in `src/tim/commands/agent/agent.ts:254-261`. It calls `buildHeadlessSessionInfo()` which captures `workspacePath` from `getRepositoryIdentity().gitRoot` — the **current directory at invocation time**.
2. The callback `timAgent()` runs inside the headless adapter wrapper.
3. Inside `timAgent()`, `setupWorkspace()` is called at line 312, which may change `currentBaseDir` to a different workspace directory.
4. The headless adapter already sent `session_info` with the old directory during its initial handshake.

So the headless adapter is set up **before** workspace switching happens, and the `sessionInfo` object is never updated afterward.

### Key Components and Their Roles

#### HeadlessAdapter (`src/logging/headless_adapter.ts`)
- Stores `sessionInfo: HeadlessSessionInfo` as a private readonly field (line 62).
- On connect/reconnect, `prependHandshakeMessages()` (line 416) sends a `session_info` message using `this.sessionInfo`.
- The `sessionInfo` is set once in the constructor and never updated.
- The adapter needs a method to update `sessionInfo` and optionally re-send `session_info` to the server.

#### HeadlessSessionInfo Protocol (`src/logging/headless_protocol.ts`)
- Interface with fields: `command`, `interactive`, `planId`, `planTitle`, `workspacePath`, `gitRemote`, `terminalPaneId`, `terminalType`.
- `HeadlessSessionInfoMessage` extends it with `type: 'session_info'`.
- The server already handles `session_info` messages idempotently — it fully replaces `session.sessionInfo` and recomputes `groupKey` and `projectId` (session_manager.ts:821-839).

#### Session Manager (`src/lib/server/session_manager.ts`)
- `handleWebSocketMessage()` case `'session_info'` (line 821) already handles re-sent `session_info` messages correctly:
  - Replaces `session.sessionInfo` entirely
  - Recomputes `session.groupKey = sessionGroupKey(gitRemote, workspacePath)`
  - Recomputes `session.projectId`
  - Calls `reconcileNotificationSession()`
  - Emits `session:update` event
- **The server side already supports session info updates.** No server changes are needed for the basic case.

#### Web UI Session Event Handling
- `session:update` events are handled in `src/lib/stores/session_state_events.ts:93-100`.
- The `mergeSessionPreservingMessages()` function merges incoming session metadata while keeping existing messages.
- `sessionGroups` in `src/lib/stores/session_state.svelte.ts` is a derived/computed property that re-groups sessions whenever the sessions map changes.
- **The web UI already supports dynamic session updates.** When a `session:update` event arrives with new groupKey data, the session will be re-grouped automatically.

#### Workspace Setup (`src/tim/workspace/workspace_setup.ts`)
- `setupWorkspace()` already sends a `workspace_info` structured message (line 348-354) after switching directories.
- This `workspace_info` message flows through the headless adapter as a regular output message but is **not** used to update session metadata.

#### Session Group Key Construction
- `sessionGroupKey()` at `src/lib/server/session_manager.ts:617` creates keys as `"${normalizedGitRemote}|${workspacePath}"`.
- `getSessionGroupKey()` in `src/lib/stores/session_group_utils.ts:1` creates client-side group keys from `projectId` and `groupKey`.
- Group labels show last 2 path segments of workspace path.

### Critical Finding: Server Already Handles Updates

The most important discovery is that the **server-side `session_info` handler is already idempotent**. Sending a second `session_info` message over the same WebSocket connection will correctly update the session's `workspacePath`, `groupKey`, and `projectId`, and emit a `session:update` event. The web UI's reactive system will re-group the session automatically.

This means the implementation is primarily about:
1. Making `HeadlessAdapter.sessionInfo` mutable and providing an update method.
2. Calling that update method after workspace setup completes.

### Approach: Update `sessionInfo` on HeadlessAdapter

The simplest and most robust approach is to:
1. Add an `updateSessionInfo(patch)` method to `HeadlessAdapter` that merges partial updates into `sessionInfo` and immediately sends a new `session_info` message over the WebSocket.
2. Expose this through the `LoggerAdapter` interface or a separate mechanism accessible after workspace setup.
3. Call it from `workspace_setup.ts` or `agent.ts` after workspace switching.

### Access Pattern Consideration

The headless adapter is set via `runWithLogger()` which stores it as the active logger adapter. The current adapter can be retrieved via `getLoggerAdapter()`. We need to either:
- Add the `updateSessionInfo` method to the `LoggerAdapter` interface (pollutes the interface for all adapters), OR
- Add a standalone function that checks if the current adapter is a `HeadlessAdapter` and calls the method on it, OR
- Have the workspace setup code use a callback/hook pattern to notify the headless adapter.

The cleanest approach is a standalone function in `src/tim/headless.ts` like `updateHeadlessSessionInfo(patch)` that safely checks and delegates. This follows the existing pattern where `headless.ts` provides high-level functions.

## Implementation Guide

### Expected Behavior
After workspace switching, the headless adapter sends an updated `session_info` message to the web server, causing the session to be re-grouped under the correct workspace directory. The web UI updates in real time to reflect the new directory.

### Key Findings
- **Product & User Story**: When an agent switches to a workspace, the web UI session should immediately reflect the correct workspace directory in its grouping and display.
- **Design & UX Approach**: No UX changes needed — the web UI already supports dynamic session updates via `session:update` events.
- **Technical Plan & Risks**: Low risk. The server-side `session_info` handler is already idempotent. Main work is making `HeadlessAdapter.sessionInfo` updatable and wiring it up.
- **Pragmatic Effort Estimate**: Small (1-2 hours). The server and web UI already handle the update path correctly.

### Acceptance Criteria
- [ ] When an agent switches to a workspace, the session's `workspacePath` is updated in the web UI.
- [ ] Session grouping in the web UI reflects the updated workspace directory.
- [ ] On reconnect, the headless adapter sends the updated (not original) `session_info`.
- [ ] All new code paths are covered by tests.

### Dependencies & Constraints
- **Dependencies**: Relies on existing `HeadlessAdapter`, `LoggerAdapter` interface, and `session_info` handling in `SessionManager`.
- **Technical Constraints**: The `HeadlessAdapter` is accessed indirectly via the logger adapter system. Must avoid tight coupling.

### Implementation Notes

#### Step 1: Make `HeadlessAdapter.sessionInfo` mutable and add update method

In `src/logging/headless_adapter.ts`:

1. Change `private readonly sessionInfo: HeadlessSessionInfo` to `private sessionInfo: HeadlessSessionInfo` (remove `readonly`).
2. Add a public `updateSessionInfo(patch: Partial<HeadlessSessionInfo>)` method that:
   - Merges the patch into `this.sessionInfo` via `Object.assign(this.sessionInfo, patch)`.
   - If the WebSocket is connected, immediately enqueues and sends a `session_info` message (same format as in `prependHandshakeMessages()`).
   - The next reconnect handshake will automatically use the updated `sessionInfo` since `prependHandshakeMessages()` reads `this.sessionInfo`.

#### Step 2: Add `updateHeadlessSessionInfo()` helper in `src/tim/headless.ts`

Add a function that:
1. Gets the current logger adapter via `getLoggerAdapter()`.
2. Checks if it's a `HeadlessAdapter` (using `instanceof`).
3. If so, calls `adapter.updateSessionInfo(patch)`.
4. If not (e.g., wrapped adapter or no headless), silently no-ops.

This follows the existing pattern where `headless.ts` provides high-level entry points that safely interact with the headless adapter.

However, there's a subtlety: `runWithHeadlessAdapterIfEnabled()` wraps the existing adapter with `HeadlessAdapter`, then uses `runWithLogger()` to set it as the active adapter. The callback runs with the `HeadlessAdapter` as the current logger. So `getLoggerAdapter()` inside the callback will return the `HeadlessAdapter` directly.

#### Step 3: Call the update after workspace setup in `workspace_setup.ts`

In `src/tim/workspace/workspace_setup.ts`, after the workspace directory change (around line 347-354 where `workspace_info` is already sent):

1. Import `updateHeadlessSessionInfo` from `src/tim/headless.ts`.
2. After `sendStructured({ type: 'workspace_info', ... })`, call `updateHeadlessSessionInfo({ workspacePath: workspace.path })`.
3. If the workspace also changes the git remote (unlikely but possible for cross-repo workspaces), include `gitRemote` in the patch as well.

#### Step 4: Tests

**HeadlessAdapter unit tests** (`src/logging/headless_adapter.test.ts`):
- Test that `updateSessionInfo()` merges the patch correctly.
- Test that calling `updateSessionInfo()` when connected sends a `session_info` message immediately.
- Test that after `updateSessionInfo()`, a reconnect handshake uses the updated info.
- Test that `updateSessionInfo()` when disconnected still updates the stored info (for next connect).

**Integration-level test** (`src/tim/headless.test.ts`):
- Test that `updateHeadlessSessionInfo()` works when a `HeadlessAdapter` is the current logger.
- Test that `updateHeadlessSessionInfo()` no-ops when no headless adapter is active.

**Session manager test** (`src/lib/server/session_manager.test.ts`):
- Verify that a second `session_info` message on the same connection correctly updates groupKey and projectId and emits `session:update`. (This likely already works but should have explicit test coverage.)

#### Step 5: Format and verify

Run `bun run format`, `bun run check`, and `bun run test` to ensure everything passes.

### Potential Gotchas

1. **The `sessionInfo` field is currently `readonly`** — must remove the `readonly` modifier.
2. **Message ordering**: The `session_info` update message should be sent as a control payload (not output), so it doesn't count against the buffer limit. Use `enqueueControlPayload()` similar to how handshake messages are queued.
3. **Reconnection behavior**: `prependHandshakeMessages()` already reads `this.sessionInfo` each time, so updated info will naturally be used on reconnect. No special handling needed.
4. **Thread safety**: Bun is single-threaded, so no concurrency concerns with updating `sessionInfo`.
5. **Multiple workspace switches**: If the agent switches workspaces multiple times (unlikely but possible), each update should work correctly since the server replaces the entire `sessionInfo`.
