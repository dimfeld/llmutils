---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "tim-gui: group sessions by workspace"
goal: Group the session sidebar by project/workspace with collapsible headers,
  notification bubbling, drag-to-reorder groups, and a toolbar button to jump to
  the first unread notification.
id: 203
uuid: 94d6de67-cc76-4721-ad3f-824eaafe9ed1
generatedBy: agent
simple: true
status: done
priority: medium
planGeneratedAt: 2026-02-25T08:52:05.629Z
promptsGeneratedAt: 2026-02-25T08:52:05.629Z
createdAt: 2026-02-23T08:29:07.853Z
updatedAt: 2026-02-25T21:17:36.362Z
tasks:
  - title: Add parseProjectDisplayName() and sessionGroupKey() utility functions to
      SessionModels.swift
    done: true
    description: >-
      Add two static/free functions:


      1. parseProjectDisplayName(gitRemote: String?, workspacePath: String?) ->
      String:
         - Parse gitRemote to extract last two path segments (owner/repo). Handle SSH format (git@host:owner/repo.git) and HTTPS format (https://host/owner/repo.git). Strip .git suffix.
         - Determine current user via NSUserName() as primary, ProcessInfo.processInfo.environment["USER"] as fallback.
         - If owner matches current user (case-insensitive), return just repo name.
         - If no gitRemote, fall back to SessionRowView.shortenedPath(workspacePath) (last 2 path components).
         - If neither available, return "Unknown".

      2. sessionGroupKey(gitRemote: String?, workspacePath: String?) -> String:
         - Returns a stable string key for grouping sessions. Use the normalized gitRemote URL if available, otherwise workspacePath, otherwise "__unknown__".

      Also add SessionGroup struct with id (String, grouping key), displayName
      (String), sessions ([SessionItem]), hasNotification (computed Bool),
      sessionCount (computed Int).


      Write unit tests in SessionModelTests.swift covering SSH/HTTPS parsing,
      owner elision, workspacePath fallback, Unknown fallback, sessionGroupKey
      consistency, SessionGroup.hasNotification.
  - title: Add grouping logic and group order management to SessionState
    done: true
    description: >-
      Modify SessionState.swift to add:


      1. var groupOrder: [String] = [] - ordered list of group keys controlling
      display order.

      2. var groupedSessions: [SessionGroup] - computed property that groups
      sessions by sessionGroupKey(), orders by groupOrder, appends unknown
      groups at end.

      3. func moveGroup(from: IndexSet, to: Int) - reorders entries in
      groupOrder.

      4. var firstSessionWithNotification: SessionItem? - computed, scans groups
      in display order for first session with hasUnreadNotification.

      5. Update addSession(): check if group key exists in groupOrder, if not
      insert at index 0.

      6. Update dismissSession() and dismissAllDisconnected(): clean up
      groupOrder entries with no remaining sessions.


      Write unit tests in SessionStateTests.swift: grouping correctness, group
      ordering, moveGroup, firstSessionWithNotification, auto-insertion, cleanup
      on dismiss.
  - title: Replace flat session list with grouped collapsible sections
    done: true
    description: >-
      Modify SessionListView in SessionsView.swift:


      1. Add @State private var collapsedGroups: Set<String> to track collapsed
      groups.

      2. Replace flat List with List(selection:) wrapping
      ForEach(sessionState.groupedSessions) with SessionGroupHeaderView +
      session rows.

      3. Hide session rows when group is collapsed. Use .onMove on outer ForEach
      for group reordering.

      4. Create SessionGroupHeaderView: shows chevron (animated rotation),
      project display name, session count badge (capsule), notification dot
      (opacity-based per AGENTS.md). Tappable to toggle collapse.

      5. Ensure List selection binding works with sessions inside groups.

      6. Update SwiftUI preview to show multiple projects.
  - title: Add toolbar button to jump to first session with active notification
    done: true
    description: >-
      Add a ToolbarItem with bell.badge SF Symbol icon to SessionListView
      toolbar:

      1. Disabled when sessionState.firstSessionWithNotification is nil.

      2. On tap: get first notification session, compute its group key, remove
      from collapsedGroups (expand group), call
      handleSessionListItemTap(sessionId:).

      3. Place before existing Clear Disconnected button.

      4. Add .help("Jump to first notification") tooltip.
  - title: Build, test, and lint the app
    done: true
    description: |-
      Run the full build/test/lint pipeline:
      1. cd tim-gui && ./scripts/test.sh - all unit tests including new ones.
      2. cd tim-gui && ./scripts/build.sh - verify app builds.
      3. cd tim-gui && ./scripts/lint.sh - check code style.
      4. Fix any issues found. Ensure all existing tests still pass.
  - title: "Address Review Feedback: `parseProjectDisplayName` does not implement
      the required current-user fallback chain."
    done: true
    description: >-
      `parseProjectDisplayName` does not implement the required current-user
      fallback chain. The plan requires owner elision using current macOS user
      from `NSUserName()` or `USER` env var fallback. Current code only uses
      `currentUser ?? NSUserName()` and never consults
      `ProcessInfo.processInfo.environment["USER"]` when `NSUserName()` is
      unavailable/empty, so requirement compliance is incomplete.


      Suggestion: Compute an effective user as: explicit `currentUser` if
      provided, else non-empty `NSUserName()`, else non-empty
      `ProcessInfo.processInfo.environment["USER"]`. Add tests for the env-var
      fallback path.


      Related file: tim-gui/TimGUI/SessionModels.swift:274-287
  - title: "Address Review Feedback: Group drag-reorder can act on the wrong group
      because `groupOrder` can contain stale keys that are not shown in
      `groupedSessions`."
    done: true
    description: >-
      Group drag-reorder can act on the wrong group because `groupOrder` can
      contain stale keys that are not shown in `groupedSessions`. In
      `addSession` (existing-session update path), a new key is inserted but the
      old key is never removed when metadata changes (e.g. duplicate
      `session_info` updates repo/workspace). `groupedSessions` skips missing
      keys, but `.onMove` uses visible indices and `moveGroup` applies those
      indices directly to raw `groupOrder`. Once stale keys exist, visible index
      != `groupOrder` index, so reordering can become incorrect/no-op.


      Suggestion: Normalize `groupOrder` against active group keys before moving
      (or whenever metadata changes), and make move logic operate on visible
      group IDs rather than raw array indices. Also remove/reconcile old group
      key when a session's grouping key changes on metadata update.


      Related file: tim-gui/TimGUI/SessionState.swift:45-47, 77-79, 88-97
  - title: "Address Review Feedback: The `.onMove` modifier on the outer
      `ForEach(groupedSessions)` provides indices into the `groupedSessions`
      array, but `moveGroup(from:to:)` passes those indices directly to
      `self.groupOrder.move(fromOffsets:toOffset:)`."
    done: true
    description: >-
      The `.onMove` modifier on the outer `ForEach(groupedSessions)` provides
      indices into the `groupedSessions` array, but `moveGroup(from:to:)` passes
      those indices directly to `self.groupOrder.move(fromOffsets:toOffset:)`.
      These two arrays are not guaranteed to be the same length.
      `ingestNotification(payload:)` creates notification-only sessions without
      adding their group key to `groupOrder`, so `groupedSessions` can contain
      more groups than `groupOrder`. If a user drags a notification-only group
      (appended at the end of `groupedSessions`), the `from` index will be out
      of bounds for `groupOrder`, causing a runtime crash.


      Suggestion: Either (a) add group keys to `groupOrder` in
      `ingestNotification` matching the pattern in `addSession`, or (b) rewrite
      `moveGroup` to rebuild `groupOrder` from the current `groupedSessions`
      ordering before performing the move:

      ```swift

      func moveGroup(from: IndexSet, to: Int) {
          var order = self.groupedSessions.map(\.id)
          order.move(fromOffsets: from, toOffset: to)
          self.groupOrder = order
      }

      ```


      Related file: tim-gui/TimGUI/SessionState.swift:77-79
  - title: "Address Review Feedback: groupedSessions is a computed property that
      iterates all sessions, builds groups, and sorts by groupOrder on every
      access."
    done: true
    description: >-
      groupedSessions is a computed property that iterates all sessions, builds
      groups, and sorts by groupOrder on every access. In SessionsView, it's
      accessed multiple times per view body evaluation: by
      ForEach(groupedSessions) in the list body, and by
      firstSessionWithNotification (which internally iterates groupedSessions)
      in both the button action and .disabled modifier. Each body evaluation
      triggers 2-3 full grouping computations.


      Suggestion: For typical session counts (<50) this is negligible. Consider
      caching groupedSessions as a stored property invalidated when sessions or
      groupOrder change if session counts grow, or accept the current approach
      with a comment noting it's adequate for expected counts.


      Related file: tim-gui/TimGUI/SessionState.swift:31-64
  - title: "Address Review Feedback: The .onMove modifier (line 153) is applied to a
      ForEach that produces multiple views per iteration — a
      SessionGroupHeaderView plus optionally an inner ForEach of session rows."
    done: true
    description: >-
      The .onMove modifier (line 153) is applied to a ForEach that produces
      multiple views per iteration — a SessionGroupHeaderView plus optionally an
      inner ForEach of session rows. SwiftUI's .onMove is designed for ForEach
      producing a single view per iteration. With multiple views, drag behavior
      may be unpredictable: session rows might get drag handles (moving their
      parent group), or drag handles might appear inconsistently. The moveGroup
      logic layer is resilient (rebuilds from visible groups), so no crash risk,
      but the UI drag experience may be surprising.


      Suggestion: Wrap each group's output in a Section with a custom header, or
      use a single composite view per ForEach iteration. Alternatively, verify
      via manual testing on macOS 14+ that the current approach works as
      expected and add a comment noting the unconventional pattern.


      Related file: tim-gui/TimGUI/SessionsView.swift:125-155
  - title: "Address Review Feedback: `firstSessionWithNotification` violates the
      required display-order semantics."
    done: true
    description: >-
      `firstSessionWithNotification` violates the required display-order
      semantics. It scans `sessions` directly (`self.sessions.first { ... }`),
      which is insertion order, not grouped UI order. After a user reorders
      groups, the bell button can jump to a notification in a lower group
      instead of the topmost visible notification group. This is a functional
      mismatch with the plan/acceptance behavior for notification jumping.


      Suggestion: Compute first unread using display order (`groupedSessions`
      order + per-group row order), or maintain a derived ordered list keyed by
      `groupOrder` so selection always matches sidebar order.


      Related file: tim-gui/TimGUI/SessionState.swift:74-76
changedFiles:
  - README.md
  - tim-gui/AGENTS.md
  - tim-gui/TimGUI/ProjectTrackingStore.swift
  - tim-gui/TimGUI/SessionModels.swift
  - tim-gui/TimGUI/SessionState.swift
  - tim-gui/TimGUI/SessionsView.swift
  - tim-gui/TimGUITests/SessionModelTests.swift
  - tim-gui/TimGUITests/SessionStateTests.swift
tags: []
---

## Expected Behavior/Outcome

The session sidebar (left panel in the Sessions tab) groups sessions by the project they belong to, instead of displaying
a flat list. Each group:

- Has a **collapsible header** showing the project display name and a session count badge.
- When **collapsed**, hides individual session rows but shows a blue notification dot if any child session has an unread notification.
- When **expanded** (default), shows session rows as before.
- Groups can be **reordered by dragging** group headers.
- A **toolbar button** jumps to the first session with an active notification.

### Project Display Name Derivation

- When `gitRemote` is available on a session, parse it to extract `owner/repository` (the last two path segments).
- If the `owner` matches the current macOS user (from `NSUserName()` or the `USER` environment variable), display just the `repository` name.
- When `gitRemote` is not available, fall back to the last two components of `workspacePath`.
- Sessions with neither value are placed in an "Unknown" group.

### State Definitions

- **Group expanded** (default): Header row + all session rows visible.
- **Group collapsed**: Header row only visible; session rows hidden.
- **Group has notification**: At least one child session has `hasUnreadNotification == true`. When collapsed, the group header shows a blue dot.
- **No sessions**: Empty state view as before (no groups shown).

## Key Findings

### Product & User Story

As a user monitoring multiple concurrent agent sessions across different projects, I want sessions grouped by project so
I can quickly find the right session. I also want to collapse projects I'm not actively watching and still see at a
glance if any session in that project needs attention (via the notification dot). The toolbar notification button lets me
jump to the most urgent session without scanning through groups.

### Design & UX Approach

- Use SwiftUI `DisclosureGroup` (or a custom collapsible section) within the sidebar `List` to create grouped sections.
- Group headers show: project name (left), session count badge (right), optional notification dot (right, only when collapsed).
- Drag-to-reorder uses SwiftUI's `.onMove` modifier on the outer group list.
- The "jump to notification" toolbar button uses an SF Symbol like `bell.badge` and is always visible but disabled when no sessions have notifications.
- Follow AGENTS.md guidance: use `.opacity()` instead of conditional rendering for the notification dot to avoid layout shifts.

### Technical Plan & Risks

**Files to modify:**
- `SessionsView.swift` — Replace flat `List` with grouped list using `DisclosureGroup`; add toolbar notification button.
- `SessionState.swift` — Add computed properties for grouped sessions, group ordering state, and a method to find the first session with a notification.
- `SessionModels.swift` — Add a `SessionGroup` model and a `parseProjectDisplayName()` utility function.

**Risks:**
- SwiftUI `List` with `DisclosureGroup` inside can have selection behavior quirks — need to ensure `selectedSessionId` binding still works correctly.
- Drag-to-reorder within a `List` using `.onMove` works on the flat item level; may need to store group order separately in `SessionState` and use `ForEach` with `onMove` on the group level.
- `@Observable` class properties trigger fine-grained SwiftUI updates — adding computed group properties should not cause performance issues, but the grouping computation itself needs to be efficient (it runs on every session change).

### Pragmatic Effort Estimate

This is a medium-sized feature touching 3 Swift files with well-defined scope. The main complexity is in the SwiftUI
list grouping and drag-to-reorder interaction. The project name parsing and notification bubbling are straightforward.

## Acceptance Criteria

- [ ] Sessions in the sidebar are grouped by project, derived from `gitRemote` (or `workspacePath` fallback).
- [ ] Project display names show `owner/repo` format, with `owner` elided when it matches the current user.
- [ ] Each group header shows the number of sessions in that group.
- [ ] Groups can be collapsed and expanded by clicking the header.
- [ ] When a group is collapsed, a blue dot appears on the header if any child session has an unread notification.
- [ ] Workspace groups can be reordered by dragging group headers.
- [ ] A toolbar button jumps to the first session with an active notification and expands its group.
- [ ] The toolbar button is disabled (but visible) when no sessions have notifications.
- [ ] Empty state (no sessions) still displays correctly.
- [ ] Existing session selection, dismissal, and notification clearing continue to work.
- [ ] All new logic (project name parsing, grouping, notification bubbling) has unit tests.
- [ ] App builds and all existing tests pass.

## Dependencies & Constraints

- **Dependencies**: None external — all work is within the existing tim-gui SwiftUI app.
- **Technical Constraints**: Must work on macOS 14.0+ (the app's deployment target). SwiftUI `DisclosureGroup` is available since macOS 11, so no compatibility issues.

## Implementation Notes

### Recommended Approach

1. **Add project display name parsing** as a static function in `SessionModels.swift`. Parse the `gitRemote` string to
   extract the last two path components (owner/repo), stripping `.git` suffix. Compare owner against `NSUserName()` and
   `ProcessInfo.processInfo.environment["USER"]` for elision. Fall back to `SessionRowView.shortenedPath()` on
   `workspacePath`. This function should be testable in isolation.

2. **Add `SessionGroup` model** in `SessionModels.swift`:
   ```swift
   struct SessionGroup: Identifiable {
       let id: String          // grouping key (gitRemote or workspacePath)
       var displayName: String // derived project display name
       var sessions: [SessionItem]
       var hasNotification: Bool { sessions.contains { $0.hasUnreadNotification } }
       var sessionCount: Int { sessions.count }
   }
   ```

3. **Add grouping logic to `SessionState`**:
   - Add `groupOrder: [String]` property to store the user's custom group ordering (persisted with `@AppStorage` or just `@State` in the view).
   - Add a computed property `groupedSessions: [SessionGroup]` that groups `sessions` by their group key, ordered by `groupOrder` with new groups appended at the end.

4. **Replace `SessionListView`** body:
   - Use `List` with `ForEach` over grouped sessions, each group rendered as a `DisclosureGroup`.
   - Track collapsed/expanded state per group in a `Set<String>` (expanded group IDs).
   - Inside each `DisclosureGroup`, render `SessionRowView` for each session.
   - Add `.onMove` on the `ForEach` of groups to support reordering.

5. **Add toolbar notification button**:
   - Add a `ToolbarItem` with `bell.badge` icon.
   - On tap, find the first session with `hasUnreadNotification == true`, expand its group, and set `selectedSessionId`.

### Potential Gotchas

- `DisclosureGroup` inside `List` with selection binding: The `List(selection:)` binding needs to work with items inside
  `DisclosureGroup`. This should work if session rows are directly inside the `ForEach` within each `DisclosureGroup`,
  but needs verification. If it doesn't work, use a custom expand/collapse approach with `if` conditionals instead.
- `onMove` applies to `ForEach` items — ensure it's on the outer group-level `ForEach`, not the inner session-level one.
- The notification dot on collapsed groups uses `.opacity()` per AGENTS.md conventions to avoid layout shifts.
- When a new session arrives and its group doesn't exist yet in `groupOrder`, append the group at the top (index 0) so
  new projects are immediately visible.

## Step-by-Step Implementation Guide

### Phase 1: Project Name Parsing and Grouping Model

**Goal**: Add the data model layer for parsing project names from git remotes and grouping sessions.

1. **Add `parseProjectDisplayName()` to `SessionModels.swift`**:
   - Input: `gitRemote: String?`, `workspacePath: String?`
   - Parse `gitRemote` to extract last two path segments (owner/repo). Handle SSH (`git@host:owner/repo.git`) and
     HTTPS (`https://host/owner/repo.git`) formats. Strip `.git` suffix.
   - Determine current user via `NSUserName()` as primary, `ProcessInfo.processInfo.environment["USER"]` as fallback.
   - If owner matches current user (case-insensitive), return just `repo`.
   - If no gitRemote, fall back to `SessionRowView.shortenedPath(workspacePath)` (the last 2 path components).
   - If neither available, return `"Unknown"`.
   - Also add `sessionGroupKey()` — returns a stable string key for grouping (the normalized remote URL or workspacePath).

2. **Add `SessionGroup` struct to `SessionModels.swift`**:
   - Properties: `id: String` (group key), `displayName: String`, `sessions: [SessionItem]`.
   - Computed: `hasNotification: Bool`, `sessionCount: Int`.

3. **Write unit tests** in `SessionModelTests.swift`:
   - Test `parseProjectDisplayName()` with SSH remotes, HTTPS remotes, no remote (workspacePath fallback), neither.
   - Test owner-matching elision (current user == owner → repo only).
   - Test `sessionGroupKey()` returns consistent keys.

### Phase 2: Session Grouping Logic in SessionState

**Goal**: Add computed grouping and group order management to `SessionState`.

1. **Add group order state to `SessionState`**:
   - `var groupOrder: [String] = []` — ordered list of group keys.
   - `func moveGroup(from: IndexSet, to: Int)` — reorder groups.

2. **Add `groupedSessions` computed property**:
   - Group `sessions` by `sessionGroupKey()`.
   - Order groups according to `groupOrder`, with unknown groups appended at the end.
   - Return `[SessionGroup]`.

3. **Add `firstSessionWithNotification` computed property**:
   - Returns the first `SessionItem` (in display order, scanning groups top-to-bottom) with `hasUnreadNotification == true`.

4. **Handle new group insertion**:
   - In `addSession()`, after inserting a session, check if its group key exists in `groupOrder`. If not, insert it at index 0.

5. **Handle group removal**:
   - In `dismissSession()` and `dismissAllDisconnected()`, clean up `groupOrder` entries that no longer have any sessions.

6. **Write unit tests** in `SessionStateTests.swift`:
   - Test grouping: sessions with same gitRemote go in same group.
   - Test group ordering: groups appear in `groupOrder` order.
   - Test `moveGroup`: reordering persists.
   - Test `firstSessionWithNotification`: returns correct session across groups.
   - Test new group auto-insertion at index 0.
   - Test group cleanup on dismiss.

### Phase 3: Grouped Session List UI and Toolbar Button

**Goal**: Replace the flat session list with grouped collapsible sections and add the notification jump button.

1. **Add collapsed state tracking to `SessionListView`**:
   - `@State private var collapsedGroups: Set<String> = []` — group keys that are collapsed.

2. **Replace `SessionListView` body** with grouped rendering:
   - Use `List(selection: $sessionState.selectedSessionId)` wrapping a `ForEach(sessionState.groupedSessions)`.
   - Each group renders a `SessionGroupHeaderView` (tappable to toggle collapse) followed by session rows (hidden when collapsed).
   - Use `ForEach` with `.onMove` on the group level for drag-to-reorder.

3. **Create `SessionGroupHeaderView`**:
   - Shows: project display name (left), session count badge (right), notification dot (right, opacity-based, visible only when collapsed and has notification).
   - Tapping toggles the group's collapsed state.
   - Chevron indicator (rotated when collapsed).

4. **Add "Jump to Notification" toolbar button**:
   - SF Symbol: `bell.badge` or `bell.badge.fill`.
   - Enabled when `sessionState.firstSessionWithNotification != nil`.
   - On tap:
     a. Get the first session with notification.
     b. Ensure its group is expanded (remove from `collapsedGroups`).
     c. Set `selectedSessionId` to that session's id.
     d. Clear its notification via `handleSessionListItemTap()`.

5. **Update existing toolbar** to include both the notification jump button and the "Clear Disconnected" button.

6. **Write unit tests** for any new testable logic (group header notification bubbling is already tested via `SessionGroup.hasNotification`).

7. **Update SwiftUI previews** in `SessionsView.swift` to demonstrate grouped sessions with multiple projects.

## Current Progress
### Current State
- All 11 tasks are complete. The session grouping feature is fully implemented with all review feedback addressed, tested, and verified.
### Completed (So Far)
- `parseProjectDisplayName()` and `sessionGroupKey()` added to SessionModels.swift with SSH/HTTPS git remote parsing, owner elision, workspacePath fallback
- `SessionGroup` struct added with computed `hasNotification` and `sessionCount`
- `groupOrder`, `groupedSessions`, `moveGroup()`, `firstSessionWithNotification` added to SessionState
- `addSession()` auto-inserts new group keys at index 0 of `groupOrder`
- `dismissSession()` and `dismissAllDisconnected()` clean up empty group keys
- 14 unit tests for project display name parsing and grouping keys
- 8 unit tests for SessionState grouping logic
- `SessionListView` replaced flat list with grouped collapsible sections using `ForEach(groupedSessions)` + custom collapse via `collapsedGroups: Set<String>`
- `SessionGroupHeaderView` created with animated chevron, display name, session count badge, and opacity-based notification dot
- `.onMove` on outer ForEach for group drag-to-reorder
- Bell badge toolbar button added: always visible, disabled when no notifications, expands group + selects session on tap
- SwiftUI preview updated to show 4 sessions across 3 different projects
- Review feedback fixes: `parseProjectDisplayName` now implements full NSUserName()/USER env var fallback chain; `addSession` cleans up stale group keys on metadata change; `moveGroup` rebuilds from `groupedSessions` to avoid index mismatch crash
- 5 additional tests for review feedback fixes
- `groupedSessions` performance comment added
- `firstSessionWithNotification` now iterates `groupedSessions` (display order) instead of `sessions` (insertion order), with test verifying behavior after group reorder
- ForEach iterations wrapped in `Section` for correct `.onMove` single-view-per-iteration behavior
- Build, tests, and lint all pass
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- `parseProjectDisplayName` accepts an optional `currentUser` parameter for testability (defaults to full fallback chain: NSUserName() → ProcessInfo USER env var)
- `sessionGroupKey` lowercases the normalized `owner/repo` so SSH and HTTPS URLs for the same repo produce the same key
- `SessionGroup` is `@MainActor` since it contains `[SessionItem]` which is `@MainActor`
- Notification-only sessions don't update `groupOrder` directly — they appear via the "append at end" path and get promoted when `addSession()` reconciles them
- Used custom collapse/expand with `if !collapsedGroups.contains(group.id)` conditionals instead of `DisclosureGroup` to avoid `List(selection:)` interaction quirks
- Session rows tagged with `.tag(session.id)` to make `List(selection:)` binding work inside grouped ForEach
- Group header rendered as `Section` header instead of a sibling row — this ensures `.onMove` sees one view per ForEach iteration
- `moveGroup` rebuilds order from `groupedSessions.map(\.id)` instead of directly mutating `groupOrder`, ensuring index alignment with UI's `.onMove`
- `addSession` computes old group key before metadata update and removes stale keys when session's group changes
- `firstSessionWithNotification` iterates `groupedSessions` (display order) to ensure the bell button jumps to the topmost visible notification group after user reordering
### Lessons Learned
- Custom collapse/expand using `if` conditionals + `Set<String>` is more reliable than `DisclosureGroup` inside `List(selection:)` for maintaining selection binding behavior
- When a UI modifier (`.onMove`) provides indices into a computed array, any function receiving those indices must operate on the same array — never on a potentially different-length backing array
- When updating mutable state that determines grouping, always compute the old key before mutating and reconcile afterwards to prevent stale entries accumulating
- Nil-coalescing (`??`) doesn't handle the "present but empty string" case — use explicit emptiness checks for fallback chains involving string values
- SwiftUI's `.onMove` expects each `ForEach` iteration to produce a single view — when emitting multiple sibling views (header + rows), wrap them in a `Section` to ensure correct drag behavior
- When a computed property is accessed multiple times in a SwiftUI view body, consider whether downstream consumers (like `firstSessionWithNotification`) can avoid triggering the full recomputation by operating on the underlying data directly
- When optimizing a computed property to avoid recomputation, verify the optimization doesn't change the semantic contract — scanning a raw array for "first match" is only valid if the array order matches the intended display order
### Risks / Blockers
- None
