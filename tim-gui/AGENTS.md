## Build and Test

- `./scripts/restart.sh` (rebuild signed Debug + restart)
- `./scripts/build.sh` (plain build without running)
- `./scripts/test.sh` (run unit tests via xcodebuild)
- `./scripts/lint.sh` (SwiftFormat + SwiftLint)

## Documentation

Look in the `docs` directory for guidance on writing Swift and using SwiftUI.

## Message Sending Architecture

- **OutgoingMessage enum** (in `SessionModels.swift`): Encodable enum for GUI→backend messages. Cases:
  - `.userInput(content:)` — free-form text input to agent stdin
  - `.promptResponse(requestId:, value:)` — structured response to an interactive prompt (confirm, select, input, checkbox, prefix_select)
- **PromptResponseValue** (in `SessionModels.swift`): Encodable/Equatable enum representing typed prompt response values (`.bool`, `.string`, `.int`, `.double`, `.array`, `.object`). Uses `singleValueContainer()` encoding to produce raw JSON types for backend compatibility. Also used as the storage type for choice values and defaults in `PromptChoiceConfigPayload.value` and `PromptConfigPayload.defaultValue` — values are decoded into their original JSON types (Bool before Int/Double before String) at parse time, avoiding lossy string coercion and heuristic type reversal.
- **Prompt state tracking**: `SessionItem` has a `pendingPrompt: PromptRequestPayload?` field. `SessionState` provides `setActivePrompt`, `clearActivePrompt`, and `sendPromptResponse` methods. These no-op during replay (checked via `replayingConnections`) to prevent stale prompts from appearing after reconnect. `markDisconnected` clears any pending prompt. `sendPromptResponse` only clears `pendingPrompt` if the requestId still matches after the async send, preventing a race where a new prompt arriving during the network send gets wiped.
- **Prompt UI error handling and double-submission protection**: `PromptContainerView` centralizes async lifecycle for all prompt sub-views. It manages `isSending` state (passed down as `Bool` to disable submit/action buttons in sub-views) and `sendError` state (shown as an inline error message that auto-clears after 3 seconds). The `handleResponse()` method guards against double submission, wraps the async send in do/catch, and re-enables buttons after completion. This follows the same pattern as `MessageInputBar`.
- **Prompt event wiring**: `TimGUIApp.swift` wsHandler matches `.structured(message: .promptRequest(...))` and `.structured(message: .promptAnswered(...))` tunnel messages, delegating to SessionState methods which handle replay safety internally.
- **SessionState.sendMessageHandler**: Closure wired in `TimGUIApp.swift` that serializes `OutgoingMessage` to JSON and sends via `LocalHTTPServer.sendMessage(to:text:)`. Throws `SendError.noHandler` if not set.
- **MessageInputBar** (in `SessionsView.swift`): Auto-growing text field (1–5 lines) with Enter-to-send, Shift+Enter for newlines. Only visible when session is active. Reports its height via `InputBarHeightKey` preference so the scroll-to-bottom button stays above it.
- **Backend handling**: `HeadlessAdapter.setUserInputHandler()` receives `user_input` messages and `handleServerMessage()` receives `prompt_response` messages. See `docs/executor-stdin-conventions.md` for details.

## Active Work Dashboard

The app has three top-level tabs switched via a segmented picker in `ContentView.swift`:

- **Sessions** — live agent session monitoring (existing behavior, unchanged)
- **Active Work** — focused dashboard showing in-progress plans and workspaces from `tim.db`
- **Plans** — full-featured plan browser with status filters, search, sorting, compact plan list, and expanded detail panel showing full plan information (title, goal, status, priority, workspace, dependencies, timestamps) in a third column.

### Active Work Layout (`ProjectsView.swift`)

The Active Work view uses a `NavigationSplitView`:

- **Sidebar** — project list; each row shows the project display name and the last two path components of its git root for context
- **Detail pane** — scrollable `ProjectDetailView` for the selected project, containing:
  - **Workspaces section** — shows only recently active workspaces by default (locked, primary, or updated within 48 hours). A "Show all workspaces (N total)" toggle expands to the full list. Each workspace row shows: name, current git branch (chip), assigned plan as `#planId title` (when present), and a status badge for non-default states only (Primary / Locked). Available status is implied by absence of a badge. Uses unconditional `.frame(width: 14)` on the status icon area to maintain row alignment across mixed states. The section uses `.id(selectedProjectId)` to reset the `@State` toggle when switching projects.
  - **Plans section** — shows only active plans (in-progress and blocked); no filter chips. Each plan row shows plan number, title, goal, status badge, and a relative timestamp.

**Plan filtering** — hardcoded to show only active work:

- `in_progress` — plan status is `in_progress`
- `blocked` — plan status is `pending` AND at least one dependency plan is not yet `done`

The filter uses the `PlanDisplayStatus.isActiveWork` computed property as a shared predicate.

**Empty states:**

- **No active plans (but workspaces exist)** — section-level message: "No active plans — browse all plans to get started"
- **No workspaces and no active plans** — full empty state in `ProjectDetailView` guiding the user to pick up work
- **Loading/error** — loading spinner, empty (no projects), error (DB unreadable)

### Plans Tab (`PlansView.swift`)

The Plans tab provides a comprehensive plan browsing experience, complementing the Active Work tab's focused view. It uses a 3-column `NavigationSplitView`: project sidebar | plan list | detail panel. The same `ProjectListView` sidebar is shared (shared `ProjectTrackingStore` instance keeps project selection synchronized across tabs).

**Plan list pane** — `PlansBrowserView` for the selected project, containing:

- **Search field** — text field with magnifying glass icon that filters plans by title and goal text using `localizedCaseInsensitiveContains`. Resets on project change via `.id(store.selectedProjectId)`. Implemented as `filterPlansBySearchText()` module-level function for testability.
- **Sort picker** — compact `.menu`-style Picker with `PlanSortOrder` enum: Recently Updated (default), Plan Number (descending), Priority. All sort modes use deterministic tiebreakers (planId DESC, then uuid) to prevent list jitter on periodic refreshes. Priority sort ranks: urgent > high > medium > low > maybe > nil/unknown.
- **FilterChipsView** — toggle chips for all 7 `PlanDisplayStatus` values (Pending, In Progress, Blocked, Recently Done, Done, Cancelled, Deferred), plus Reset and All controls. Active chips use colored fill backgrounds; inactive chips use status-colored fills (using `PlanDisplayStatus.color`).
- **Grouped plan list** — after filtering and searching, plans are grouped by display status into collapsible sections via `groupPlansByStatus()` (a pure, testable function). Groups are ordered: In Progress, Pending, Blocked, Recently Done, Done, Deferred, Cancelled. Empty groups are hidden. Each group is rendered as a `Section` with a `PlanGroupHeaderView` header containing: animated chevron (rotates 0°→90° on expand), status icon and label in the status color, and a plan count badge in a capsule. Clicking the header toggles collapse/expand (state tracked via `@State collapsedGroups: Set<PlanDisplayStatus>`). Within each group, `PlanRowView` entries are sorted by the selected sort order. Collapse state resets when switching projects (via `.id(store.selectedProjectId)`). The `visiblePlanUuids(from:)` helper (extracted for testability) collects all visible plan UUIDs from groups for deselection logic.

**Detail panel** — `PlanDetailView` shown when a plan is selected, displaying:

- Plan number, title, full goal text
- Status with icon, priority
- Unresolved dependencies (row hidden when there are none, since the data model only tracks boolean unresolved state)
- Assigned workspace name (or "Unassigned"), branch
- Epic indicator, parent UUID, filename
- Created and updated timestamps

Selection clears on project change and when the selected plan is filtered out. `.id(uuid)` on the detail view forces scroll position reset when selection changes.

**`PlanDisplayStatus` computed properties** — `color: Color` and `icon: String` are defined as computed properties on `PlanDisplayStatus` in `ProjectTrackingModels.swift`, providing centralized status→color and status→icon mappings. Used by `PlanRowView`, `PlanDetailView`, `FilterChipsView`, and `PlanGroupHeaderView`.

### Project Tracking Data Layer

The app reads `tim.db` (SQLite, read-only). All data for the Projects view comes from this database; no plan markdown files are scanned.

**Key files:**

- `ProjectTrackingModels.swift` — Domain types (`TrackedProject`, `TrackedWorkspace`, `TrackedPlan`, `PlanDisplayStatus`) and pure filter functions. `TrackedWorkspace.isRecentlyActive(now:)` encapsulates the 48-hour recency check (locked/primary override regardless of date).
- `ProjectTrackingStore.swift` — `@Observable @MainActor` store that queries `tim.db`, manages `LoadState`, and runs periodic refresh. Includes shared `parseISO8601Date()` helper (file-private, local formatters for thread safety) used by both workspace and plan fetch functions.
- `ProjectsView.swift` — SwiftUI view hierarchy for the Active Work tab
- `PlansView.swift` — SwiftUI view hierarchy for the Plans tab (full plan browser with filter chips and filtered list)
- `ContentView.swift` — top-level view with `AppTab` segmented picker (Sessions / Active Work / Plans); switching tabs does not affect `SessionState` or WebSocket connections

**Database access:**

- Uses Apple's built-in `SQLite3` C API (no external packages)
- Opens read-only connections per query batch via `withSQLiteDB()` helper (not kept open)
- 5-second busy timeout for WAL contention with concurrent tim CLI writes
- DB path mirrors tim CLI conventions: `$XDG_CONFIG_HOME/tim/tim.db` or `~/.config/tim/tim.db`, overridable via `TIM_DATABASE_FILENAME` env var
- DB path is injectable via `ProjectTrackingStore(dbPath:)` for tests
- All `sqlite3_step` loops validate return codes: continue on `SQLITE_ROW`, break on `SQLITE_DONE`, throw `StoreError.queryFailed(...)` with `sqlite3_errmsg` on any other code. This prevents partial data from being silently treated as complete results under busy/error conditions.

**Plan display status mapping:**

- `pending` → `.pending` (or `.blocked` if `plan_dependency` has at least one dependency whose status is not `done`)
- `in_progress` → `.inProgress`
- `done` + `updated_at` within 7 days → `.recentlyDone`
- `done` + older → `.done`
- `cancelled` → `.cancelled`, `deferred` → `.deferred`

**Refresh lifecycle:**

- `startRefreshing()` / `stopRefreshing()` are **reference-counted** — multiple tabs (Active Work, Plans) share the same `ProjectTrackingStore` and each call `startRefreshing()` on appear / `stopRefreshing()` on disappear. The refresh loop runs while any tab holds a reference, preventing race conditions during tab switches where lifecycle ordering is not guaranteed.
- First `startRefreshing()` call does immediate load + 10-second periodic refresh via `Task.sleep` with cancellation
- Last `stopRefreshing()` call (refcount reaches zero) cancels the loop
- Concurrent refresh requests are coalesced; additional calls request a follow-up refresh, so updates are not dropped
- All published state updates happen on MainActor

## Session Grouping by Project

Sessions in the sidebar are grouped by project/workspace. The grouping logic lives in two layers:

### Model Layer (`SessionModels.swift`)

- **`parseProjectDisplayName(gitRemote:workspacePath:currentUser:)`** — Derives a human-readable project name. Parses `gitRemote` (SSH `git@host:owner/repo.git` or HTTPS `https://host/owner/repo.git`) to extract `owner/repo`, stripping `.git` suffix. If `owner` matches the current macOS user (via `NSUserName()` or `USER` env var, case-insensitive), returns just the repo name. Falls back to `SessionRowView.shortenedPath()` on `workspacePath`, then `"Unknown"`.
- **`sessionGroupKey(gitRemote:workspacePath:)`** — Returns a stable, lowercased grouping key: normalized `owner/repo` from `gitRemote`, or `workspacePath`, or `"__unknown__"`. Lowercasing ensures SSH and HTTPS URLs for the same repo produce the same key.
- **`SessionGroup`** — `@MainActor` struct with `id` (group key), `displayName`, `sessions: [SessionItem]`, and computed `hasNotification` / `sessionCount`.

### State Layer (`SessionState.swift`)

- **`groupOrder: [String]`** — Ordered list of group keys controlling sidebar display order.
- **`groupedSessions: [SessionGroup]`** — Computed property that groups sessions by `sessionGroupKey()`, ordered by `groupOrder`, with unknown groups appended at the end.
- **`firstSessionWithNotification: SessionItem?`** — Computed, iterates `groupedSessions` in display order (group-by-group, then session-by-session within each group) so the toolbar bell button always jumps to the topmost visible notification after user reordering.
- **`moveGroup(from:to:)`** — Rebuilds `groupOrder` from `groupedSessions.map(\.id)` before applying the move, ensuring indices from `.onMove` align with the visible list (not the raw backing array, which may differ in length).
- **Auto-insertion and stale key cleanup**: `addSession()` inserts new group keys at index 0 of `groupOrder`. When a session's metadata changes its group key, the old key is removed from `groupOrder` (if no other sessions remain in that group) before inserting the new one.
- **Cleanup**: `dismissSession()` and `dismissAllDisconnected()` remove `groupOrder` entries with no remaining sessions.

### UI Layer (`SessionsView.swift`)

- **`SessionListView`** uses `@State private var collapsedGroups: Set<String>` to track collapsed groups. The list body iterates `ForEach(sessionState.groupedSessions)` with `.onMove` for group drag-to-reorder. Each ForEach iteration wraps its output in a `Section` (header + session rows) so `.onMove` sees one view per iteration — without this, multiple sibling views per iteration cause unpredictable drag behavior. Uses custom collapse/expand via `if !collapsedGroups.contains(group.id)` rather than `DisclosureGroup`, which has selection-binding quirks inside `List(selection:)`. Session rows are tagged with `.tag(session.id)` to make the selection binding work inside grouped `ForEach`.
- **`SessionGroupHeaderView`** — Shows animated chevron (rotated when collapsed), project display name, session count badge (capsule), and notification dot (opacity-based, visible only when collapsed and group has notification). Uses `.listRowBackground(.clear)` and `.listRowSeparator(.hidden)` for clean appearance.
- **Toolbar notification button** — `bell.badge` SF Symbol, disabled when `sessionState.firstSessionWithNotification` is nil. On tap: expands the target group (removes from `collapsedGroups`), selects the session, and calls `handleSessionListItemTap(sessionId:)`. Placed before the "Clear Disconnected" button.

## Development Conventions

### Async Coalescing

When coalescing async operations (e.g., refresh cycles), a simple boolean `isRefreshing` guard that drops concurrent calls creates race windows where user-initiated changes are lost. Instead, use a `needsRefresh` flag that the active operation checks after completing — the running operation loops back for another pass if the flag was set during execution, ensuring no request is silently dropped.

### SQLite C API Usage

All `sqlite3_step` loops **must** validate return codes — `while sqlite3_step(stmt) == SQLITE_ROW` silently swallows errors. The required pattern:

1. Capture the return code in a variable
2. Loop while code is `SQLITE_ROW`
3. After the loop, check for `SQLITE_DONE` vs error codes
4. On error, include `sqlite3_errmsg(db)` in the thrown error message for diagnostics
5. In `withCString` closures where you can't throw, capture the error in a local variable and throw after the closure exits

### Foundation Formatter Thread Safety

`NSFormatter` subclasses (including `ISO8601DateFormatter`, `DateFormatter`, `NumberFormatter`) are **not thread-safe**. Do not hoist them to `nonisolated(unsafe)` globals for reuse across async functions. Instead, create formatter instances at function scope — this avoids both global thread-safety hazards and per-row allocation overhead, striking a good middle ground for performance and correctness.

## SwiftUI Conventions

- **Use `.opacity()` instead of conditional rendering for fixed-size elements**: When toggling visibility of small fixed-size elements (e.g., indicator dots), use `.opacity(condition ? 1 : 0)` rather than `if condition { Circle() }`. Conditional rendering causes layout shifts as SwiftUI adds/removes the element from the view hierarchy, while opacity reserves the space and avoids jank.
- **Unread-dot behavior**: Clear `hasUnreadNotification` when the user either clicks the session row or clicks the WezTerm terminal icon in that row.
- **`.onMove` requires one view per `ForEach` iteration**: When a group needs multiple sibling views (e.g., header + session rows), wrap them in a `Section`. Without this, `.onMove` cannot determine item boundaries and drag behavior becomes unpredictable.
- **`.onMove` index alignment**: `.onMove` provides indices into the array that `ForEach` iterates. Any function receiving those indices must operate on the same array. If the backing store differs in length or ordering from the `ForEach` source, rebuild from the computed array before applying the move.
- **Prefer custom collapse over `DisclosureGroup` inside `List(selection:)`**: `DisclosureGroup` has selection-binding quirks when used inside `List(selection:)`. Use custom collapse/expand via `if` conditionals + `Set<String>` for tracking collapsed state when the list needs a working selection binding.
- **Computed property optimization vs. semantic contract**: When a computed property (e.g., grouped sessions) is accessed multiple times in a view body, downstream consumers can sometimes avoid recomputation by operating on the underlying data directly. However, verify this doesn't change semantics — e.g., scanning a raw array for "first match" is only correct if the array order matches the intended display order.
- **Use unconditional `.frame(width:)` for optional status icons**: When some rows show a status icon and others don't, wrap the icon area in an unconditional `.frame(width:)` so all rows reserve the same space. This maintains alignment across mixed states without layout shifts.
- **`@State` persists across parent data changes — use `.id()` to reset**: SwiftUI `@State` in child views is not recreated when the parent passes different data. If a child's local state (e.g., a toggle) should reset when context changes (e.g., project selection), apply `.id(contextValue)` to force view recreation.
- **Empty-state predicates must match displayed data**: When computing whether to show an empty state, use the same filtered subset that the UI section displays. Using raw collection counts (e.g., all workspaces vs. recently-active workspaces) can hide or incorrectly show empty states.
- **Pass shared reference time for time-dependent UI**: When multiple views or sections make decisions based on time windows (e.g., "updated within 48 hours"), capture a single `Date()` in the parent and pass it down. Even tiny skew between independent `Date()` calls can create boundary inconsistencies.
- **Reference-count shared `@Observable` lifecycle across tabs**: When multiple SwiftUI views share an `@Observable` store and each manages lifecycle calls (e.g., `onAppear`/`onDisappear` triggering start/stop), lifecycle ordering is not guaranteed during tab switches. Use reference-counting for start/stop calls so the refresh loop runs while any consumer holds a reference, and only stops when the last consumer disappears.
- **Add `.id(selectedId)` to `NavigationSplitView` detail views**: SwiftUI reuses the same `ScrollView` in a detail column when the structural view type doesn't change — this preserves the old scroll offset even when selection changes. Apply `.id(selectedId)` to force full view recreation and reset scroll position on selection change.
- **Sort comparators need deterministic tiebreakers for refreshing lists**: Even with Swift's stable sort, the source array order can change between periodic DB refresh cycles. Add deterministic tiebreakers (e.g., planId DESC, then uuid) to prevent list jitter on UI refresh.
- **Prefer hiding rows over showing ambiguous data**: When a data model only exposes partial information (e.g., a boolean "has unresolved dependencies" but not a full list), hide the row when there's nothing actionable to show rather than displaying an ambiguous "None" label.
- **Test `@Observable` stores by verifying observable state, not implementation details**: Tests should assert on published state (e.g., `loadState`, data arrays, computed properties) rather than inspecting private implementation details like internal `Task` handles. This makes tests resilient to refactoring and focused on behavior that matters to consumers.
- **Wrap state mutations in `withAnimation` for `ScrollView` + `LazyVStack` content changes**: Unlike `List`, content changes from state mutations in `ScrollView` + `LazyVStack` don't animate implicitly. Wrap state mutations (e.g., collapse/expand toggles) in `withAnimation(.easeInOut(duration: 0.2))` for smooth transitions.
