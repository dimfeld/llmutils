# Web Interface (Plans Browser)

## SvelteKit Conventions

### Data Loading

- Child layouts should use `await parent()` to access data already loaded by parent layouts instead of re-querying the database. This avoids duplicate work and keeps data consistent.
- All DB imports must be in `$lib/server/` or `+page.server.ts` files — `bun:sqlite` cannot be imported client-side.
- The server context (`src/lib/server/init.ts`) is lazily initialized because SvelteKit may import server modules during `svelte-kit sync` or type checking without a running server.

### Reactivity Gotchas (Svelte 5)

- `$derived(() => { ... })` wraps the **function object itself**, not the return value. For multi-statement derivations, use `$derived.by(() => { ... })`.
- SvelteKit **reuses page components** across param-only navigations — local `$state` persists across route changes. Use `afterNavigate` to reset `$state` when needed, though best is to use a "writable derived" when possible.
- Setting a reactive variable that controls a `disabled` attribute doesn't immediately update the DOM. You must `await tick()` before interacting with the element if the interaction depends on the updated DOM state (e.g., focusing a previously-disabled textarea after setting `sending = false`).

### Routing Gotchas

- SvelteKit's `resolve()` from `$app/paths` enforces typed route parameters — it won't accept dynamic/computed path segments. Use `base` from `$app/paths` + template literals for dynamic paths (e.g., `` `${base}/api/sessions/${encodeURIComponent(id)}/respond` ``).

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

Browser clients receive real-time updates via SSE and interact with sessions through REST endpoints plus a remote command:

- **SSE endpoint** (`src/routes/api/sessions/events/+server.ts`): `GET` returns a `ReadableStream` with SSE headers. On connect, sends `session:list` snapshot, replays any buffered events, then sends `session:sync-complete` to signal that initial state is fully loaded. After sync, streams live events (`session:new`, `session:update`, `session:disconnect`, `session:message`, `session:prompt`, `session:prompt-cleared`, `session:dismissed`). Uses subscribe-before-snapshot pattern with buffering to avoid lost-event race conditions.

#### SSE Implementation Gotchas

- **ReadableStream cancel() must not call controller.close()**: When an SSE client disconnects, the `cancel()` callback fires, but the stream is already being torn down by the consumer. Calling `controller.close()` inside `cancel()` throws. Only use `cancel()` for cleanup (unsubscribing listeners, etc.).
- **Subscribe before snapshot**: If you take the snapshot first and subscribe second, events emitted between those two calls are lost. Subscribe first, buffer events during snapshot delivery, then flush and stream normally.
- **EventEmitter listeners must not throw**: An exception thrown from an EventEmitter listener propagates through `emit()` and aborts delivery to remaining listeners. Always wrap SSE `controller.enqueue()` calls (and any other potentially-failing operations) in try/catch inside listener callbacks.
- **Prompt response** (`src/routes/api/sessions/[connectionId]/respond/+server.ts`): `POST` with `{ requestId, value }`. Validates `requestId` against the session's active prompt and requires `value` field. Returns `'sent'`, `'no_session'`, or `'no_prompt'`.
- **User input** (`src/routes/api/sessions/[connectionId]/input/+server.ts`): `POST` with `{ content }`. Sends free-form text to interactive sessions.
- **Dismiss** (`src/routes/api/sessions/[connectionId]/dismiss/+server.ts`): `POST` to remove offline/notification sessions.
- **Terminal activation** (`src/lib/remote/session_actions.remote.ts`): remote `command(...)` that resolves the WezTerm pane from session metadata, switches to the pane's workspace, activates the pane, and brings WezTerm to the foreground on macOS.
- **Shared helpers** (`src/lib/server/session_routes.ts`): `parseJsonBody()`, `badRequest()`, `notFound()`, `success()` used by all action routes.

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
- **Actions**: `sendPromptResponse(connectionId, requestId, value)`, `sendUserInput(connectionId, content)`, `dismissSession(connectionId)` — all POST to action API routes with URL-encoded connectionIds (notification IDs can contain `/`). `activateTerminalPane(session)` calls the remote command exported from `src/lib/remote/session_actions.remote.ts`.
- **SvelteMap reactivity**: SvelteMap only tracks `.set()`/`.delete()`/`.clear()` — after mutating nested properties on stored objects, the entry must be re-set to trigger reactivity.

### UI Components

- **`SessionList.svelte`** — Grouped session sidebar (left pane, w-96). Groups are collapsible by project. Shows all sessions regardless of selected project.
- **`SessionRow.svelte`** — Individual session entry with status indicator dot (green=active, gray=offline, blue=notification), command name, plan title/ID, dismiss button for offline/notification sessions, and a terminal icon when the session includes WezTerm pane metadata.
- **`SessionDetail.svelte`** — Message transcript view with session header (command, plan, workspace, status), optional terminal activation button for WezTerm-backed sessions, scrollable message list, fixed-position prompt area above messages, conditional message input bar. Uses `{#key connectionId}` for remount on session switch. Auto-scroll is scroll-position-based: active when at bottom, disabled when user scrolls up, resumes on scroll to bottom.
- **`SessionMessage.svelte`** — Renders messages by body type: text (colored by category), monospaced (preformatted code blocks), todoList (items with status icons), fileChanges (paths with +/~/- indicators), keyValuePairs (structured metadata table). Long content truncated with expandable reveal.
- **`PromptRenderer.svelte`** — Renders by prompt type: confirm (Yes/No buttons with default highlighted), input (text field with submit), select (radio group), checkbox (checkbox group), prefix_select (clickable word segments for bash command prefix authorization — selected words highlighted in accent color, remaining dimmed; "Submit Prefix" and "Allow Exact Command" buttons). Uses `{#key requestId}` for state reset. Shows header/question fields from promptConfig when present. Falls back to raw JSON display for unsupported types.
- **`MessageInput.svelte`** — Text input with Enter to send, Shift+Enter for newlines. Hidden (not disabled) when session is offline or non-interactive.
- **Category colors** (`src/lib/utils/session_colors.ts`): lifecycle=green, llmOutput=green, toolUse=cyan, fileChange=cyan, command=cyan, progress=blue, error=red, log=gray, userInput=orange.

## PWA Support

The web interface is installable as a Progressive Web App, allowing it to run as a standalone desktop/mobile app without browser chrome.

### Key Files

- `static/manifest.webmanifest` — App metadata (name, icons, display mode, theme color). Uses relative URLs and `start_url: "."` for base-path compatibility.
- `src/service-worker.ts` — SvelteKit built-in service worker using `$service-worker` module (`build`, `files`, `version`)
- `src/app.html` — PWA meta tags (manifest link, theme-color, apple-mobile-web-app-capable, apple-touch-icon). Uses `%sveltekit.assets%` for base-path safety.
- `src/routes/+layout.svelte` — Service worker registration in `onMount`
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

### Key Behaviors

- **Workspace `plan_id` is project-scoped, not globally unique.** Any lookup from a workspace's `plan_id` (text plan number) to a plan UUID must include the project ID to avoid collisions across projects. The "All Projects" mode is the most visible case — workspace plan links use a `planNumberToUuid` map keyed by `${projectId}:${planId}`.
- "Recently Active" toggle defaults to filtered; toggle state is `$state` that persists across project switches (not wrapped in `{#key}`)
- Plan detail sub-route reuses `PlanDetail` component; `getPlanDetailRouteData()` accepts a `tab` parameter for cross-project redirect URLs
- Dependency/parent links in PlanDetail point to the Plans tab (not Active Work) since dependencies can be any status
