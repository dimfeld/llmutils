---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "tim-gui: integrate notifications into sessions"
goal: "Unify notifications and sessions into a single view: notifications match
  to existing sessions by terminal pane or working directory, sessions carry
  terminal metadata for pane activation, and the notifications tab is removed"
id: 195
uuid: a2d40d96-fa91-4a18-a761-2c5ef235975b
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-02-16T03:35:13.313Z
promptsGeneratedAt: 2026-02-16T03:35:13.313Z
createdAt: 2026-02-15T04:05:01.637Z
updatedAt: 2026-02-16T05:48:53.812Z
tasks:
  - title: Add terminal info to TypeScript headless protocol
    done: true
    description: "Add `terminalPaneId?: string` and `terminalType?: string` to
      `HeadlessSessionInfo` and `HeadlessSessionInfoMessage` in
      `src/logging/headless_protocol.ts`. In `src/tim/headless.ts`, update
      `buildHeadlessSessionInfo()` to read `process.env.WEZTERM_PANE` and
      include `terminalPaneId` and `terminalType: 'wezterm'` when present. Add
      tests to verify terminal info is included when WEZTERM_PANE is set and
      omitted when not."
  - title: Decode terminal info in Swift session models and add notification
      properties
    done: true
    description: "In `SessionModels.swift`: add `terminal: TerminalPayload?` to
      `SessionInfoPayload`; add `terminalPaneId` and `terminalType` to
      `HeadlessMessage.CodingKeys`; in the `session_info` decoding case, decode
      optional `terminalPaneId` and `terminalType` and construct
      `TerminalPayload` if paneId is present; add `terminal: TerminalPayload?`,
      `hasUnreadNotification: Bool` (default false), and `notificationMessage:
      String?` to `SessionItem`. In `SessionState.swift`, update `addSession()`
      to pass terminal from payload to session item. Add decoding tests in
      `SessionModelTests.swift` for session_info with/without terminal fields,
      and a test in `SessionStateTests.swift` that `addSession` populates the
      terminal field."
  - title: Implement notification matching in SessionState
    done: true
    description: "Add `ingestNotification(payload: MessagePayload)` to
      `SessionState.swift`. Match logic: (1) find session by matching
      `terminal.paneId` if both notification and session have one, (2) fall back
      to `workspacePath` match (first match wins since sessions are
      newest-first), (3) if matched, set `hasUnreadNotification = true` and
      replace `notificationMessage` with `payload.message`, (4) if no match,
      create a notification-only session with synthetic `connectionId`,
      `isActive = false`, workspace path, terminal info, `hasUnreadNotification
      = true`, and `notificationMessage`. Also add
      `markNotificationRead(sessionId: UUID)` that clears the flag. Trigger
      macOS `UNNotificationRequest` in all cases. In `TimGUIApp.swift`, change
      the HTTP handler closure to call
      `sessionState.ingestNotification(payload:)` instead of
      `appState.ingest()`. Write tests for: match by pane ID, match by working
      directory, create new session on no match, multiple sessions same
      workspace (matches most recent), no terminal info matches by workspace
      only, sets hasUnreadNotification, second notification replaces message."
  - title: Update SessionRowView with blue dot indicator, notification subtitle, and
      auto-clear on selection
    done: true
    description: "In `SessionsView.swift` `SessionRowView`: add a blue 8x8 circle
      indicator when `session.hasUnreadNotification` is true (next to the
      green/gray status dot). For notification-only sessions (those with
      `notificationMessage` but no `planTitle`), display the
      `notificationMessage` as the subtitle text instead of `planTitle ??
      command`. In `SessionListView`, use `.onChange(of:
      sessionState.selectedSessionId)` to call
      `sessionState.markNotificationRead()` immediately when a session with an
      unread notification is selected."
  - title: Extract activateTerminalPane to shared utility, replace dismiss button
      with pane button, add context menu
    done: true
    description: "Extract `activateTerminalPane()` from `ContentView.swift`
      `NotificationsView` to a top-level function (can stay in same file or move
      to a new `TerminalUtils.swift`). `waitForProcess` and
      `ThrowingResumeGuard` are already top-level. In `SessionRowView`: remove
      the inline dismiss button (`xmark.circle.fill`); add a pane activation
      button visible when `session.terminal != nil` (use SF Symbol like
      `terminal` or `rectangle.inset.filled`); add `.contextMenu` modifier with
      a 'Dismiss' action that calls `onDismiss`, only showing when
      `!session.isActive`."
  - title: Remove notifications tab, AppViewMode, NotificationsView, and AppState
    done: true
    description: "In `ContentView.swift`: delete `AppViewMode` enum; remove the
      segmented `Picker`; remove the `switch viewMode` and render `SessionsView`
      directly; delete `NotificationsView` struct entirely; remove `appState`
      parameter from `ContentView`; keep status bar (port display) and error
      display. In `TimGUIApp.swift`: remove `AppState` class and `@State private
      var appState`; remove `appState` from `ContentView` instantiation. Update
      the preview at the bottom of `ContentView.swift` to match the new
      signature. Delete `AppStateTests.swift` since `AppState` is removed."
changedFiles:
  - README.md
  - src/logging/headless_adapter.test.ts
  - src/logging/headless_adapter.ts
  - src/logging/headless_protocol.ts
  - src/tim/headless.test.ts
  - src/tim/headless.ts
  - tim-gui/TimGUI/ContentView.swift
  - tim-gui/TimGUI/LocalHTTPServer.swift
  - tim-gui/TimGUI/SessionModels.swift
  - tim-gui/TimGUI/SessionState.swift
  - tim-gui/TimGUI/SessionsView.swift
  - tim-gui/TimGUI/TerminalUtils.swift
  - tim-gui/TimGUI/TimGUIApp.swift
  - tim-gui/TimGUI.xcodeproj/project.pbxproj
  - tim-gui/TimGUITests/ModelTests.swift
  - tim-gui/TimGUITests/SessionModelTests.swift
  - tim-gui/TimGUITests/SessionStateTests.swift
tags: []
---

Get rid of the separate notifications tab and make everything a session now.

- Have the session start message include the WEZTERM_PANE environment variable and other terminal info that notifications currently
have so we can match up a session to a pane.
- Remove the "clear" button on defunct sessions and have that be a right-click action instead. Replace where the button
was with a button that will activate the wezterm pane if we have one.
- Keep the "clear all" button in the toolbar. 
- Add a blue dot for sessions like we have for notifications now, when there is an unhandled notification
- Match up notifications to existing sessions by WEZTERM_PANE value or working directory if there isn't one..
- For notifications not linked to an existing session, just create a new session for it.

## Expected Behavior/Outcome

After this change, the GUI will have a single "Sessions" view (no segmented tab picker). Notifications arriving via `POST /messages` are matched to existing sessions by `WEZTERM_PANE` value, or by working directory if no pane match exists. Matched notifications add a blue unread dot to the session row and trigger a macOS system notification. Unmatched notifications create a new "notification-only" session. Defunct sessions have a right-click context menu for dismissal, and a pane activation button replaces the old dismiss button. The "Clear Disconnected" toolbar button remains.

### States
- **Active session**: Green dot, receiving live WebSocket messages. May also have a blue unread-notification dot.
- **Defunct session (no notification)**: Gray dot, no blue dot. Right-click to dismiss.
- **Defunct session (with unread notification)**: Gray dot + blue dot. Selecting the session immediately clears the blue dot.
- **Notification-only session**: Created from an HTTP notification with no matching WebSocket session. Appears as a defunct session (gray dot) with a blue notification dot. The notification message is shown as the subtitle in the row (no detail view content). No `command` text is displayed; the notification message replaces it.

## Key Findings

### Product & User Story
As a developer monitoring multiple tim agent sessions, I want notifications to appear inline with their associated sessions so I don't have to switch between tabs and mentally correlate which notification belongs to which session. When an agent completes, I should see a blue dot on the session row, and I should be able to activate the terminal pane directly from the session list.

### Design & UX Approach
- Remove the segmented picker (`AppViewMode` enum) since there will be only one view.
- In `SessionRowView`, replace the dismiss `xmark.circle.fill` button with a pane activation button (e.g., `terminal` or `rectangle.topthird.inset.filled` SF Symbol) when the session has terminal info. Show the pane button for all sessions that have terminal info, not just defunct ones.
- Add a blue dot indicator to `SessionRowView` for unread notifications (similar to the existing notification blue dot).
- Add a `.contextMenu` modifier to `SessionRowView` for the "Dismiss" action on defunct sessions.
- Keep the "Clear Disconnected" toolbar button in `SessionListView`.

### Technical Plan & Risks
- **TypeScript side**: Add `terminalPaneId` (from `WEZTERM_PANE` env var) and `terminalType` to `HeadlessSessionInfo` and `HeadlessSessionInfoMessage`. The `buildHeadlessSessionInfo()` function in `src/tim/headless.ts` needs to capture `process.env.WEZTERM_PANE`.
- **Swift side**: Extend `SessionInfoPayload` and `SessionItem` with optional `terminal: TerminalPayload?`. When a notification arrives via HTTP, `SessionState` matches it to an existing session and sets an `unreadNotification` flag. If no match is found, a new notification-only session is created.
- **Risk**: Race condition where a notification arrives before the WebSocket session_info. This is handled by the existing pending-message buffer; the notification matching should also check pending/in-flight connections.
- **Risk**: Multiple sessions with the same working directory. The matching logic should prefer `WEZTERM_PANE` (exact match) and fall back to working directory. If multiple sessions share a working directory, match the most recent active one.

### Pragmatic Effort Estimate
Medium scope. The TypeScript changes are minimal (adding env var to session info). The Swift changes are moderate: modifying `SessionState` to handle notification matching, updating `SessionRowView` for context menu and pane button, removing the tab picker, and moving the `activateTerminalPane` function to a shared location.

## Acceptance Criteria

- [ ] Notifications tab is removed; only the sessions view exists
- [ ] Session start message (`session_info`) includes `WEZTERM_PANE` and terminal type
- [ ] Notifications arriving via HTTP are matched to existing sessions by pane ID, then by working directory
- [ ] Unmatched notifications create a new notification-only session
- [ ] Sessions with unread notifications show a blue dot indicator
- [ ] Selecting a session with a notification immediately clears the blue dot
- [ ] Defunct sessions show dismiss action in right-click context menu (not an inline button)
- [ ] Sessions with terminal info show a pane activation button in the row
- [ ] "Clear Disconnected" toolbar button remains functional
- [ ] macOS system notifications still fire for incoming notifications
- [ ] Existing SessionState tests pass; new tests cover notification matching logic
- [ ] Headless protocol tests cover terminal info in session_info messages

## Dependencies & Constraints

- **Dependencies**: Existing `activateTerminalPane` function in `ContentView.swift` must be moved to a shared location accessible from `SessionsView.swift`.
- **Technical Constraints**: Notification matching is best-effort; if `WEZTERM_PANE` is not set by the notification sender, fallback to `workspacePath` matching. The notification command configuration template must have access to `$WEZTERM_PANE` to include it.

## Implementation Notes

### Recommended Approach
1. Start with TypeScript changes (add terminal info to headless protocol) since they're small and self-contained.
2. Then do Swift model changes (extend `SessionInfoPayload`, `SessionItem`, decode terminal info).
3. Implement notification matching in `SessionState`.
4. Update UI components (remove tabs, modify row view, move `activateTerminalPane`).
5. Update tests throughout.

### Potential Gotchas
- The `activateTerminalPane` function is currently a private method on `NotificationsView`. It needs to be extracted to a standalone function or a utility that can be called from `SessionsView`.
- The existing `AppState.ingest()` method both stores the notification and triggers macOS system notification. After this change, the notification storage goes through `SessionState`, but macOS system notifications should still be triggered.
- The notification deduplication logic in `AppState.ingest()` (removing previous notification for same workspace) is no longer needed since notifications are now attached to sessions, and subsequent notifications for the same session simply replace the previous message.
- Notification-only sessions have no `connectionId` tied to a WebSocket. They need a synthetic connection ID or a flag indicating they're notification-only.

## Research

### Notification System Architecture

The current notification system operates independently from sessions:

**HTTP endpoint**: `POST /messages` on port 8123 receives `MessagePayload`:
```swift
struct MessagePayload: Codable {
    let message: String
    let workspacePath: String
    let terminal: TerminalPayload?  // type + paneId
}
```

**Processing flow** (`TimGUIApp.swift` line 71-73):
1. `LocalHTTPServer` receives HTTP POST → calls `appState.ingest(payload)`
2. `AppState.ingest()` deduplicates by `workspacePath`, creates `MessageItem`, inserts at front
3. Sends macOS `UNNotificationRequest`

**Key insight**: Notifications already carry `TerminalPayload` with `type` (e.g., "wezterm") and `paneId`. The notification command in the tim config can inject `$WEZTERM_PANE` as the pane ID. This is the same identifier we need in sessions.

### Session System Architecture

Sessions connect via WebSocket at `GET /tim-agent`:

**Handshake**: First message is `session_info` containing `command`, `planId`, `planTitle`, `workspacePath`, `gitRemote`.

**Key gap**: `session_info` does NOT currently include terminal/pane information. The `HeadlessSessionInfo` type in `src/logging/headless_protocol.ts` has no terminal fields:
```typescript
export interface HeadlessSessionInfo {
  command: string;
  planId?: number;
  planTitle?: string;
  workspacePath?: string;
  gitRemote?: string;
}
```

The `buildHeadlessSessionInfo()` function in `src/tim/headless.ts` (line 76-98) gathers workspace path and git remote but not `WEZTERM_PANE`.

### Swift Data Models

**`SessionInfoPayload`** (`SessionModels.swift` line 169-175): Mirrors the TypeScript `HeadlessSessionInfo`. Decoded from JSON with explicit `CodingKeys`. Needs `terminal: TerminalPayload?` added.

**`SessionItem`** (`SessionModels.swift` line 119-157): `@Observable` class with session metadata and messages array. Needs `terminal: TerminalPayload?` and `hasUnreadNotification: Bool` properties.

**`HeadlessMessage` decoding** (`SessionModels.swift` line 177-215): Switch on `type` field. The `session_info` case needs to decode optional `terminal` object.

### Session Row UI

**`SessionRowView`** (`SessionsView.swift` line 66-113):
- Green/gray circle for active/inactive status
- Workspace path, plan title, time
- `xmark.circle.fill` dismiss button for inactive sessions only

The dismiss button is at lines 93-100:
```swift
if !session.isActive {
    Button(action: onDismiss) {
        Image(systemName: "xmark.circle.fill")
            .foregroundStyle(.secondary)
    }
    .buttonStyle(.plain)
    .help("Dismiss session")
}
```

### Tab System

**`ContentView.swift`** lines 5-53:
- `AppViewMode` enum with `.sessions` and `.notifications` cases
- Segmented `Picker` in top bar
- Switch statement routes to `NotificationsView` or `SessionsView`
- `ContentView` currently takes both `appState` and `sessionState`

After removal, `ContentView` will only need `sessionState` (but will still need to manage macOS notification permissions and server lifecycle from `TimGUIApp`).

### Terminal Pane Activation

The `activateTerminalPane()` function in `ContentView.swift` (lines 100-177) is a private method on `NotificationsView`. It:
1. Checks terminal type is "wezterm"
2. Runs `wezterm cli list --format json` to find the pane
3. Extracts workspace name
4. Sends OSC 1337 SetUserVar to switch workspace
5. Runs `wezterm cli activate-pane --pane-id <id>`
6. Activates WezTerm macOS app

This function needs to become a top-level or utility function accessible from `SessionsView`.

### Test Files

- `SessionStateTests.swift`: Comprehensive tests for session lifecycle. New tests needed for notification matching.
- `AppStateTests.swift`: Tests for `ingest()` and `markRead()`. These tests will need updating/removal as `AppState` role changes.
- `ModelTests.swift`, `SessionModelTests.swift`, `MessageFormatterTests.swift`: Model decoding tests. `SessionModelTests` needs tests for terminal field in `session_info` decoding.

### Backend Notification Flow

In `src/tim/notifications.ts`, the `sendNotification()` function runs a shell command with the notification payload piped to stdin. The shell command template (configured in tim.yml) typically uses `curl` to POST to the GUI. The `WEZTERM_PANE` env var is available in the environment of the tim process but is passed through the shell command's env (`notificationConfig.env`). The `NotificationPayload` (line 14-26) contains `cwd` but no terminal info — the terminal info comes from the curl command template interpolating `$WEZTERM_PANE`.

### Headless Adapter

The `HeadlessAdapter` in `src/logging/headless_adapter.ts` connects via WebSocket and sends `session_info` as the first message. The session info is built by `buildHeadlessSessionInfo()` which receives command and plan info. Adding terminal info here is straightforward.

## Implementation Guide

### Step 1: Add terminal info to TypeScript headless protocol

**Files to modify:**
- `src/logging/headless_protocol.ts`: Add `terminalPaneId?: string` and `terminalType?: string` to `HeadlessSessionInfo` and `HeadlessSessionInfoMessage`.
- `src/tim/headless.ts`: In `buildHeadlessSessionInfo()`, read `process.env.WEZTERM_PANE`. If present, include `terminalPaneId` and `terminalType: 'wezterm'` in the returned object.

**Rationale**: This is the smallest, most self-contained change. It makes session_info messages carry terminal metadata without affecting any other behavior.

**Testing**: Update the headless protocol tests to verify terminal info is included when `WEZTERM_PANE` is set and omitted when not set.

### Step 2: Decode terminal info in Swift session models

**Files to modify:**
- `SessionModels.swift`:
  - Add `terminal: TerminalPayload?` to `SessionInfoPayload`.
  - Add `terminalPaneId` and `terminalType` to `HeadlessMessage.CodingKeys`.
  - In the `session_info` decoding case, decode optional `terminalPaneId` and `terminalType` strings and construct a `TerminalPayload` if `terminalPaneId` is present.
  - Add `terminal: TerminalPayload?` property to `SessionItem`.
  - Add `hasUnreadNotification: Bool` property to `SessionItem` (default `false`).
  - Add `notificationMessage: String?` property to `SessionItem` for storing the notification text.

**Files to modify:**
- `SessionState.swift`:
  - In `addSession()`, pass `terminal` from `SessionInfoPayload` to `SessionItem`.

**Testing**: Add tests in `SessionModelTests.swift` for decoding `session_info` with and without terminal fields. Add test in `SessionStateTests.swift` that `addSession` correctly populates the terminal field.

### Step 3: Implement notification matching in SessionState

**Files to modify:**
- `SessionState.swift`: Add a new method `ingestNotification(payload: MessagePayload)`:
  1. Try to find a session with matching `terminal.paneId` (if the notification has a `TerminalPayload` and the session has one).
  2. If no pane match, try to find a session with matching `workspacePath`.
  3. When matching by working directory, prefer the most recently connected session (sessions are ordered newest-first, so the first match wins).
  4. If a match is found, set `session.hasUnreadNotification = true` and `session.notificationMessage = payload.message` (replacing any previous notification message).
  5. If no match is found, create a new notification-only session with a synthetic `connectionId`, `isActive = false`, the notification's workspace path and terminal info, `hasUnreadNotification = true`, and `notificationMessage = payload.message`. The row should display the notification message as the subtitle (where plan title/command normally appears), skipping the `command` field entirely.
  6. Always trigger macOS system notification.

- `TimGUIApp.swift`:
  - Change the `handler` closure in `startServerIfNeeded()` to call `sessionState.ingestNotification(payload:)` instead of `appState.ingest(payload)`.
  - Keep `AppState` for now (or remove it if fully unused) but stop routing notifications through it.
  - Keep macOS notification permission request.

**Testing**: Write tests for:
- Notification matches session by pane ID
- Notification matches session by working directory
- Notification creates new session when no match
- Multiple sessions with same working directory — matches most recent
- Notification with no terminal info matches by working directory only
- Notification sets `hasUnreadNotification` on matched session

### Step 4: Add unread notification indicator and clear behavior to SessionRowView

**Files to modify:**
- `SessionsView.swift` (`SessionRowView`):
  - Add a blue dot (8x8 `Circle().fill(.blue)`) next to or overlaying the green/gray status circle when `session.hasUnreadNotification` is true.
  - Pass `sessionState` to `SessionRowView` or use a callback to clear the notification.

- `SessionState.swift`: Add `markNotificationRead(sessionId: UUID)` method that sets `hasUnreadNotification = false` on the session.

- `SessionsView.swift` (`SessionListView`):
  - When a session is selected (via the `List` selection binding), immediately mark its notification as read.
  - For notification-only sessions, display `notificationMessage` as the subtitle instead of `planTitle ?? command`.

**Rationale**: The blue dot provides at-a-glance visibility of which sessions have pending notifications, matching the UX from the old notifications tab.

### Step 5: Replace dismiss button with pane activation button and add context menu

**Files to modify:**
- `ContentView.swift`: Extract `activateTerminalPane()` and `waitForProcess()` (and `ThrowingResumeGuard`) to a new file or move them to a shared utility location. `waitForProcess` is already a top-level function, so just `activateTerminalPane` needs extraction.

- `SessionsView.swift` (`SessionRowView`):
  - Remove the inline dismiss button (`xmark.circle.fill`).
  - Add a pane activation button in its place, visible when `session.terminal != nil`. Use an appropriate SF Symbol (e.g., `terminal` or `rectangle.inset.filled`).
  - Add `.contextMenu` modifier to the row with a "Dismiss" action (only enabled when `!session.isActive`).

**Testing**: Manual testing for context menu and pane activation.

### Step 6: Remove notifications tab and AppViewMode

**Files to modify:**
- `ContentView.swift`:
  - Delete `AppViewMode` enum.
  - Remove the segmented `Picker`.
  - Remove the `switch viewMode` and render `SessionsView` directly.
  - Remove `NotificationsView` struct entirely.
  - Remove `appState` parameter from `ContentView` (if `AppState` is no longer needed).
  - Keep the status bar (port display) and error display.

- `TimGUIApp.swift`:
  - If `AppState` is no longer used, remove it. Otherwise keep it but don't pass it to `ContentView`.
  - Update `ContentView` instantiation to remove `appState` parameter.

- Update preview at the bottom of `ContentView.swift` to match new signature.

**Testing**: Verify the app compiles and the sessions view displays correctly without the tab picker.

### Step 7: Update tests

**Files to modify:**
- `AppStateTests.swift`: Either remove or update tests. If `AppState` is removed entirely, delete this file. If `AppState` is kept for a reduced role, update accordingly.
- `SessionStateTests.swift`: Add new tests for `ingestNotification()` and `markNotificationRead()`.
- `SessionModelTests.swift`: Add decoding tests for terminal info in `session_info`.

### Manual Testing Steps
1. Start the GUI app and verify only the sessions view appears (no tab picker).
2. Start a tim agent command and verify the session appears with correct terminal info.
3. When the agent completes and sends a notification, verify the blue dot appears on the session.
4. Click the session and verify the blue dot clears.
5. Send a notification for a workspace with no active session and verify a new notification-only session appears.
6. Right-click a defunct session and verify the "Dismiss" option appears.
7. Click the pane activation button and verify WezTerm switches to the correct pane.
8. Click "Clear Disconnected" and verify all defunct sessions are removed.

## Current Progress
### Current State
- All 6 tasks are complete. The plan is fully implemented.

### Completed (So Far)
- Task 1: TypeScript headless protocol includes `terminalPaneId`/`terminalType` from `WEZTERM_PANE` env var. `HeadlessSessionInfoMessage` now extends `HeadlessSessionInfo` to prevent field sync bugs. Spread used in adapter handshake.
- Task 2: Swift `SessionInfoPayload` and `SessionItem` have `terminal: TerminalPayload?`, `hasUnreadNotification`, `notificationMessage`. Decoding constructs `TerminalPayload` from flat `terminalPaneId`/`terminalType` fields.
- Task 3: `SessionState.ingestNotification(payload:)` matches by pane ID first, workspace path fallback (only when no pane ID). `markNotificationRead` clears flag but preserves message. `addSession` reconciles notification-only sessions. macOS system notifications triggered via `UNNotificationRequest`.
- Task 4: Blue dot indicator (using opacity for stable layout), notification subtitle for notification-only sessions (empty command → show notificationMessage), auto-clear on selection via `.onChange(of: selectedSessionId)`.
- Task 5: `activateTerminalPane`, `waitForProcess`, `ThrowingResumeGuard` extracted to `TerminalUtils.swift`. Pane activation button gated on `terminal?.type == "wezterm"`. Context menu with "Dismiss" for inactive sessions (conditionally applied via nil ContextMenu for active sessions).
- Task 6: `AppViewMode`, `NotificationsView`, `AppState` removed. `ContentView` renders `SessionsView` directly. `AppStateTests.swift` deleted. Dead `MessageItem` struct removed from `LocalHTTPServer.swift` and its tests from `ModelTests.swift`.

### Remaining
- None

### Next Iteration Guidance
- None — all tasks complete. Manual testing recommended per the plan's Manual Testing Steps.

### Decisions / Changes
- `HeadlessSessionInfoMessage` extends `HeadlessSessionInfo` (instead of duplicating fields) to prevent field-addition bugs.
- `markNotificationRead` only clears `hasUnreadNotification`, NOT `notificationMessage` - notification-only sessions need to keep their message as display text.
- When notification has a pane ID but no pane match exists, a notification-only session is created (no workspace fallback) to enable correct reconciliation when the real session arrives.
- `SessionItem.connectionId` was changed from `let` to `var` to support reconciliation.
- Notification-only sessions are identified by empty `command` field.
- Notification-only sessions are NOT auto-selected — only real WebSocket sessions auto-select. This prevents `.onChange` from immediately clearing the unread flag.
- `findNotificationOnlySession` uses pane-priority matching (same as `ingestNotification`): if incoming session has a pane ID and no pane match, return nil — no workspace fallback.
- Blue dot uses `.opacity()` instead of conditional rendering to prevent horizontal layout shifts.
- Terminal pane activation button only shown for wezterm terminal type (not all terminal types).
- `NSRunningApplication.activate()` stays outside the Task block in `activateTerminalPane` for immediate WezTerm focus.
- Context menu conditionally applied (nil for active sessions) to avoid empty right-click popups.

### Lessons Learned
- `HeadlessAdapter.prependHandshakeMessages()` manually listed fields instead of spreading - new protocol fields were silently dropped. Using spread (`{ type: 'session_info', ...this.sessionInfo }`) prevents this. Always check the serialization layer, not just the builder.
- Race condition handling: when notifications have pane IDs, workspace fallback can bind to the wrong session. Pane-identified notifications should create notification-only sessions for reconciliation rather than falling back to workspace matching. This same principle applies to both `ingestNotification` AND `findNotificationOnlySession`.
- Clearing notification message on read would break notification-only sessions that use the message as their display subtitle.
- Auto-selecting notification-only sessions interacts badly with `.onChange(of: selectedSessionId)` unread-clearing — the selection change fires immediately, clearing the blue dot before the user ever sees it.
- When extracting code that has both sync and async parts (like `activateTerminalPane` with sync `NSRunningApplication.activate()` + async `Task` block), preserve the original sync/async boundary placement to avoid behavioral regressions.
- SwiftUI conditional rendering of fixed-size elements (like dots) causes layout shifts — use `.opacity()` to reserve space.

### Risks / Blockers
- Pre-existing flaky `WebSocketTests/rsvBitRejection` test fails intermittently - unrelated to this work but leaves test suite not fully green.
