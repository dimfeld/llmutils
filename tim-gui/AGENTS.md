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

## Projects View

The app has two top-level views switched via a segmented picker in `ContentView.swift`:

- **Sessions** — live agent session monitoring (existing behavior, unchanged)
- **Projects** — browse projects, workspaces, and plan-level task tracking from `tim.db`

### Projects View Layout (`ProjectsView.swift`)

The Projects view uses a `NavigationSplitView`:

- **Sidebar** — project list; each row shows the project display name and the last two path components of its git root for context
- **Detail pane** — scrollable `ProjectDetailView` for the selected project, containing:
  - **Workspaces section** — each workspace row shows: name, current git branch (chip), the plan it is assigned to, and a status badge (Primary / Locked / Available)
  - **Plans section** — filter chip row (one per `PlanDisplayStatus`) followed by matching plan rows; each plan row shows plan number, title, goal, status badge, and a relative timestamp

**Filter controls** in the Plans section header:

- Toggle individual chips to include/exclude status groups
- **"All"** button — enables all status chips at once
- **"Reset"** button — restores the default active set (pending, in-progress, blocked, recently done)

**Default filter** — visible by default:

- `pending` — plan status is `pending` with no unresolved dependencies
- `in_progress` — plan status is `in_progress`
- `blocked` — plan status is `pending` AND at least one dependency plan is not yet `done`
- `recently_done` — plan status is `done` AND `updated_at` is within the last 7 days

Hidden by default: `done` (older than 7 days), `cancelled`, `deferred`.

**States handled:** loading spinner, empty (no projects), error (DB unreadable), and data (split view).

### Project Tracking Data Layer

The app reads `tim.db` (SQLite, read-only). All data for the Projects view comes from this database; no plan markdown files are scanned.

**Key files:**

- `ProjectTrackingModels.swift` — Domain types (`TrackedProject`, `TrackedWorkspace`, `TrackedPlan`, `PlanDisplayStatus`) and pure filter functions
- `ProjectTrackingStore.swift` — `@Observable @MainActor` store that queries `tim.db`, manages `LoadState`, and runs periodic refresh
- `ProjectsView.swift` — SwiftUI view hierarchy for the Projects tab
- `ContentView.swift` — top-level view with `AppTab` segmented picker (Sessions / Projects); switching tabs does not affect `SessionState` or WebSocket connections

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

- `startRefreshing()` (called on `ProjectsView.onAppear`) does immediate load + 10-second periodic refresh via `Task.sleep` with cancellation
- `stopRefreshing()` (called on `ProjectsView.onDisappear`) cancels the loop
- Concurrent refresh requests are coalesced; additional calls request a follow-up refresh, so updates are not dropped
- All published state updates happen on MainActor

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

## SwiftUI Conventions

- **Use `.opacity()` instead of conditional rendering for fixed-size elements**: When toggling visibility of small fixed-size elements (e.g., indicator dots), use `.opacity(condition ? 1 : 0)` rather than `if condition { Circle() }`. Conditional rendering causes layout shifts as SwiftUI adds/removes the element from the view hierarchy, while opacity reserves the space and avoids jank.
- **Unread-dot behavior**: Clear `hasUnreadNotification` when the user either clicks the session row or clicks the WezTerm terminal icon in that row.
