# Web Interface (Plans Browser)

## SvelteKit Conventions

### Data Loading

- Child layouts should use `await parent()` to access data already loaded by parent layouts instead of re-querying the database. This avoids duplicate work and keeps data consistent.
- All DB imports must be in `$lib/server/` or `+page.server.ts` files — `bun:sqlite` cannot be imported client-side.
- The server context (`src/lib/server/init.ts`) is lazily initialized because SvelteKit may import server modules during `svelte-kit sync` or type checking without a running server.

### HMR-Safe Server State

Module-scoped state in SvelteKit server modules is **not** HMR-safe — dev-server reloads re-execute the module and reset the state. For any server-side state that must survive HMR (singletons, locks, caches), store it on `globalThis` using `Symbol.for()` keys. See `src/lib/server/session_context.ts` and `src/lib/server/launch_lock.ts` for the canonical pattern.

### Server/Client Consistency

When broadening server-side behavior (e.g. making a check command-agnostic instead of filtering to specific commands), update all corresponding client-side logic to match. Otherwise the UI will be inconsistent with what the server enforces — for example, a client filtering sessions to `['generate', 'agent']` while the server blocks launches for any command type.

### Reactivity Gotchas (Svelte 5)

- `$derived(() => { ... })` wraps the **function object itself**, not the return value. For multi-statement derivations, use `$derived.by(() => { ... })`.
- SvelteKit **reuses page components** across param-only navigations — local `$state` persists across route changes. Use `afterNavigate` to reset `$state` when needed, though best is to use a "writable derived" when possible.
- Setting a reactive variable that controls a `disabled` attribute doesn't immediately update the DOM. You must `await tick()` before interacting with the element if the interaction depends on the updated DOM state (e.g., focusing a previously-disabled textarea after setting `sending = false`).

### HTML & Component Gotchas

- **No nested `<a>` tags**: When wrapping a component in an `<a>` tag (e.g., making a row clickable), check for nested `<a>` tags inside — browsers handle nested anchors unpredictably (the inner link may not work, or clicking behavior differs across browsers). Render inner links as plain text when the outer element is already a link.

### Routing Gotchas

- SvelteKit's `resolve()` from `$app/paths` enforces typed route parameters — it won't accept dynamic/computed path segments. Use `base` from `$app/paths` + template literals for dynamic paths.

## Architecture

- Route structure: `/projects/[projectId]/{tab}` where `projectId` is a numeric ID or `all`
- Tabs: `sessions`, `active`, `plans`
- `src/lib/server/plans_browser.ts` is the abstraction layer between route handlers and `db_queries.ts`
- Display statuses (`blocked`, `recently_done`) are computed server-side in `db_queries.ts`, not stored in DB
- Cookie-based project persistence: `src/lib/stores/project.svelte.ts` manages the last-selected project ID (httpOnly cookie, server-read only)

## Active Work Tab

The Active Work tab (`/projects/[projectId]/active`) provides a dashboard of current work per project with a split-pane layout.

### Route Structure

```
src/routes/projects/[projectId]/active/
├── +layout.server.ts       # Loads workspaces + active plans via getActiveWorkData()
├── +layout.svelte          # Split-pane: left sidebar (workspaces + plans list), right detail area
├── +page.svelte            # Empty state: "Select a workspace or plan to view details"
├── [planId]/
│   ├── +page.server.ts     # Loads plan detail via getPlanDetailRouteData(tab: 'plans')
│   └── +page.svelte        # Renders PlanDetail component
└── workspace/[workspaceId]/
    ├── +page.server.ts     # Loads workspace detail via getWorkspaceDetail(), validates ownership
    └── +page.svelte        # Workspace detail with lock/unlock actions
```

### Data Flow

- `getWorkspacesForProject(db, projectId?)` in `db_queries.ts` — LEFT JOINs `workspace` with `workspace_lock`, calls `cleanStaleLocks(db)` first, returns `EnrichedWorkspace[]` with `isRecentlyActive` computed flag
- `getActiveWorkData(db, projectId)` in `plans_browser.ts` — combines workspace data with plans filtered to `displayStatus === 'in_progress' || 'blocked'`
- "Recently active" criteria: workspace is locked, is primary, is auto, or has `updated_at` within 48 hours (`RECENTLY_ACTIVE_WINDOW_MS`)

### Components

- `WorkspaceBadge.svelte` — pill badge for workspace status: Primary (blue), Auto (green), Locked (amber), Available (gray)
- `WorkspaceRow.svelte` — clickable card-style row showing workspace name/path, branch chip, assigned plan link, status badge, lock command info, optional project name. Accepts `href` and `selected` props; when `href` is set, renders as an `<a>` tag with preload and inner plan links render as plain text to avoid nested anchors
- `ActivePlanRow.svelte` — plan row with plan #, title, goal (truncated), status/priority badges, and relative timestamp
- `src/lib/utils/time.ts` — `formatRelativeTime()` helper for human-readable relative timestamps

### Workspace Detail & Lock/Unlock

The workspace detail view (`/projects/[projectId]/active/workspace/[workspaceId]`) displays full workspace info (name, path, branch, type, assigned plan, description) and lock status with management actions.

- **Query**: `getWorkspaceDetail(db, workspaceId)` in `db_queries.ts` returns a `WorkspaceDetail` type extending `EnrichedWorkspace` with `description`, `createdAt`, and `lockStartedAt` fields
- **Remote commands** (`src/lib/remote/workspace_actions.remote.ts`): `lockWorkspace` and `unlockWorkspace` are `command()` exports. `lockWorkspace` acquires a persistent lock (`lockType: 'persistent'`, `command: 'web: manual lock'`). `unlockWorkspace` force-releases any lock (`force: true`). Both call `invalidateAll()` after mutation to keep the sidebar in sync
- **PID lock safety**: When unlocking a PID-locked workspace, a confirmation dialog warns that a process is actively using the workspace (shows PID, command, hostname) before proceeding with force-release
- **Route validation**: Workspace ID is validated with strict regex (`/^\d+$/`); workspace ownership is checked against the current project (redirects to owning project if mismatched, matching plan detail route behavior)
- **Navigation**: Clicking a workspace row in the sidebar navigates to the detail view; selecting a workspace visually deselects any selected plan and vice versa. Uses `afterNavigate` to reset transient UI state (submitting flags, error messages) when navigating between workspaces

## PR Status

PR status data is fetched and refreshed via remote functions in `src/lib/remote/pr_status.remote.ts`:

### Remote Functions

- **`getPrStatus`** (`query`): Returns cached PR status for the plan from the DB. Response: `{ prUrls: string[], invalidPrUrls: string[], prStatuses: PrStatusDetail[] }`. Non-URL entries and non-PR URLs from the plan's `pull_request` field are returned in `invalidPrUrls` rather than silently dropped.
- **`refreshPrStatus`** (`command`): Syncs `plan_pr` junction links from the plan's `pullRequest` field, then refreshes each PR from GitHub using `Promise.allSettled` for per-PR partial failure tolerance. Handles missing `GITHUB_TOKEN` gracefully (syncs links from cached URLs only). Only accepts PR URLs (not issue URLs), validated by `validatePrIdentifier()`. Returns `{ error?: string }` — the actual data is delivered by calling `getPrStatus({ planUuid }).refresh()` before returning, which causes subscribed clients to re-fetch the query automatically.

### Data Flow

- `EnrichedPlan` (list views) includes `pullRequests: string[]`, `invalidPrUrls: string[]`, `issues: string[]`, and `prSummaryStatus: 'passing' | 'failing' | 'pending' | 'none'` — computed by canonicalizing plan `pull_request` URLs and matching directly against `pr_status.pr_url`, not via `plan_pr` junctions, ensuring cached data is shown even before junction links are populated. `invalidPrUrls` contains non-URL strings and non-PR URLs from the plan's `pull_request` field (categorized via `categorizePrUrls()`).
- `PlanDetail` (detail view) includes `prStatuses: PrStatusDetail[]` with nested check runs, reviews, and labels.
- `PrStatusSection` uses `$derived(await getPrStatus({ planUuid }))` as its primary data source. An `$effect` calls `refreshPrStatus` on mount/plan change, which updates the DB and refreshes the query — the `$derived` expression automatically picks up the new data.

### Components

- **`PrStatusSection.svelte`** — PR detail section rendered inside `PlanDetail`. Takes only `planUuid` as a prop and fetches its own data via the `getPrStatus` query. For each linked PR: title as GitHub link, state badge (open/merged/closed/draft), checks summary badge (passing/failing/pending), review decision, labels as colored chips. Expandable sub-sections for individual check runs and reviews. Renders warning banners for invalid PR entries (non-URL strings, issue URLs). Triggers `refreshPrStatus` command on mount which refreshes data from GitHub and updates the query automatically.
- **`PrCheckRunList.svelte`** — Expandable list of individual CI check runs within a PR. Shows name, status/conclusion with color coding, link to details URL. Handles both CheckRun and StatusContext source types.
- **`PrReviewList.svelte`** — Expandable list of PR reviews. Shows reviewer name, review state (approved/changes requested/commented/pending/dismissed) with appropriate styling.
- **`PrStatusIndicator.svelte`** — Compact colored dot badge for plan list views showing overall PR health. Green = all checks passing, red = any failing, yellow = pending, gray = no status data. Used in `PlanRow.svelte` and `ActivePlanRow.svelte` when `pullRequests.length > 0`. Status derived from `EnrichedPlan.prSummaryStatus`.

## Plan Task Counts

Task completion counts are fetched via a remote query in `src/lib/remote/plan_task_counts.remote.ts`:

- **`getPlanTaskCounts`** (`query`): Returns `{ done, total }` task counts for a plan by UUID. Used by `SessionDetail` to display task progress (e.g. "3/5 completed") in the session header.

## Sessions Tab

The Sessions tab (`/projects/[projectId]/sessions`) provides real-time monitoring of tim agent processes via a WebSocket + SSE architecture.

### Server Infrastructure

The sessions system uses a discovery-based architecture where the web GUI discovers and connects to agent processes:

1. **Agent-side embedded servers**: Each tim long-running command (`agent`, `generate`, `chat`, `review`, `run-prompt`) starts its own embedded WebSocket server via `HeadlessAdapter`. The server broadcasts output messages, supports replay for late-connecting clients, and routes incoming prompt responses and user input. Session discovery is via PID info files in `~/.cache/tim/sessions/`. See the README "Embedded Session Server" section for environment variable configuration.

2. **Session discovery client** (`src/lib/server/session_discovery.ts`): The web interface discovers agent processes by scanning `~/.cache/tim/sessions/` for session info files and connects to each agent's embedded WebSocket server as a client. Uses `fs.watch()` with debounced re-scan (500ms) for real-time discovery of new/removed processes, plus periodic reconciliation polling (30s) for PID liveness checks and stale file cleanup. Handles connection retry with exponential backoff (100ms to 5s) for cases where the PID file appears before the server is ready. Enforces loopback-only connections: non-loopback hostnames in session info files are rejected with a warning (full `127.0.0.0/8` range and `::1` accepted; wildcard binds like `0.0.0.0` and `::` are mapped to `127.0.0.1` and `[::1]` respectively). Processes with `token: true` are skipped (bearer token auth deferred to remote workspace plans). Survives HMR via the session context singleton pattern.

3. **Tim-gui WebSocket server**: The web interface also runs a WebSocket server on port 8123 for the HTTP notification endpoint and future use. Agent processes no longer connect to this server; session discovery is the only live session transport.

- **WebSocket server** (`src/lib/server/ws_server.ts`): Listens on port 8123 (configurable via `TIM_WS_PORT` env var or `headless.url` config). Accepts HTTP POST notifications at `/messages`. It remains in place for notifications and future features, but not for agent session connections. Message parsing uses shared utilities from `src/logging/headless_message_utils.ts`.
- **Session discovery client** (`src/lib/server/session_discovery.ts`): Watches the session directory, manages WebSocket client connections to discovered agent processes, and feeds messages into SessionManager via `handleWebSocketConnect/Message/Disconnect`. Uses the session info file's `sessionId` as the `connectionId` for SessionManager. Session registration is gated on validated `session_info` (sessionId must match PID file); reconnections to existing offline sessions buffer messages until `replay_end` to protect existing session history.
- **Session manager** (`src/lib/server/session_manager.ts`): Central state management singleton. Tracks active/offline/notification sessions, passes structured messages through to the client as-is (category set to `'structured'`), handles replay buffering, prompt tracking, and project resolution from DB. Display category computation (lifecycle, llmOutput, toolUse, etc.) is done client-side via `src/lib/utils/message_formatting.ts`.
- **Session context** (`src/lib/server/session_context.ts`): HMR-safe singleton (uses `Symbol.for`) exposing `getSessionManager()`, `getWsConnections()`, and `getSessionDiscoveryClient()` / `setSessionDiscoveryClient()` for use by SSE and API routes.
- **Server init** (`src/hooks.server.ts`): Starts the WebSocket server and session discovery client on SvelteKit boot via the `init` export.

### Message Processing

- Incoming agent messages follow the headless protocol: `session_info` → `replay_start` → historical messages → `replay_end` → live messages
- **Dynamic session info updates**: The headless adapter can re-send `session_info` after initial handshake (e.g., after workspace switching in `setupWorkspace()`). The server handler is idempotent — it replaces `session.sessionInfo`, recomputes `groupKey` and `projectId`, and emits `session:update`. The web UI re-groups the session automatically via reactive `sessionGroups`.
- Messages during replay (`replay_start`..`replay_end`) are added to the session's message list but NOT emitted as SSE events
- **Replay prompt suppression**: Prompts received during replay are deferred to internal state (`deferredPromptEvent` in `SessionInternals`) rather than stored in `session.activePrompt`. On `replay_end`, any deferred prompt is promoted to the active prompt and emitted. `getSessionSnapshot()` and `cloneSession()` strip `activePrompt` while `isReplaying` is true. `sendPromptResponse()` rejects during replay as a safety guard.
- Each message becomes a `DisplayMessage`. Structured messages are passed through with `body: { type: 'structured', message: StructuredMessagePayload }` and `category: 'structured'`. The client computes display categories and formatting via `src/lib/utils/message_formatting.ts`. Non-structured TunnelMessages (log/error/warn/stdout/stderr) retain server-side formatting into text/monospaced body types with `category: 'log' | 'error'`.
- Debug tunnel messages are suppressed
- `MessageCategory` on the wire is simplified to `'log' | 'error' | 'structured'`. The richer display categories (lifecycle, llmOutput, toolUse, fileChange, command, progress, error, userInput) are computed client-side from the structured message's `type` field via `getDisplayCategory()`.

### Message Limits

- **WS sessions**: Capped at `MAX_SESSION_MESSAGES` (5000). When exceeded, oldest messages are trimmed via `trimSessionMessages()`.
- **Notification sessions**: Capped at 200 messages.
- **SSE snapshots**: `getSessionSnapshot()` caps messages per session at `MAX_SNAPSHOT_MESSAGES` (500) to limit CPU/memory on new SSE client connections. Full message history is still available via incremental SSE events.
- **Notification message IDs**: Use a monotonic per-session counter (`nextNotificationId` in `SessionInternals`) instead of `messages.length + Date.now()`, preventing duplicate IDs after the 200-message cap trims old messages.

### Defensive Message Handling

- `formatTunnelMessage()` wraps structured message processing in try/catch with a fallback text body for malformed payloads, preventing crashes from unexpected agent protocol additions. Validates structured payloads are plain objects with a string `type` before passing through; rejects malformed payloads to a text log fallback.
- `handleStructuredSideEffects()` validates structured payloads before acting on them: `prompt_request` requires `requestId`, `promptConfig`, and valid `choices` (array or absent); `prompt_answered` requires `requestId`. Malformed payloads are silently skipped rather than installing invalid prompt state.
- WebSocket message dispatch in `ws_server.ts` wraps `sessionManager.handleWebSocketMessage()` in try/catch so malformed client frames cannot crash message processing for that socket.
- Client-side `formatStructuredMessage()` in `src/lib/utils/message_formatting.ts` has a default case returning a generic text fallback for unknown structured message types. `SessionMessage.svelte` wraps `formatStructuredMessage()` calls in try/catch for graceful degradation on malformed payloads. `ReviewResultDisplay.svelte` validates input arrays and issue entries independently.
- Browser notifications (`session_notifications.ts`): `extractMessageText()` handles structured message bodies via `formatStructuredMessage()`, so events like `agent_session_end` trigger notifications correctly even though they arrive as structured bodies rather than text.

### Notification Sessions

HTTP POST to `/messages` on port 8123 creates lightweight "notification" sessions (capped at 200 messages). When a WebSocket session later connects with the same group key (normalized gitRemote + workspacePath), the notification session is reconciled into the full session. Remote URLs are normalized via `parseGitRemoteUrl().fullName` to canonicalize equivalent remote formats (HTTPS vs SSH, with/without `.git` suffix) into the same group key.

### SSE Endpoint & API Routes

Browser clients receive real-time updates via SSE and interact with sessions through remote `command()` functions:

- **SSE endpoint** (`src/routes/api/sessions/events/+server.ts`): `GET` returns a `ReadableStream` with SSE headers. On connect, sends `session:list` snapshot, replays any buffered events, then sends `session:sync-complete` to signal that initial state is fully loaded. After sync, streams live events (`session:new`, `session:update`, `session:disconnect`, `session:message`, `session:prompt`, `session:prompt-cleared`, `session:dismissed`). Uses subscribe-before-snapshot pattern with buffering to avoid lost-event race conditions.

#### SSE Implementation Gotchas

- **ReadableStream cancel() must not call controller.close()**: When an SSE client disconnects, the `cancel()` callback fires, but the stream is already being torn down by the consumer. Calling `controller.close()` inside `cancel()` throws. Only use `cancel()` for cleanup (unsubscribing listeners, etc.).
- **Subscribe before snapshot**: If you take the snapshot first and subscribe second, events emitted between those two calls are lost. Subscribe first, buffer events during snapshot delivery, then flush and stream normally.
- **EventEmitter listeners must not throw**: An exception thrown from an EventEmitter listener propagates through `emit()` and aborts delivery to remaining listeners. Always wrap SSE `controller.enqueue()` calls (and any other potentially-failing operations) in try/catch inside listener callbacks.
- **Session actions** (`src/lib/remote/session_actions.remote.ts`): remote `command(...)` functions for session interactions:
  - `sendSessionPromptResponse`: validates `{ connectionId, requestId, value }` and forwards prompt responses. Throws 400 for wrong requestId, 404 for missing session.
  - `sendSessionUserInput`: validates `{ connectionId, content }` and sends free-form text to interactive sessions.
  - `dismissSession`: validates `{ connectionId }` and removes offline/notification sessions.
  - `endSession`: validates `{ connectionId }` and sends an `end_session` message to the agent process. For interactive sessions, this gracefully closes subprocess stdin (equivalent to Ctrl-D); for non-interactive sessions, it sends SIGTERM. Throws 404 for missing session.
  - `dismissInactiveSessions`: bulk-dismisses all inactive sessions, returns `{ dismissed: number }`.
  - `activateSessionTerminalPane`: resolves the WezTerm pane from session metadata, switches to the pane's workspace, activates the pane, and brings WezTerm to the foreground on macOS.
  - `openTerminal`: opens a new terminal window in the specified directory. Reads `terminalApp` from config (defaults to WezTerm). Uses `wezterm start --cwd` for WezTerm or `open -a <app>` for other macOS terminal apps. macOS only.
- **Shared helpers** (`src/lib/server/session_routes.ts`): `formatSseEvent()`, `createSessionEventsResponse()` used by the SSE endpoint.

### Key Design Decisions

- Each WebSocket connection creates a new session (no reconnection merging)
- Port 8123 conflicts with macOS tim-gui — only one should run at a time
- Vite HMR may restart the discovery client during dev; it reconnects to discovered agents on restart
- SSE subscribes before taking snapshot to avoid lost-event race window, with event buffering during snapshot delivery
- `sendPromptResponse` validates requestId against activePrompt and clears prompt on success — prevents duplicate responses from multiple browser tabs
- SSE enqueue calls are wrapped in try/catch for resilience against closed streams
- **Shutdown**: `hooks.server.ts` registers SIGTERM/SIGINT handlers that call `serverHandle.stop()` then `process.exit(0)` for clean production shutdown. HMR-safe cleanup uses `Symbol.for` singleton pattern. Custom signal handlers suppress default Node.js termination, so explicit `process.exit()` is required.

### Client-Side Session Store

`src/lib/stores/session_state.svelte.ts` is a Svelte 5 runes-based reactive store managing all session state:

- **SSE connection**: Established from root `+layout.svelte` so it stays open across all tab switches. Auto-reconnects on disconnect.
- **SSE event handling**: Event application logic is extracted into `src/lib/stores/session_state_events.ts` as pure functions for testability without Svelte runtime. Uses `push()` instead of spread for O(1) message append.
- **Session grouping utilities**: `getSessionGroupKey()` and `getSessionGroupLabel()` are extracted into `src/lib/stores/session_group_utils.ts` as a plain TypeScript module (no Svelte/remote-action dependencies) for testability. Re-exported from `session_state.svelte.ts` for backward compatibility.
- **Client-side message cap**: `MAX_CLIENT_MESSAGES` (5000) mirrors the server-side cap to prevent unbounded browser memory growth. Messages are trimmed after push.
- **Initialization tracking**: The `initialized` flag is set to `true` only when the `session:sync-complete` event is received, indicating that the snapshot and all buffered catch-up events have been processed. It resets to `false` on SSE reconnect. Pages that need to distinguish "not yet loaded" from "not found" should gate on this flag.
- **State**: `sessions` (SvelteMap for reactivity), `selectedSessionId`, `lastSelectedSessionIds` (SvelteMap keyed by route projectId — remembers last-viewed session per project), `connectionStatus` (connected/reconnecting/disconnected), `initialized`
- **Derived**: `sessionGroups` — sessions grouped by `groupKey`, with the current project's group sorted to top. Group labels resolved from project display name (when `projectId` matches a known project) or workspace path (last 2 components).
- **Actions**: `sendPromptResponse(connectionId, requestId, value)`, `sendUserInput(connectionId, content)`, `dismissSession(connectionId)`, `endSession(connectionId)` — all call remote `command()` functions from `src/lib/remote/session_actions.remote.ts`. `activateTerminalPane(session)` and `openTerminalInDirectory(directory)` also call remote commands from the same module.
- **SvelteMap reactivity**: SvelteMap only tracks `.set()`/`.delete()`/`.clear()` — after mutating nested properties on stored objects, the entry must be re-set to trigger reactivity.
- **Per-project session memory**: `lastSelectedSessionIds` tracks the last-viewed session per project route. When the user navigates away from a session detail and returns to the Sessions tab, the empty-state page (`sessions/+page.svelte`) redirects to the remembered session if it still exists. Uses `replaceState: true` to avoid back-button loops. On session dismissal or SSE reconnect, falls back to the most recently connected remaining session via `findMostRecentSessionId()`. Stale entries (sessions no longer in the sessions map) are pruned during fallback.

### UI Components

- **`SessionList.svelte`** — Grouped session sidebar (left pane, w-96). Groups are collapsible by project. Shows all sessions regardless of selected project.
- **`SessionRow.svelte`** — Individual session entry with status indicator dot (green=active, gray=offline, blue=notification), command name, plan title/ID, dismiss button for offline/notification sessions, a terminal icon when the session includes WezTerm pane metadata, and an "Open Terminal" button (AppWindow icon) that opens a new terminal window in the session's workspace directory (visible on hover when `workspacePath` exists).
- **`SessionDetail.svelte`** — Message transcript view with session header (command, plan, workspace, status), optional terminal activation button for WezTerm-backed sessions, "Open Terminal" button (AppWindow icon, always visible when `workspacePath` exists) that opens a new terminal in the workspace directory, End Session button with inline confirmation for active sessions, export buttons (copy to clipboard, download as markdown), scrollable message list, fixed-position prompt area above messages, conditional message input bar. Plan title in the header is a clickable link to the plan detail page. When the plan has tasks, shows task completion counts (X/Y done) fetched via the `getPlanTaskCounts` remote query. Uses `{#key connectionId}` for remount on session switch. Auto-scroll is scroll-position-based: active when at bottom, disabled when user scrolls up, resumes on scroll to bottom.
- **`SessionMessage.svelte`** — Renders messages by body type: text (colored by category), monospaced (preformatted code blocks), todoList (items with status icons), fileChanges (paths with +/~/- indicators), keyValuePairs (structured metadata table), structured (raw structured message data formatted client-side via `formatStructuredMessage()`, with dedicated components for specific types like `ReviewResultDisplay`). Long content truncated with expandable reveal.
- **`PromptRenderer.svelte`** — Renders by prompt type: confirm (Yes/No buttons with default highlighted), input (text field with submit), select (radio group), checkbox (checkbox group), prefix_select (clickable word segments for bash command prefix authorization — selected words highlighted in accent color, remaining dimmed; "Submit Prefix" and "Allow Exact Command" buttons). Uses `{#key requestId}` for state reset. Shows header/question fields from promptConfig when present. Falls back to raw JSON display for unsupported types.
- **`MessageInput.svelte`** — Text input with Enter to send, Shift+Enter for newlines. Hidden (not disabled) when session is offline or non-interactive.
- **Category colors** (`src/lib/utils/session_colors.ts`): Maps `DisplayCategory` values to Tailwind color classes — lifecycle=green, llmOutput=green, toolUse=cyan, fileChange=cyan, command=cyan, progress=blue, error=red, log=gray, userInput=orange. For structured messages, the display category is computed client-side via `getDisplayCategory()` from `src/lib/utils/message_formatting.ts`.

### Session Export

Session transcripts can be exported as markdown via two buttons in the `SessionDetail` header (ClipboardCopy and Download icons from lucide-svelte). Both buttons are disabled when the session has no messages.

- **Copy to clipboard**: Calls `exportSessionAsMarkdown()`, writes to clipboard via `navigator.clipboard.writeText()`, shows toast confirmation.
- **Download as file**: Calls `exportSessionAsMarkdown()`, creates a Blob download with filename from `generateExportFilename()` (format: `session-{command}-{planId}-{timestamp}.md`).

Export utilities live in `src/lib/utils/session_export.ts`:

- **`formatMessageAsMarkdown(message)`**: Converts a `DisplayMessage` to markdown. Resolves structured messages via `formatStructuredMessage()`. Handles all body types: text as-is, monospaced in fenced code blocks (dynamic fence length via `computeFence()` to handle content containing backticks), todoList as markdown checkboxes, fileChanges as bullet list with diff markers, keyValuePairs as bold-key lines (multiline values in fenced code blocks), review_result with verdict/issues/recommendations/action items.
- **`formatSessionHeader(session)`**: Markdown header with command, plan, workspace, git remote, and timestamps (UTC). Only includes fields that have values.
- **`exportSessionAsMarkdown(session)`**: Composes header + all messages.
- **`generateExportFilename(session)`**: Filesystem-safe filename with sanitized command and planId.

## Keyboard Navigation

All three tabs (Sessions, Plans, Active Work) support **Alt+ArrowDown** / **Alt+ArrowUp** (Option+Down/Up on macOS) to navigate to the next/previous item in the list. The shortcut fires regardless of focus state, including when in text inputs.

### Behavior

- Navigation respects collapsed groups and active filters — only visible items are navigable
- When no item is selected, Alt+Down selects the first visible item; Alt+Up selects the last
- At list boundaries, the shortcut does nothing (no wrap)
- The navigated-to item is scrolled into view via `scrollIntoView({ block: 'nearest' })`
- Events with Ctrl, Meta, or Shift modifiers are ignored to avoid shortcut conflicts

### Implementation

Each list component (`SessionList.svelte`, `PlansList.svelte`, active work `+layout.svelte`) adds its own `<svelte:window onkeydown>` handler. Since only one tab is mounted at a time, there's no conflict. Shared logic lives in `src/lib/utils/keyboard_nav.ts`:

- **`isListNavEvent(event)`** — Returns `'up'` or `'down'` for Alt+Arrow events, `null` otherwise
- **`getAdjacentItem(items, currentId, direction)`** — Computes the adjacent item ID with boundary clamping
- **`scrollListItemIntoView(itemId)`** — Finds `[data-list-item-id]` element and scrolls it into view

Row components (`SessionRow`, `PlanRow`, `ActivePlanRow`) have `data-list-item-id` attributes for scroll targeting.

### Global Keyboard Shortcuts

The root layout (`+layout.svelte`) registers a `<svelte:window onkeydown>` handler for global keyboard shortcuts:

| Shortcut   | Action                                  | Context                                                                                |
| ---------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| **Ctrl+/** | Focus the search input on the Plans tab | Suppressed when focus is in a text input, textarea, select, or contenteditable element |
| **Ctrl+1** | Navigate to Sessions tab                | Always active, even in text inputs                                                     |
| **Ctrl+2** | Navigate to Active Work tab             | Always active                                                                          |
| **Ctrl+3** | Navigate to Plans tab                   | Always active                                                                          |

Tab navigation uses `goto()` with `projectUrl()` to build the correct route for the current project context.

The shortcut logic lives in `src/lib/utils/keyboard_shortcuts.ts`:

- **`isTypingTarget(event)`** — Returns `true` if the event target is an `<input>`, `<textarea>`, `<select>`, or `[contenteditable]` element
- **`handleGlobalShortcuts(event, callbacks)`** — Matches key combinations using `event.code` (physical key codes like `Slash`, `Digit1`) for locale independence, and calls the appropriate callback

The search input in `PlansList.svelte` has a `data-search-input` attribute for targeting by the Ctrl+/ shortcut.

## Accessibility (ARIA)

Components use ARIA attributes to support screen readers and assistive technology:

- **`PrStatusIndicator`**: The colored dot has `role="img"` and `aria-label` set to the status description (e.g. "PR checks passing") so screen readers announce status without relying on color alone.
- **`FilterChips`**: Toggle buttons use `aria-pressed` to communicate active/inactive filter state.
- **`SessionList` / `PlansList`**: Group collapse buttons have `aria-expanded` and descriptive `aria-label` (e.g. "Toggle Running group"). Decorative triangle indicators use `aria-hidden="true"`. The plans search input has `aria-label="Search plans"`.
- **`TabNav`**: The `<nav>` element has `aria-label="Main navigation"`. Active tab links use `aria-current="page"`.
- **`ProjectSidebar`**: The `<nav>` element has `aria-label="Project navigation"`. Selected project links use `aria-current="page"`.
- **`SessionDetail`**: The header status dot has `role="img"` and `aria-label` set to the status text.
- **`MessageInput`**: The textarea has `aria-label="Send input to session"`.
- **`PrStatusSection`**: The icon-only refresh button has a dynamic `aria-label` that reflects the current state ("Refreshing PR status..." while loading, "Refresh PR status" otherwise).
- **Skip-to-content link**: The root layout (`+layout.svelte`) includes a visually-hidden skip link as the first child, targeting `id="main-content"` on the content wrapper in the project layout (`projects/[projectId]/+layout.svelte`). Uses `sr-only focus:not-sr-only` Tailwind classes so it appears only on focus. The target element has `tabindex="-1"` for programmatic focusability.
- **End-session confirmation** (`SessionDetail`): The inline confirmation bar has `role="alertdialog"` and `aria-label="Confirm end session"`. When opened, focus moves to the confirm button via `$effect` + `tick()`. Pressing Escape cancels the confirmation. On cancel, focus returns to the original "End Session" trigger button.

### Guidelines for new components

- Icon-only buttons must have `aria-label`.
- Color-only indicators need `role="img"` and `aria-label` (or a `sr-only` text span).
- Toggle buttons should use `aria-pressed`.
- Collapse/expand controls should use `aria-expanded`.
- Navigation landmarks (`<nav>`) should have `aria-label` to distinguish them. Active links use `aria-current="page"`.
- Inline confirmation dialogs should use `role="alertdialog"`, move focus to the confirm button on open (via `$effect` + `tick()`), handle Escape to cancel, and return focus to the trigger element on dismissal.

## Plan Actions

The plan detail view supports triggering CLI commands directly from the web UI. Three actions are available:

### Open Terminal Button (`PlanDetail.svelte`)

An "Open Terminal" button (AppWindow icon) appears next to each workspace path in the "Assigned Workspace" section. Clicking it opens a new terminal window in that workspace directory via the `openTerminal` remote command. All workspace terminal buttons are disabled while any launch is in progress. Error feedback is shown via toast notifications.

- **Generate**: For stub plans (no tasks) — spawns `tim generate` to flesh out the plan
- **Run Agent**: For plans with incomplete tasks — spawns `tim agent` to execute the plan
- **Chat**: For any plan regardless of status — spawns `tim chat` with an executor selection dialog

### Eligibility

- **Generate** (`isPlanEligibleForGenerate`): Plan has no tasks and `displayStatus` is not `done`, `cancelled`, `deferred`, or `recently_done`.
- **Agent** (`isPlanEligibleForAgent`): Plan is not `done`, `cancelled`, or `deferred`. If the plan has tasks, at least one must be incomplete (not all done). Plans without tasks are also eligible (simple/stub plans).
- **Chat** (`isPlanEligibleForChat`): Any existing plan is eligible, including plans in terminal statuses (done, cancelled, deferred).

### Executor Selection Dialog

When launching a Chat session, a dialog opens to choose the executor:

- **Claude** (claude_code executor) — blue themed button
- **Codex** (codex_cli executor) — green themed button

The dialog stays open with per-button spinners during launch. Dismissal is prevented while a launch is in flight.

### Button States

- **Hidden**: Plan is ineligible for any action
- **Generate / Run Agent / Chat**: Eligible, no active session → clickable
- **Running...**: Active session exists for this plan (any command) → links to the session. Chat sessions use violet theming, generate uses blue, agent uses green.
- **Starting**: Remote command call in flight → disabled with spinner
- **Error**: Spawn failed → error message shown briefly

### Button Layout by Plan State

- **No tasks (stub plan, non-terminal)**: Generate is primary button; dropdown contains "Run Agent" and "Chat"
- **Incomplete tasks (non-terminal)**: Run Agent is primary button; dropdown contains "Chat"
- **All tasks complete OR terminal status**: Standalone "Chat" button (violet themed)

**Duplicate prevention**: Both actions share command-agnostic duplicate detection — only one plan-scoped session (generate, agent, chat, review, or any other command publishing a `planUuid` in session info) can be active per plan at a time. All identity checks use the plan UUID (not numeric planId) for cross-project safety. Three layers of protection:

1. **Client-side session check**: Session store filters for any active session with a matching `planUuid` for immediate UI feedback.
2. **Server-side session check**: `SessionManager.hasActiveSessionForPlan(planUuid)` (no command filter) rejects launches when a session is already active.
3. **Launch lock** (`src/lib/server/launch_lock.ts`): After a successful spawn, a per-plan lock (keyed by UUID) prevents duplicate launches in the gap before the spawned process connects via WebSocket and registers as a session. The lock is cleared when `session:update` fires with the plan's UUID, or after a 30-second timeout fallback. Lock state is stored on `globalThis` via `Symbol.for()` for HMR safety. On the client side, `startedSuccessfully` state keeps the action button disabled until an active session appears (also with a 30-second fallback timeout).

### Server-Side Infrastructure

- **Remote commands** (`src/lib/remote/plan_actions.remote.ts`): `startGenerate`, `startAgent`, and `startChat` are thin wrappers around `launchTimCommand()`, a shared helper that validates plan eligibility, checks for duplicate sessions (command-agnostic via UUID), resolves the primary workspace path, and calls the spawn handler. All follow the same `command()` pattern as `session_actions.remote.ts`. `startChat` accepts an `executor` field (`'claude' | 'codex'`) which is passed through to the spawn function.
- **Spawn handler** (`src/lib/server/plan_actions.ts`): `spawnTimProcess()` (internal) uses `Bun.spawn` with `{ detached: true }` to create a process that survives web server restarts (including HMR). Pipes stderr for ~500ms to detect early failures, then calls `.unref()`. Public wrappers `spawnGenerateProcess()`, `spawnAgentProcess()`, and `spawnChatProcess()` pass the appropriate CLI args. `spawnChatProcess` takes an additional `executor` parameter and uses `--plan <id>` (named option) rather than a positional argument. The spawned process starts an embedded WebSocket server and writes a session info file; the discovery client detects and connects to it, making it appear as a new session.
- **Session lookup** (`SessionManager.hasActiveSessionForPlan(planUuid, command?)`): Checks whether an active session exists for a given plan UUID. The `command` parameter is optional — when omitted, matches any active session regardless of command type. Used without a command filter for duplicate prevention across all plan-scoped commands.
- **Launch lock** (`src/lib/server/launch_lock.ts`): In-memory per-plan lock (keyed by UUID, stored on `globalThis` for HMR safety) bridging the gap between process spawn and WebSocket session registration. Exported as a separate module because SvelteKit remote function files can only export `command()` results. Subscribes to `SessionManager.subscribe('session:update')` to clear locks when sessions register.
- **Primary workspace query** (`getPrimaryWorkspacePath()` in `db_queries.ts`): Resolves the primary workspace path for a project, used as the cwd for spawned processes.

## Dark Mode

The web interface supports light, dark, and system-preference color modes using the `mode-watcher` package.

### How It Works

- `ModeWatcher` component in `src/routes/+layout.svelte` manages the `.dark` class on `<html>`, persists the user's preference to localStorage, and injects a `<head>` script to prevent FOUC (flash of unstyled content) on page load.
- CSS variables for dark mode are defined in `src/routes/layout.css` under the `.dark` class (lines 42-74). The Tailwind `@custom-variant dark (&:is(.dark *))` directive enables `dark:` utility classes.
- A cycling toggle button in the header (right of TabNav) switches between light → dark → system modes using Sun/Moon/Monitor icons from `@lucide/svelte`. Uses `setMode()` and `userPrefersMode` from `mode-watcher`.
- The `themeColors` prop on `ModeWatcher` dynamically updates the `<meta name="theme-color">` tag to match the current mode. A static fallback meta tag in `src/app.html` covers the pre-JS state.

### Color Strategy

A hybrid approach is used for dark mode colors:

- **Semantic tokens** (`bg-background`, `text-foreground`, `text-muted-foreground`, `border-border`) where they map well to existing CSS variables
- **`dark:` variant classes** for colored states that don't have semantic equivalents (badges, selected states, hover effects) — e.g., `bg-blue-100 dark:bg-blue-900/30`
- **shadcn/ui components** (`src/lib/components/ui/`) already include `dark:` variants and need no changes
- **Session message area** (SessionMessage, PromptRenderer, MessageInput) is always rendered on a dark background (`bg-gray-900`) and doesn't use `dark:` variants

### When Modifying Components

- Use semantic tokens over hardcoded grays where possible
- For colored badges/pills, follow the existing `bg-{color}-100 text-{color}-800 dark:bg-{color}-900/30 dark:text-{color}-300` pattern
- Ensure sufficient contrast in dark mode — `text-gray-400` is the minimum for readable secondary text on `bg-gray-900` (avoid `text-gray-600` which has ~2.35:1 contrast ratio)

## PWA Support

The web interface is installable as a Progressive Web App, allowing it to run as a standalone desktop/mobile app without browser chrome.

### Key Files

- `static/manifest.webmanifest` — App metadata (name, icons, display mode, theme color). Uses relative URLs and `start_url: "."` for base-path compatibility.
- `src/service-worker.ts` — SvelteKit built-in service worker using `$service-worker` module (`build`, `files`, `version`)
- `src/app.html` — PWA meta tags (manifest link, theme-color, apple-mobile-web-app-capable, apple-touch-icon). Uses `%sveltekit.assets%` for base-path safety.
- `src/routes/+layout.svelte` — Service worker registration in `onMount`, badge effect reacting to `sessionManager.needsAttention`
- `src/lib/utils/pwa_badge.ts` — Feature-detecting wrappers for `navigator.setAppBadge()` / `navigator.clearAppBadge()`
- `static/icon-192.png`, `static/icon-512.png`, `static/favicon.png` — App icons (sourced from tim-gui macOS app)

### Service Worker Caching Strategy

- **Static assets** (`build` + `files` arrays from `$service-worker`): Cache-first with versioned cache name (`cache-${version}`). These include hashed JS/CSS bundles and static directory contents.
- **API routes** (`/api/`): Network-only — never cached. SSE streams and REST endpoints must always hit the server.
- **Everything else** (navigation, external): Not intercepted — browser handles normally.

### Update Behavior

- Install event calls `self.skipWaiting()` for immediate activation of new versions
- Activate event deletes old versioned caches and calls `clients.claim()`
- Root layout listens for `controllerchange` and calls `location.reload()` to pick up new assets
- First-visit guard: `controllerchange` reload is skipped when `navigator.serviceWorker.controller` is null (first service worker install), avoiding an unnecessary reload

### App Badge (Attention Indicator)

When installed as a PWA, the app icon displays a badge dot whenever any session needs user attention. This uses the Badging API (`navigator.setAppBadge()` / `navigator.clearAppBadge()`).

- **Badge shown**: At least one session has `activePrompt !== null` (waiting for user input) or `status === 'notification'` (unhandled notification)
- **Badge cleared**: No sessions need attention
- `SessionManager.needsAttention` is a `$derived` property that reactively computes attention state across all sessions
- A `$effect` in the root layout calls the badge API whenever `needsAttention` changes
- Feature-detected and silently no-ops when the Badge API is unavailable (non-PWA context, unsupported browser)

### Key Behaviors

- **Workspace `plan_id` is project-scoped, not globally unique.** Any lookup from a workspace's `plan_id` (text plan number) to a plan UUID must include the project ID to avoid collisions across projects. The "All Projects" mode is the most visible case — workspace plan links use a `planNumberToUuid` map keyed by `${projectId}:${planId}`.
- "Recently Active" toggle defaults to filtered; toggle state is `$state` that persists across project switches (not wrapped in `{#key}`)
- Plan detail sub-route reuses `PlanDetail` component; `getPlanDetailRouteData()` accepts a `tab` parameter for cross-project redirect URLs
- Dependency/parent links in PlanDetail point to the Plans tab (not Active Work) since dependencies can be any status
