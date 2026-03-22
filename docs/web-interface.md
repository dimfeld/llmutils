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
├── +page.svelte            # Empty state: "Select a plan to view details"
└── [planId]/
    ├── +page.server.ts     # Loads plan detail via getPlanDetailRouteData(tab: 'plans')
    └── +page.svelte        # Renders PlanDetail component
```

### Data Flow

- `getWorkspacesForProject(db, projectId?)` in `db_queries.ts` — LEFT JOINs `workspace` with `workspace_lock`, calls `cleanStaleLocks(db)` first, returns `EnrichedWorkspace[]` with `isRecentlyActive` computed flag
- `getActiveWorkData(db, projectId)` in `plans_browser.ts` — combines workspace data with plans filtered to `displayStatus === 'in_progress' || 'blocked'`
- "Recently active" criteria: workspace is locked, is primary, is auto, or has `updated_at` within 48 hours (`RECENTLY_ACTIVE_WINDOW_MS`)

### Components

- `WorkspaceBadge.svelte` — pill badge for workspace status: Primary (blue), Auto (green), Locked (amber), Available (gray)
- `WorkspaceRow.svelte` — card-style row showing workspace name/path, branch chip, assigned plan link, status badge, lock command info, optional project name
- `ActivePlanRow.svelte` — plan row with plan #, title, goal (truncated), status/priority badges, and relative timestamp
- `src/lib/utils/time.ts` — `formatRelativeTime()` helper for human-readable relative timestamps

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

## Sessions Tab

The Sessions tab (`/projects/[projectId]/sessions`) provides real-time monitoring of tim agent processes via a WebSocket + SSE architecture.

### Server Infrastructure

The sessions system runs a separate Bun.serve() WebSocket server alongside the SvelteKit dev server:

- **WebSocket server** (`src/lib/server/ws_server.ts`): Listens on port 8123 (configurable via `TIM_WS_PORT` env var or `headless.url` config). Accepts agent WebSocket connections at `/tim-agent` and HTTP POST notifications at `/messages`.
- **Session manager** (`src/lib/server/session_manager.ts`): Central state management singleton. Tracks active/offline/notification sessions, categorizes all 29 StructuredMessage types into display categories (lifecycle, llmOutput, toolUse, fileChange, command, progress, error, log, userInput), handles replay buffering, prompt tracking, and project resolution from DB.
- **Session context** (`src/lib/server/session_context.ts`): HMR-safe singleton (uses `Symbol.for`) exposing `getSessionManager()` and `getWsConnections()` for use by SSE and API routes.
- **Server init** (`src/hooks.server.ts`): Starts the WebSocket server on SvelteKit boot via the `init` export.

### Message Processing

- Incoming agent messages follow the headless protocol: `session_info` → `replay_start` → historical messages → `replay_end` → live messages
- **Dynamic session info updates**: The headless adapter can re-send `session_info` after initial handshake (e.g., after workspace switching in `setupWorkspace()`). The server handler is idempotent — it replaces `session.sessionInfo`, recomputes `groupKey` and `projectId`, and emits `session:update`. The web UI re-groups the session automatically via reactive `sessionGroups`.
- Messages during replay (`replay_start`..`replay_end`) are added to the session's message list but NOT emitted as SSE events
- **Replay prompt suppression**: Prompts received during replay are deferred to internal state (`deferredPromptEvent` in `SessionInternals`) rather than stored in `session.activePrompt`. On `replay_end`, any deferred prompt is promoted to the active prompt and emitted. `getSessionSnapshot()` and `cloneSession()` strip `activePrompt` while `isReplaying` is true. `sendPromptResponse()` rejects during replay as a safety guard.
- Each message is categorized into a `DisplayMessage` with category-based color coding, body type (text/monospaced/todoList/fileChanges/keyValuePairs), and the original structured type
- Debug tunnel messages are suppressed; `token_usage` and `llm_status` render as compact single-line summaries
- Non-structured TunnelMessages (log/error/warn/stdout/stderr) have args joined by spaces

### Message Limits

- **WS sessions**: Capped at `MAX_SESSION_MESSAGES` (5000). When exceeded, oldest messages are trimmed via `trimSessionMessages()`.
- **Notification sessions**: Capped at 200 messages.
- **SSE snapshots**: `getSessionSnapshot()` caps messages per session at `MAX_SNAPSHOT_MESSAGES` (500) to limit CPU/memory on new SSE client connections. Full message history is still available via incremental SSE events.
- **Notification message IDs**: Use a monotonic per-session counter (`nextNotificationId` in `SessionInternals`) instead of `messages.length + Date.now()`, preventing duplicate IDs after the 200-message cap trims old messages.

### Defensive Message Handling

- `summarizeStructuredMessage()` has a default case returning a generic fallback for unknown structured message types, preventing crashes from unexpected agent protocol additions.
- `handleStructuredSideEffects()` is guarded against missing nested message data.
- WebSocket message dispatch in `ws_server.ts` wraps `sessionManager.handleWebSocketMessage()` in try/catch so malformed client frames cannot crash message processing for that socket.

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
- **Shared helpers** (`src/lib/server/session_routes.ts`): `formatSseEvent()`, `createSessionEventsResponse()` used by the SSE endpoint.

### Key Design Decisions

- Each WebSocket connection creates a new session (no reconnection merging)
- Port 8123 conflicts with macOS tim-gui — only one should run at a time
- Vite HMR may restart the WS server during dev; agents auto-reconnect within 5 seconds
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
- **State**: `sessions` (SvelteMap for reactivity), `selectedSessionId`, `connectionStatus` (connected/reconnecting/disconnected), `initialized`
- **Derived**: `sessionGroups` — sessions grouped by `groupKey`, with the current project's group sorted to top. Group labels resolved from project display name (when `projectId` matches a known project) or workspace path (last 2 components).
- **Actions**: `sendPromptResponse(connectionId, requestId, value)`, `sendUserInput(connectionId, content)`, `dismissSession(connectionId)`, `endSession(connectionId)` — all call remote `command()` functions from `src/lib/remote/session_actions.remote.ts`. `activateTerminalPane(session)` also calls a remote command from the same module.
- **SvelteMap reactivity**: SvelteMap only tracks `.set()`/`.delete()`/`.clear()` — after mutating nested properties on stored objects, the entry must be re-set to trigger reactivity.

### UI Components

- **`SessionList.svelte`** — Grouped session sidebar (left pane, w-96). Groups are collapsible by project. Shows all sessions regardless of selected project.
- **`SessionRow.svelte`** — Individual session entry with status indicator dot (green=active, gray=offline, blue=notification), command name, plan title/ID, dismiss button for offline/notification sessions, and a terminal icon when the session includes WezTerm pane metadata.
- **`SessionDetail.svelte`** — Message transcript view with session header (command, plan, workspace, status), optional terminal activation button for WezTerm-backed sessions, End Session button with inline confirmation for active sessions, scrollable message list, fixed-position prompt area above messages, conditional message input bar. Uses `{#key connectionId}` for remount on session switch. Auto-scroll is scroll-position-based: active when at bottom, disabled when user scrolls up, resumes on scroll to bottom.
- **`SessionMessage.svelte`** — Renders messages by body type: text (colored by category), monospaced (preformatted code blocks), todoList (items with status icons), fileChanges (paths with +/~/- indicators), keyValuePairs (structured metadata table). Long content truncated with expandable reveal.
- **`PromptRenderer.svelte`** — Renders by prompt type: confirm (Yes/No buttons with default highlighted), input (text field with submit), select (radio group), checkbox (checkbox group), prefix_select (clickable word segments for bash command prefix authorization — selected words highlighted in accent color, remaining dimmed; "Submit Prefix" and "Allow Exact Command" buttons). Uses `{#key requestId}` for state reset. Shows header/question fields from promptConfig when present. Falls back to raw JSON display for unsupported types.
- **`MessageInput.svelte`** — Text input with Enter to send, Shift+Enter for newlines. Hidden (not disabled) when session is offline or non-interactive.
- **Category colors** (`src/lib/utils/session_colors.ts`): lifecycle=green, llmOutput=green, toolUse=cyan, fileChange=cyan, command=cyan, progress=blue, error=red, log=gray, userInput=orange.

## Plan Actions

The plan detail view supports triggering CLI commands directly from the web UI. Two actions are available:

- **Generate**: For stub plans (no tasks) — spawns `tim generate` to flesh out the plan
- **Run Agent**: For plans with incomplete tasks — spawns `tim agent` to execute the plan

### Eligibility

- **Generate** (`isPlanEligibleForGenerate`): Plan has no tasks and `displayStatus` is not `done`, `cancelled`, `deferred`, or `recently_done`.
- **Agent** (`isPlanEligibleForAgent`): Plan is not `done`, `cancelled`, or `deferred`. If the plan has tasks, at least one must be incomplete (not all done). Plans without tasks are also eligible (simple/stub plans).

### Button States

- **Hidden**: Plan is ineligible for any action
- **Generate / Run Agent**: Eligible, no active session → clickable
- **Running...**: Active session exists for this plan (any command) → links to the session
- **Starting**: Remote command call in flight → disabled with spinner
- **Error**: Spawn failed → error message shown briefly

**Duplicate prevention**: Both actions share command-agnostic duplicate detection — only one plan-scoped session (generate, agent, chat, review, or any other command publishing a `planUuid` in session info) can be active per plan at a time. All identity checks use the plan UUID (not numeric planId) for cross-project safety. Three layers of protection:

1. **Client-side session check**: Session store filters for any active session with a matching `planUuid` for immediate UI feedback.
2. **Server-side session check**: `SessionManager.hasActiveSessionForPlan(planUuid)` (no command filter) rejects launches when a session is already active.
3. **Launch lock** (`src/lib/server/launch_lock.ts`): After a successful spawn, a per-plan lock (keyed by UUID) prevents duplicate launches in the gap before the spawned process connects via WebSocket and registers as a session. The lock is cleared when `session:update` fires with the plan's UUID, or after a 30-second timeout fallback. Lock state is stored on `globalThis` via `Symbol.for()` for HMR safety. On the client side, `startedSuccessfully` state keeps the action button disabled until an active session appears (also with a 30-second fallback timeout).

### Server-Side Infrastructure

- **Remote commands** (`src/lib/remote/plan_actions.remote.ts`): `startGenerate` and `startAgent` are thin wrappers around `launchTimCommand()`, a shared helper that validates plan eligibility, checks for duplicate sessions (command-agnostic via UUID), resolves the primary workspace path, and calls the spawn handler. Both follow the same `command()` pattern as `session_actions.remote.ts`.
- **Spawn handler** (`src/lib/server/plan_actions.ts`): `spawnTimProcess()` (internal) uses `Bun.spawn` with `{ detached: true }` to create a process that survives web server restarts (including HMR). Pipes stderr for ~500ms to detect early failures, then calls `.unref()`. Public wrappers `spawnGenerateProcess()` and `spawnAgentProcess()` pass the appropriate CLI args. The spawned process connects back to the web server via HeadlessAdapter WebSocket and appears as a new session.
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
