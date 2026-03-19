---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: web notifications support
goal: "Replicate the tim-gui notification system in the web interface:
  server-computed notification triggers and text, client-side in-UI notification
  state (blue dots, notification messages), browser notifications via Web
  Notifications API, and a global header bell button for navigation."
id: 237
uuid: a3908bae-f909-4424-ba9a-dfa6f4caf968
status: done
priority: medium
planGeneratedAt: 2026-03-19T06:50:50.976Z
promptsGeneratedAt: 2026-03-19T06:50:50.976Z
createdAt: 2026-03-18T21:52:45.558Z
updatedAt: 2026-03-19T07:53:05.515Z
tasks:
branch: 237-web-notifications-support
tags: []
reviewIssues:
  - severity: major
    category: testing
    content: "The new tests do not exercise the reconnect/sync path that the
      implementation claims to support. They force `manager.initialized = true`
      up front and the only `session:list` reconciliation test covers prompt
      notifications only. That misses both regressions above: message
      notifications being closed by snapshot reconciliation and pre-sync events
      being dropped."
    file: src/lib/stores/session_notifications.test.ts
    line: 187-189, 515-597
    suggestion: "Add tests for: 1) a seq-0 message notification surviving
      `session:list` when the session still exists, and 2) `session:list` plus
      buffered `session:prompt`/`session:message` before
      `session:sync-complete`."
  - severity: major
    category: bug
    content: The session:list reconciliation logic closes browser notifications for
      sessions that exist but have no activePrompt. However, browser
      notifications can also be created by session:message events (seq===0) for
      notification-type sessions. These sessions typically have no activePrompt.
      On SSE reconnect, the session:list reconciliation will close these browser
      notifications even though the notification session is still active and the
      user may not have interacted with them yet.
    file: src/lib/stores/session_notifications.ts
    line: 89-93
    suggestion: "Also check if the session has notification-origin messages
      (seq===0) before closing: if (session && !session.activePrompt) { const
      hasNotificationMessages = session.messages.some((m) => m.seq ===
      NOTIFICATION_SEQ); if (!hasNotificationMessages) { closeNotification(tag);
      } }"
---

When a notification comes in we should trigger a browser notification so that the user can respond. This replicates the behavior of the tim-gui native macOS app.

## Expected Behavior/Outcome

The web interface fires browser notifications and tracks in-UI notification state for three categories of events, matching the behavior of the native tim-gui app:

1. **Prompt requests**: When an agent needs user input (`prompt_request` or `input_required` messages)
2. **Agent done/disconnect**: When an interactive session's turn completes, or a non-interactive session disconnects
3. **One-off HTTP notifications**: Messages arriving via the `/messages` POST endpoint

**Server-computed notification data:**
- The server evaluates notification triggers and computes notification text, keeping the client simple
- `DisplayMessage` gets an optional `notification?: { text: string }` field for message-based triggers (done/completion, HTTP notifications)
- `SessionData` gets an optional `lastNotification?: { text: string }` field for disconnect notifications (sent in `session:disconnect` events)
- Prompt notifications are the exception: the client formats text from `prompt.promptConfig` directly since the data is already in the prompt event

**Server notification trigger rules (matching tim-gui):**
- `task_completion` messages: Only when `transportSource` is NOT `'tunnel'` (filters out subagent completions). Only for interactive sessions.
- Disconnect: Only for non-interactive sessions. Notification text is the latest model response, then any text body, then "Session finished".
- HTTP `/messages`: Always triggers. Text is `payload.message`.

**In-UI notification state** (per session, client-side only):
- `hasUnreadNotification`: Boolean flag, shown as a blue dot on the session row
- `notificationMessage`: Text summary shown in the session row subtitle
- Always set regardless of page visibility or whether the session is currently selected
- Cleared when the user: clicks the session row, clicks the terminal icon, scrolls the message area, responds to a prompt, or sends input
- A bell button in the global app header navigates to the first session with an unread notification

**Browser notifications** (via Web Notifications API):
- Fire for all three notification categories above
- Only fire when the page is not visible/focused (in-UI dots always appear)
- Single on/off toggle — no per-category granularity
- Title: "Tim", Body: the notification message text
- Clicking navigates to the relevant session and focuses the tab
- Dot indicator on the bell icon (blue, same as session row dots) — no count badge

**Permission states:**
- **Not requested / default**: Bell icon in global header allows enabling; clicking requests permission
- **Granted + enabled**: Notifications active; bell icon shows active state
- **Granted + disabled**: User toggled off; bell icon shows inactive state
- **Denied**: Bell with slash; tooltip explains how to reset in browser settings

## Key Findings

### Product & User Story
As a user monitoring multiple agent sessions, I want to receive browser notifications and see in-UI unread indicators when an agent needs my input or completes work, so I can respond promptly without constantly watching the sessions tab. This replicates the notification behavior of the native tim-gui macOS app.

### Design & UX Approach
- **In-UI notifications** (always active, no permission needed): Blue unread dot on session rows, notification message in session row subtitle, bell button in global header to jump to first notification
- **Browser notifications** (requires permission): Single toggle in app header, fires via Web Notifications API when page is not visible
- Server computes notification trigger + text for done/disconnect/HTTP cases; client formats prompt notification text from prompt event data

### Technical Plan & Risks
- **Low risk**: Web Notifications API is well-supported in modern browsers
- **Low risk**: Server-side notification computation keeps client logic simple
- **Medium risk**: Server notification text extraction for done/disconnect events requires scanning recent messages for the latest model response — same logic as tim-gui but implemented in TypeScript
- **Low risk**: Integration points are well-defined — SSE events and `DisplayMessage`/`SessionData` extensions

### Pragmatic Effort Estimate
Medium feature. Server-side notification trigger evaluation + text extraction, client-side in-UI state management, browser notification permission handling, and UI updates to session components and global header.

## Acceptance Criteria

- [ ] Server adds `notification?: { text: string }` to `DisplayMessage` for done/completion and HTTP notification messages
- [ ] Server adds `lastNotification?: { text: string }` to `SessionData` for disconnect events
- [ ] Server skips tunnel-sourced `task_completion` messages for notification triggers
- [ ] Server only triggers done notifications for interactive sessions
- [ ] Server only triggers disconnect notifications for non-interactive sessions
- [ ] Client tracks `hasUnreadNotification` and `notificationMessage` per session (client-side only)
- [ ] Blue unread dot appears on session rows with unread notifications
- [ ] Notification message text appears in session row subtitle for notification-only sessions
- [ ] Bell button in global app header shows dot when any session has unread notification; clicking navigates to first unread session
- [ ] Notification clears on: session row click, terminal icon click, message scroll, prompt response, input send
- [ ] Prompt events trigger in-UI notification with text formatted from prompt config
- [ ] Browser notifications fire when the page is not visible (with Web Notifications API)
- [ ] Clicking a browser notification navigates to the session and focuses the tab
- [ ] User can enable/disable browser notifications via a single toggle
- [ ] Browser notification preference persists across page reloads (localStorage)
- [ ] No notifications fire during initial SSE sync (before `session:sync-complete`)
- [ ] All new code paths are covered by tests

## Dependencies & Constraints

- **Dependencies**: Relies on the existing SSE event system and `SessionManager` client/server stores
- **Technical Constraints**: Web Notifications API requires user gesture for permission request; HTTPS or localhost required
- **Browser Support**: All modern browsers support the Notifications API; no polyfill needed

## Implementation Notes

### Recommended Approach
The implementation spans server and client:

1. **Server-side notification computation**: The server evaluates notification triggers in `session_manager.ts` and computes notification text. For message-based triggers, it adds a `notification: { text }` field to the `DisplayMessage`. For disconnect triggers, it adds `lastNotification: { text }` to the `SessionData` sent in the `session:disconnect` event. This keeps the client simple — no need to parse message types or scan message history.

2. **Client-side in-UI notification state**: `hasUnreadNotification` and `notificationMessage` fields on client-side `SessionData`, set when notification data arrives via SSE events. Always set regardless of visibility or selected session.

3. **Browser notifications**: A notification utility module handles permission management, visibility detection, and browser notification creation. Fires browser notifications as a side effect when in-UI notification state is set, but only when the page is not visible.

### Server-Side Notification Triggers (matching tim-gui)

1. **Done/turn completion** (`task_completion` messages):
   - Only for interactive sessions
   - Only when `transportSource` is NOT `'tunnel'` (filters out subagent completions)
   - Notification text: scan session messages in reverse for latest `llm_response` text body, normalize whitespace, truncate to ~220 chars. Falls back to "Done".

2. **Session disconnect** (in `handleWebSocketDisconnect()`):
   - Only for non-interactive sessions
   - Notification text: same reverse scan for latest model response, then any text/monospaced body, then "Session finished"
   - Set on `SessionData.lastNotification` before emitting `session:disconnect`

3. **HTTP `/messages` notifications** (in `handleHttpNotification()`):
   - Always triggers
   - Notification text: `payload.message`
   - Set on the `DisplayMessage.notification` field

4. **Prompt requests** (client-side only):
   - Client formats text from `prompt.promptConfig`: `"Prompt ({promptType}): {message}"` or `"Input required: {prompt}"`
   - No server changes needed for this path

### Client-Side Notification Clearing
Notification clears on any user interaction with the session:
- Clicking the session row to select it
- Clicking the terminal icon for that session
- Scrolling in the message area
- Responding to a prompt via PromptRenderer
- Sending input via MessageInput

### Potential Gotchas
- `Notification.requestPermission()` must be called from a user gesture (click handler), not on page load
- Events during initial SSE sync (before `session:sync-complete`) should NOT trigger notifications
- `Notification.onclick` needs `window.focus()` to bring the tab to front on some browsers
- The `session:disconnect` event uses `cloneSessionMetadata()` which sends empty messages array — `lastNotification` must be computed before cloning

## Research

### Architecture Overview

The web interface uses a three-tier real-time architecture:
1. **WebSocket server** (port 8123): Agents connect here for bidirectional communication
2. **Server-side SessionManager** (`src/lib/server/session_manager.ts`): Routes messages, manages session state, emits events
3. **SSE streaming** to browser: `/api/sessions/events` streams events to the client-side `SessionManager`

### Tim-GUI Notification Behavior (reference implementation)

The native macOS tim-gui app (`tim-gui/TimGUI/SessionState.swift`) implements three notification triggers:

1. **Prompt requests** — `ingestNotification(connectionId:tunnelMessage:)` method handles `prompt_request` and `input_required` structured messages. Sets `hasUnreadNotification = true` and `notificationMessage` on the session, then posts a macOS system notification via `UNUserNotificationCenter`.

2. **Done/turn completion** — `maybeNotifyForDoneMessage(in:latestMessage:)` fires only for **interactive** sessions. It checks `isDoneNotificationTrigger()` which matches:
   - Messages with `completionKind == .topLevel` (maps to `task_completion` with `planComplete: true`)
   - Lifecycle messages with title "Turn Done" (maps to `task_completion` messages generally)
   - Only fires for messages NOT from the tunnel transport source (i.e. only top-level agent messages)

   The notification text is extracted via `doneNotificationText()`: scan messages in reverse for the latest `llm_response` text (title == "Model Response"), normalize whitespace, truncate to 220 chars. Falls back to "Done" or the trigger message title.

3. **Session disconnect** — `maybeNotifyForDisconnect(in:)` fires only for **non-interactive** sessions (checked in `markDisconnected()`). Notification text from `disconnectNotificationText()`: same reverse scan for latest model response, then any text/monospaced message body, then any message title, finally "Session finished".

4. **HTTP `/messages` notifications** — `ingestNotification(payload:)` always fires a system notification. Sets `hasUnreadNotification = true` and `notificationMessage = payload.message` on the matched or newly-created session.

### In-UI Notification State in Tim-GUI

`SessionItem` has:
- `hasUnreadNotification: Bool` — shown as blue dot on session row and group header
- `notificationMessage: String?` — shown in session row subtitle for notification-only sessions

Clearing behavior:
- `markNotificationRead(sessionId:)` sets `hasUnreadNotification = false`
- Called when user taps session row (`handleSessionListItemTap()`) or terminal icon (`handleTerminalIconTap()`)

UI elements:
- `SessionGroupHeaderView`: Blue notification dot (opacity-controlled), visible when group is collapsed AND has unread notification
- `SessionRowView`: Blue circle dot when `hasUnreadNotification`, notification message text for notification-only sessions (empty command)
- Toolbar bell button: Jumps to `firstSessionWithNotification` (iterates grouped sessions in display order), expands collapsed group, selects session

### Key Integration Points: SSE Events

The client-side `SessionManager` (in `src/lib/stores/session_state.svelte.ts`) delegates event processing to `applySessionEvent()` in `src/lib/stores/session_state_events.ts`. The relevant events:

- **`session:prompt`**: Contains `connectionId` and `prompt` (with `requestId`, `promptType`, `promptConfig.message`). Currently sets `activePrompt` on the session.
- **`session:message`**: Contains `connectionId` and `message` (with `rawType`, `category`, `body`). This is where done/completion messages arrive.
- **`session:disconnect`**: Contains full `session` data with `status: 'offline'`. This is where disconnect notifications trigger.
- **`session:new`** / **`session:update`**: For HTTP notification sessions (status `'notification'`), the notification message arrives as a `session:message` event.
- **`session:prompt-cleared`**: Contains `connectionId` and `requestId`. Used to close browser notifications.

### Message Types Relevant to Done Detection

In the web server's `summarizeStructuredMessage()` (session_manager.ts lines 218-347):
- `task_completion` → category `'progress'`, body text like "Plan completed..." or "Task completed...". The raw `message.planComplete` boolean indicates top-level completion, but this info is lost in the display message text. The `rawType` field preserves the original structured message type name.
- `agent_session_end` → category `'lifecycle'`, body text includes "Agent session completed" or "Agent session failed"
- `llm_response` → category `'llmOutput'`, body type `'text'`

With the server-computed approach, the server checks these `rawType` values and `transportSource` field when deciding whether to set the `notification` field on the `DisplayMessage`. The client doesn't need to inspect these — it just checks for the presence of `message.notification`.

### Server-Side DisplayMessage and SessionData Types

The server's `DisplayMessage` interface (in `session_manager.ts`) needs an optional `notification` field:
```
notification?: { text: string }
```

The server's `SessionData` (also in `session_manager.ts`) needs an optional `lastNotification` field:
```
lastNotification?: { text: string }
```

Both types are mirrored in the client's `src/lib/types/session.ts`.

The client-side `SessionData` also needs client-only fields (not sent by server):
- `hasUnreadNotification: boolean` — initialized to `false`, set by client when notification data arrives
- `notificationMessage: string | null` — initialized to `null`, set by client

### Server-Side Notification Text Extraction

The server needs functions matching tim-gui's `SessionState.swift` logic:

**For done/completion** (matching `doneNotificationText()`):
- Scan `session.messages` in reverse for the latest `llm_response` (`rawType === 'llm_response'`) with a text body
- Normalize: collapse whitespace to single spaces, truncate to 220 chars with `…`
- Falls back to `"Done"`

**For disconnect** (matching `disconnectNotificationText()`):
- Same reverse scan for latest model response
- Then any text/monospaced message body
- Finally `"Session finished"`

**For HTTP notifications**: Use `payload.message` directly.

### StructuredMessageBase.transportSource

The `transportSource` field is already in `StructuredMessageBase` (`src/logging/structured_messages.ts`). It's set to `'tunnel'` when the message came from a subagent process. The server's `summarizeStructuredMessage()` function receives the full `StructuredMessage` and can check `message.transportSource` before setting the notification field.

### Client-Side Initialization Flow

In `src/routes/+layout.svelte`:
1. `setSessionManager()` creates the singleton `SessionManager` via `createContext()` (Svelte 5)
2. `onMount()` calls `sessionManager.connect()` which establishes SSE
3. SSE events flow through `handleSseEvent()` → `applySessionEvent()`
4. `initialized` flag is `false` until `session:sync-complete` — notifications must not fire until this is `true`

### Page Visibility API

No existing visibility detection in the codebase. Standard approach:
- `document.visibilityState === 'visible'` / `'hidden'`
- `visibilitychange` event on `document`

### Notification URL Construction

Session detail URLs: `/projects/{projectId}/sessions/{connectionId}`
- `projectId` from `session.projectId` or fallback to `sessionManager.currentProjectId` or `'all'`
- Must prepend `base` from `$app/paths`

### Existing UI Structure

- App header (`src/routes/+layout.svelte`): "tim" logo + `TabNav`. Bell button goes in global header (visible on all tabs).
- Session list (`src/lib/components/SessionList.svelte`): Groups sessions, renders `SessionRow`.
- Session row (`src/lib/components/SessionRow.svelte`): Shows status dot, command, plan info, workspace. Add notification dot.
- Session detail (`src/lib/components/SessionDetail.svelte`): Full session view.

### Test Infrastructure

- `session_state_events.ts` uses `SessionStoreMutableState` interface for testability
- Server notification logic should be extracted into pure functions for easy unit testing
- Browser notification utility should use dependency injection for `Notification` API and `document.visibilityState` to enable testing without browser globals

## Implementation Guide

### Step 1: Server — Add Notification Text Extraction Functions

Create server-side notification text extraction functions (either in `src/lib/server/session_manager.ts` or a new `src/lib/server/session_notifications.ts` module). These are pure functions matching tim-gui's `SessionState.swift` logic:

1. **`computeDoneNotificationText(session: SessionData): string`**
   - Scan `session.messages` in reverse for the latest message with `rawType === 'llm_response'` and a text body
   - Normalize: collapse whitespace to single spaces, truncate to 220 chars with `…`
   - Falls back to `"Done"`

2. **`computeDisconnectNotificationText(session: SessionData): string`**
   - Same reverse scan for latest model response (`rawType === 'llm_response'`)
   - Then any text/monospaced message body (check `body.type === 'text'` or `body.type === 'monospaced'`)
   - Finally `"Session finished"`

3. **`normalizeNotificationText(text: string, limit?: number): string`**
   - Collapse whitespace (split on whitespace, filter empties, join with space)
   - Truncate to `limit` (default 220) chars, append `…` if truncated

These should be extracted as standalone functions for easy unit testing.

### Step 2: Server — Add `notification` Field to DisplayMessage

Modify `DisplayMessage` interface in `src/lib/server/session_manager.ts`:
```typescript
notification?: { text: string };
```

In `formatTunnelMessage()` or the message processing pipeline, after calling `summarizeStructuredMessage()`:
- For `task_completion` messages: Check `message.transportSource !== 'tunnel'` and that the session is interactive (`session.sessionInfo.interactive`). If both conditions met, compute notification text via `computeDoneNotificationText(session)` and set `displayMessage.notification = { text }`.
- Note: the notification evaluation happens in `handleWebSocketMessage()` since that's where both the structured message and session context are available. After `formatTunnelMessage()` creates the `DisplayMessage`, check the original structured message for notification triggers and annotate the `DisplayMessage` before emitting it.

In `handleHttpNotification()`:
- Set `displayMessage.notification = { text: payload.message }` on the notification message.

### Step 3: Server — Add `lastNotification` to SessionData for Disconnects

Add to server-side `SessionData`:
```typescript
lastNotification?: { text: string } | null;
```

In `handleWebSocketDisconnect()`:
- Before emitting `session:disconnect`, check if the session is non-interactive (`!session.sessionInfo.interactive`)
- If so, compute `lastNotification = { text: computeDisconnectNotificationText(session) }`
- Set `session.lastNotification` before calling `cloneSessionMetadata()`
- The `session:disconnect` event payload will include this field

### Step 4: Server — Add Tests for Notification Logic

Create `src/lib/server/session_notifications.test.ts`:
- Test `computeDoneNotificationText()` with sessions containing model responses, empty sessions, sessions with only tool output
- Test `computeDisconnectNotificationText()` with various message histories
- Test `normalizeNotificationText()` whitespace collapsing and truncation at 220 chars
- Test that tunnel-sourced messages are excluded from notification triggers
- Test that interactive/non-interactive filtering works correctly

### Step 5: Client — Update Types

Modify `src/lib/types/session.ts`:

Add to `DisplayMessage`:
```typescript
notification?: { text: string };
```

Add to `SessionData`:
```typescript
lastNotification?: { text: string } | null;
hasUnreadNotification: boolean;
notificationMessage: string | null;
```

The `hasUnreadNotification` and `notificationMessage` fields are client-only — not sent by the server. They must be initialized to `false`/`null` when sessions arrive from SSE events.

Update `applySessionEvent()` in `session_state_events.ts`:
- When processing `session:list`, `session:new`, `session:update`, `session:disconnect` events that create/update sessions, ensure `hasUnreadNotification` defaults to `false` and `notificationMessage` to `null` if not already present on the existing client session (use `mergeSessionPreservingMessages` pattern — preserve client notification state when server sends metadata-only updates).

### Step 6: Client — Create Notification Manager

Create `src/lib/stores/notification_manager.svelte.ts`:

A class managing both in-UI notification state and browser notifications.

**Reactive state:**
- `enabled`: `$state(false)` — initialized from localStorage key `'tim_notifications_enabled'`
- `permission`: `$state<NotificationPermission>('default')` — synced with `Notification.permission`
- `supported`: `boolean` — `typeof window !== 'undefined' && 'Notification' in window`

**Methods:**

1. **`handlePromptEvent(connectionId, prompt, sessions)`**: Called on `session:prompt` event.
   - Look up session, format text: `"Prompt ({promptType}): {message}"` from `prompt.promptConfig`
   - Set `hasUnreadNotification = true`, `notificationMessage = text`
   - Re-set session in map to trigger SvelteMap reactivity
   - If `shouldFireBrowserNotification()`, call `showBrowserNotification("Tim", text, { connectionId, projectId })`

2. **`handleMessage(connectionId, message, sessions)`**: Called on `session:message` event.
   - Check `message.notification` field — if present, set notification state from `notification.text`
   - Re-set session in map, optionally fire browser notification

3. **`handleDisconnect(session, sessions)`**: Called on `session:disconnect` event.
   - Check `session.lastNotification` — if present, set notification state from `lastNotification.text`
   - Re-set session in map, optionally fire browser notification

4. **`markRead(connectionId, sessions)`**: Clear `hasUnreadNotification` and `notificationMessage` on the session. Re-set in map.

5. **`firstSessionWithNotification(sessionGroups)`**: Iterate groups in order, return first session with `hasUnreadNotification === true`.

6. **`hasAnyNotification(sessions)`**: Derived/computed — returns true if any session has `hasUnreadNotification`.

7. **`enable()`**: Request permission via `Notification.requestPermission()`, save `true` to localStorage.
8. **`disable()`**: Save `false` to localStorage.
9. **`shouldFireBrowserNotification()`**: Returns `enabled && permission === 'granted' && !isPageVisible()`.

**Browser notification helpers** (can be private methods or a separate utility):
- `isPageVisible()`: `document.visibilityState === 'visible'`
- `showBrowserNotification(title, body, { connectionId, projectId })`: Creates `new Notification(title, { body, tag: connectionId })` with `onclick` handler that calls `window.focus()`, navigates to session URL, and closes the notification.

### Step 7: Client — Hook Notifications into SessionManager

Modify `src/lib/stores/session_state.svelte.ts`:

1. Add `notificationManager: NotificationManager | null` field to `SessionManager`, initialized to `null`.
2. Add `setNotificationManager(manager)` method.
3. In `handleSseEvent()`, after calling `applySessionEvent()`:
   ```typescript
   if (this.initialized && this.notificationManager) {
     if (eventName === 'session:prompt') {
       const event = parsed as SessionPromptEvent;
       this.notificationManager.handlePromptEvent(event.connectionId, event.prompt, this.sessions);
     } else if (eventName === 'session:message') {
       const event = parsed as SessionMessageEvent;
       this.notificationManager.handleMessage(event.connectionId, event.message, this.sessions);
     } else if (eventName === 'session:disconnect') {
       const event = parsed as SessionDisconnectEvent;
       this.notificationManager.handleDisconnect(event.session, this.sessions);
     }
   }
   ```
4. Add `markNotificationRead(connectionId)` method that delegates to `notificationManager.markRead()`.

### Step 8: Client — Update Session UI Components

**`SessionRow.svelte`** — Add blue notification dot:
- Add a blue circle (`bg-blue-500 rounded-full w-2 h-2`) when `session.hasUnreadNotification`
- For notification-only sessions (command is `'notification'`), show `session.notificationMessage` as the subtitle text instead of the command

**`SessionList.svelte`** — Session group headers:
- Show notification dot on collapsed group headers when any session in the group has `hasUnreadNotification`
- Use opacity-based visibility (like tim-gui) to avoid layout shifts

**`SessionDetail.svelte`** and session interaction points — Clear notifications:
- On `onscroll` handler: call `sessionManager.markNotificationRead(session.connectionId)`
- In `PromptRenderer.svelte` after `respond()`: call `sessionManager.markNotificationRead(connectionId)`
- In `MessageInput.svelte` after send: call `sessionManager.markNotificationRead(connectionId)`

**Session route page** (`src/routes/projects/[projectId]/sessions/[connectionId]/+page.svelte`):
- When session is selected/loaded: call `sessionManager.markNotificationRead(connectionId)`

### Step 9: Client — Add Bell Button to Global Header

Modify `src/routes/+layout.svelte`:

1. Import `NotificationManager`, create/set it in the `SessionManager`
2. Add bell icon button to the right side of the header bar (after `TabNav`)
3. Use `@lucide/svelte` icons: `Bell`, `BellOff`
4. Button shows a small blue dot indicator when `notificationManager.hasAnyNotification(sessions)`
5. Button states:
   - Not supported: Don't render
   - Permission `'default'`: Gray bell; click requests permission then enables
   - Permission `'granted'` + enabled: Colored/active bell; click toggles off
   - Permission `'granted'` + disabled: Gray bell; click toggles on
   - Permission `'denied'`: Bell with slash or muted bell; title/tooltip explains need to reset in browser settings
6. On bell click for "jump to notification": Navigate to `/projects/{projectId}/sessions/{connectionId}` for the first session with unread notification (switches tabs if needed)

Consider splitting the header bell into two functions: the toggle (enable/disable) and the jump-to-notification. The toggle could be a small icon button, while the jump behavior triggers when there's an active notification.

### Step 10: Add Client-Side Tests

1. **Notification manager tests** (`src/lib/stores/notification_manager.test.ts`):
   - Test `handlePromptEvent()` sets `hasUnreadNotification` and `notificationMessage`
   - Test `handleMessage()` with messages that have `notification` field vs without
   - Test `handleDisconnect()` with sessions that have `lastNotification` vs without
   - Test `markRead()` clears notification state
   - Test `shouldFireBrowserNotification()` with various permission/enabled/visibility combos
   - Test that browser notifications are NOT fired when page is visible
   - Test `firstSessionWithNotification()` returns correct session across groups
   - Mock `Notification` constructor and `document.visibilityState`

2. **Session state events tests** (update existing `session_state_events.test.ts` if it exists):
   - Test that `applySessionEvent()` preserves `hasUnreadNotification`/`notificationMessage` across metadata-only updates
   - Test that new sessions get `false`/`null` defaults

### Manual Testing Steps

1. Open the tim web interface in a browser
2. Enable browser notifications via the bell icon in the header
3. Start an agent session (e.g. `tim agent` with a plan)
4. Verify blue unread dot appears on the session row when a prompt arrives
5. Click the session row — verify the dot clears
6. Scroll in the message area — verify the dot clears if it reappears
7. Switch to another browser tab
8. Trigger a prompt — verify a browser notification appears with the prompt message
9. Click the notification — verify it navigates to the correct session and focuses the tab
10. Run a non-interactive session, wait for it to disconnect — verify notification appears with latest model response text
11. Test the bell button in the header jumps to the first unread notification (including switching tabs)
12. Toggle browser notifications off and verify no browser notifications fire (in-UI dots should still appear)
13. Test that notifications from subagent `task_completion` messages (tunnel-sourced) do NOT trigger
