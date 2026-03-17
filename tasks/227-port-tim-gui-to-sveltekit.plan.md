---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: port tim-gui to sveltekit
goal: Port the tim-gui macOS app to a SvelteKit web interface with Sessions,
  Plans, and Active Work views
id: 227
uuid: 6787e32d-3918-440e-8b8b-0562ba59e095
status: in_progress
priority: medium
epic: true
dependencies:
  - 228
  - 229
  - 230
references:
  "228": 68fe5243-cd4b-46cf-81e1-6f930d29e40b
  "229": fb9383c8-5ee1-4084-afe6-8a8572189d4e
  "230": 0a5407ee-b3bb-4dff-9790-68f54c8b44a7
createdAt: 2026-03-17T02:40:17.777Z
updatedAt: 2026-03-17T09:30:08.217Z
tasks: []
tags: []
---

We want to port the existing Mac OS app to run in a web interface instead. The SvelteKit app is set up in src/lib and
src/routes. It can import common code from src/tim and src/common for use in the server side.

The interface doesn't need to look exactly the same as tim-gui, but should follow the same general principles. We can
use an SSE endpoint for streaming updates from the server side.

## Expected Behavior/Outcome

A web-based interface that replicates the core functionality of the tim-gui macOS app:
- **Sessions view**: Real-time monitoring of active tim agent processes with message transcripts, prompt rendering, and user input
- **Active Work view**: Dashboard of in-progress projects showing workspaces and active plans
- **Plans view**: Full plan browser with filtering by status/priority/tags, sorting, search, and detail display
- Users can interact with running agents (respond to prompts, send input)
- Real-time updates via SSE from the server, which connects to tim agents via WebSocket

### Relevant States
- **Session states**: Active (connected, streaming), Offline (disconnected), Notification-only (HTTP notification without WebSocket session)
- **Plan display statuses**: Pending, In Progress, Blocked (has unresolved dependencies), Recently Done, Done, Cancelled, Deferred
- **Workspace statuses**: Available, Primary, Locked
- **Connection states**: Connected (SSE active), Reconnecting, Disconnected

## Key Findings

### Product & User Story
The tim-gui macOS app provides a 3-tab interface (Sessions, Active Work, Plans) for monitoring and interacting with tim agent processes. The web port enables cross-platform access to the same functionality. Users are developers running tim agents who need to monitor progress, respond to prompts, browse plans, and manage work.

### Design & UX Approach
- Follow the same 3-tab layout but adapt for web conventions (responsive, keyboard-friendly)
- Use Tailwind CSS 4 (already configured) for styling; no additional UI component library needed
- Adapt the NavigationSplitView pattern to a sidebar + content layout
- Use SSE for server-to-client streaming; POST endpoints for client-to-server actions

### Technical Plan & Risks
- **Server side**: SvelteKit server routes import directly from `$tim` and `$common` — all DB operations are synchronous (bun:sqlite)
- **Real-time**: Server acts as middleman — connects to tim agents via WebSocket (headless protocol on port 8123), streams events to browser via SSE
- **Risk**: WebSocket lifecycle management on server side (reconnection, buffering, multi-client fan-out)
- **Risk**: SSE connection management for multiple simultaneous browser tabs

### Pragmatic Effort Estimate
This is a large feature spanning multiple functional areas. Breaking into child plans is recommended:
1. Core infrastructure (SSE, server-side session management, shared layouts)
2. Plans browser (read-only, DB-backed, filtering/sorting)
3. Sessions view (real-time streaming, prompt interaction)
4. Active Work dashboard

## Acceptance Criteria
- [ ] Users can browse all plans with filtering by status, priority, tags, and search
- [ ] Users can view plan details including tasks, dependencies, and metadata
- [ ] Users can monitor active agent sessions with real-time message streaming
- [ ] Users can respond to prompts from running agents (confirm, input, select, checkbox; prefix_select in followup)
- [ ] Users can send free-form input to interactive sessions
- [ ] Users can view active work dashboard showing workspaces and in-progress plans
- [ ] The web interface updates in real-time via SSE without polling
- [ ] All new code paths are covered by tests

## Dependencies & Constraints
- **Dependencies**: Existing SvelteKit setup with `$tim` and `$common` path aliases; tim headless WebSocket protocol on port 8123; bun:sqlite database layer
- **Technical Constraints**: Must work with the existing headless WebSocket protocol (cannot change agent-side code); SQLite WAL mode with 5-second busy timeout for concurrent reads; SSE must handle reconnection gracefully

## Research

### 1. Tim-GUI Architecture Overview

The existing macOS app (Swift/SwiftUI) provides three main views:

**Sessions Tab** — Real-time monitoring of tim agent processes
- Sessions grouped by project (git remote + workspace path)
- Each session shows: command, plan info, status (Active/Offline), message transcript
- Messages categorized and color-coded: lifecycle (green), llmOutput (green), toolUse (cyan), fileChange (cyan), progress (blue), error (red), userInput (orange)
- Message body types: Text, Monospaced, TodoList (with status icons), FileChanges (+/~/- indicators), KeyValuePairs
- Interactive prompt rendering for: confirm (Yes/No), input (text field), select (dropdown), checkbox (toggle group), prefix_select
- User can send free-form input via message input bar
- Auto-scroll to bottom with manual override; shows last 100 messages per session
- Notification system: unread indicators on sessions, toolbar bell button jumps to first notification
- Groups are draggable to reorder; collapse/expand supported

**Active Work Tab** — Dashboard of in-progress projects
- Sidebar: project list showing last 2 path components
- Detail: workspaces section (recently active by default, toggleable to show all) + active plans section (in_progress + blocked only)
- Workspace rows show: name, branch chip, assigned plan, status badge (Primary/Locked/Available)
- Plan rows show: plan #, title, goal, status badge, relative timestamp

**Plans Tab** — Full plan browser
- Sidebar: project list (shared with Active Work)
- Middle pane: search field, sort picker (Recently Updated/Plan #/Priority), filter chips for 7 statuses, grouped & collapsible plan list
- Detail pane: plan #, title, goal, status, priority, dependencies, assigned workspace, epic indicator, parent, timestamps

### 2. Communication Protocol

Tim agents communicate with the GUI via a WebSocket-based headless protocol:

**Connection flow:**
1. Agent connects to `ws://localhost:8123/tim-agent` (configurable via `TIM_HEADLESS_URL` or config)
2. Sends `session_info` message with command, planId, workspacePath, gitRemote, etc.
3. Sends `replay_start`, replays buffered messages, sends `replay_end`
4. Streams `output` messages (each wrapping a `TunnelMessage` with sequence number)

**Message types (29 structured message types):**
- Session: `agent_session_start/end`, `agent_iteration_start`, `agent_step_start/end`
- LLM: `llm_thinking`, `llm_response`, `llm_tool_use`, `llm_tool_result`, `llm_status`
- Prompts: `prompt_request` (with requestId, promptType, promptConfig), `prompt_answered`
- Files: `file_write`, `file_edit`, `file_change_summary`, `command_exec`, `command_result`
- Tasks: `todo_update`, `plan_discovery`, `task_completion`
- Review: `review_start`, `review_result`
- Monitoring: `token_usage`, `execution_summary`, `workflow_progress`, `failure_report`

**Prompt types:** `input`, `confirm`, `select`, `checkbox`, `prefix_select` — each with specific config (choices, defaults, validation hints)

**Server-to-agent messages:** `prompt_response` (requestId + value/error), `user_input` (content string)

**Replay safety:** During replay, prompts are buffered but not shown to user; flushed after replay_end

### 3. Database Layer

All DB operations are **synchronous** (bun:sqlite with WAL mode). Key tables and CRUD modules:

- **project**: id, repository_id, remote_url, highest_plan_id
- **plan**: uuid, project_id, plan_id, title, goal, status, priority, parent_uuid, epic, filename, branch
- **plan_task**: plan_uuid, task_index, title, description, done
- **plan_dependency**: plan_uuid, depends_on_uuid
- **plan_tag**: plan_uuid, tag
- **workspace**: id, project_id, workspace_path, branch, plan_id, plan_title, is_primary, task_id
- **workspace_lock**: workspace_id, lock_type, pid, hostname, command
- **assignment**: project_id, plan_uuid, workspace_id, claimed_by_user, status

Key functions: `getPlansByProject()`, `getPlanTasksByProject()`, `getPlanDependenciesByProject()`, `getPlanTagsByProject()`, `findWorkspacesByProjectId()`, `getAssignmentEntriesByProject()`, `listProjects()`

### 4. Reusable Tool Functions

The `src/tim/tools/` directory provides ready-made functions:
- `listReadyPlansTool(args, context)` — filtered plan listing with enriched data
- `getPlanTool(args, context)` — full plan retrieval
- `createPlanTool(args, context)` — plan creation with automatic parent relationship maintenance
- `managePlanTaskTool(args, context)` — add/update/remove tasks
- `updatePlanDetailsTool(args, context)` — update plan details (delimiter-aware)
- `updatePlanTasksTool(args, context)` — bulk task update with merge

All return `ToolResult<T>` with `.text` (human-readable) and `.data` (structured JSON).

### 5. Plan File Operations

- `readPlanFile(filePath)` / `writePlanFile(filePath, plan)` — YAML frontmatter + markdown body
- `readAllPlans(directory)` — returns `Map<number, PlanSchema & {filename}>` plus UUID mappings
- `filterAndSortReadyPlans(allPlans, options)` — ready plan filtering with dependency resolution
- `syncPlanToDb(planFile)` — bridges file system and database

### 6. SvelteKit Setup

Current state: minimal scaffolding with:
- Svelte 5 with runes enabled
- `@sveltejs/adapter-node` (Bun-compatible)
- Tailwind CSS 4 via `@tailwindcss/vite`
- Path aliases: `$tim` → `src/tim`, `$common` → `src/common`
- No UI component library, no server routes, no API endpoints yet
- Vitest configured for server-side testing

### 7. Configuration

- `loadEffectiveConfig(configPath?)` — loads merged config
- `resolvePlanPathContext(config)` — resolves gitRoot and task directory paths
- `getTimConfigRoot()` — XDG-aware config directory (`~/.config/tim/` on macOS/Linux)
- Database path via `getDefaultDatabasePath()`

### 8. Key Patterns from macOS App

**ProjectTrackingStore** (data refresh pattern):
- Reference-counted refresh: `startRefreshing()` / `stopRefreshing()` on tab mount/unmount
- 10-second polling interval
- Async coalescing: `isRefreshing` guard + `needsRefresh` flag prevents dropped updates
- Selection validation: captures `selectedProjectId` at refresh start, discards stale data
- `assignIfChanged()` helper avoids redundant reactive updates

**SessionState** (session management pattern):
- Sessions grouped by `sessionGroupKey(gitRemote, workspacePath)`
- Notification-only sessions created from HTTP endpoint, reconciled with WebSocket sessions
- Message buffering in `pendingMessages` until `session_info` received
- Replay safety: `replayingConnections` set suppresses prompt display during replay
- Message deduplication: GUI-originated user input skipped on echo back

## Implementation Guide

### Architecture Overview

The web app will use a **server-mediated** architecture:
- **SvelteKit server** acts as the central hub, connecting to tim agents via WebSocket and serving browser clients via SSE
- **Browser** connects to SvelteKit via SSE for real-time updates and POST endpoints for actions
- **Database** accessed directly on server side via synchronous bun:sqlite calls

```
Browser ←→ SSE/POST ←→ SvelteKit Server ←→ WebSocket ←→ Tim Agents
                              ↕
                          SQLite DB
```

### Design Decisions (from refinement)

- SvelteKit server fully replaces macOS app; runs WebSocket server on port 8123 via separate `Bun.serve()` (not via SvelteKit adapter)
- Multi-project support with project sidebar
- No UI state persistence for now (group order, filters reset on reload)
- Show all messages per session, no virtual scrolling (optimize later if needed)
- Separate SSE endpoints: one for session events, one for plan/workspace data
- Initial page load for plan data; incremental SSE-based updates deferred to future
- Read-only plan views (editing deferred to future)
- Full rich message rendering from the start (text, monospaced, todo, file changes, key-value pairs)
- Prompt types: confirm, input, select, checkbox (prefix_select in a followup plan)
- HTTP notification endpoint on 8123 included (for one-off notifications)
- "Recently active" workspaces: locked, primary, or updated within 48 hours
- Server-side computation of display status including "blocked" (unresolved dependencies)

### Child Plans

This epic is split into 3 child plans by feature area:
1. **Plan 228: Core infrastructure + Plans browser** — shared layout/nav, project listing, DB-backed plan listing with filtering/sorting/detail, server initialization
2. **Plan 229: Sessions view** — WebSocket server on 8123, SSE for session streaming, message rendering, prompt interaction, user input, HTTP notification endpoint (depends on 228)
3. **Plan 230: Active Work dashboard** — workspace listing, active plan display, recently-active filtering (depends on 228)

### Step 1: Server Initialization & Shared Context

Create server-side initialization that starts when the SvelteKit server boots.

**File: `src/lib/server/init.ts`**

This module needs to:
1. Load tim config via `loadEffectiveConfig()`
2. Resolve path context via `resolvePlanPathContext(config)`
3. Initialize the database connection via `getDatabase()`
4. Export a shared context object (`config`, `gitRoot`, `db`) for use by all server routes
5. Use a lazy-init singleton pattern (initialize on first access, persist for server lifetime)

**File: `src/lib/server/db_queries.ts`**

Server-side helper functions that wrap DB queries for the web UI:
1. `getProjectsWithMetadata()` — list projects with plan counts
2. `getPlansForProject(projectId, filters)` — plans with computed display status (blocked detection via dependency join), tags, tasks
3. `getWorkspacesForProject(projectId)` — workspaces with lock status and assignment info
4. `getPlanDetail(planId)` — full plan details from both DB and plan file

### Step 2: Shared Layout and Navigation

Create the app shell with tab-based navigation.

**Files:**
- `src/routes/+layout.svelte` — App shell with fixed header, tab nav, project sidebar
- `src/routes/+layout.server.ts` — Load initial project list from DB
- `src/lib/components/TabNav.svelte` — Tab navigation (Sessions, Active Work, Plans)
- `src/lib/components/ProjectSidebar.svelte` — Shared project sidebar used by Plans and Active Work tabs

The layout should:
1. Provide a fixed header with tab navigation
2. Include a shared project sidebar that persists across tab switches
3. Pass project data via layout load function
4. Use Svelte 5 runes for reactive state

### Step 3: Plans Browser View

Implement the Plans tab with filtering, sorting, search, and detail display.

**Files:**
- `src/routes/plans/+page.svelte` — Plans browser page
- `src/routes/plans/+page.server.ts` — Load plans for selected project
- `src/lib/components/PlansList.svelte` — Filtered, grouped, collapsible plan list
- `src/lib/components/PlanDetail.svelte` — Plan detail display
- `src/lib/components/FilterChips.svelte` — Status filter chips
- `src/lib/components/PlanRow.svelte` — Individual plan row

Features to implement:
- Search field (case-insensitive title + goal matching)
- Sort picker (Recently Updated, Plan #, Priority)
- Status filter chips (7 display statuses + Reset/All) with multi-select
- Grouped & collapsible plan list (groups ordered by actionability: In Progress → Blocked → Pending → ...)
- Plan detail pane showing: title, goal, status, priority, tasks with done status, dependencies (with resolved/unresolved indication), assigned workspace, epic indicator, parent, timestamps, tags

Use `PlanDisplayStatus` concept: Pending, In Progress, Blocked (pending/in_progress with unresolved deps), Recently Done (done within last 7 days), Done, Cancelled, Deferred.

### Step 4: WebSocket Server & Session Manager

Create a server-side singleton that manages WebSocket connections to tim agents.

**File: `src/lib/server/ws_server.ts`**

WebSocket server using `Bun.serve()` on port 8123:
1. Handle WebSocket upgrade for `/tim-agent` path
2. Handle HTTP POST for plain notification messages (same port, different path)
3. Parse the headless protocol: `session_info`, `output`, `replay_start/end`
4. Track WebSocket connections for sending responses back

**File: `src/lib/server/session_manager.ts`**

Session state management:
1. Maintain `Map<string, SessionData>` of active sessions (keyed by connection UUID)
2. Format incoming structured messages into display-ready `SessionMessage` objects (category, body type)
3. Track session groups by project (`sessionGroupKey(gitRemote, workspacePath)`)
4. Handle replay buffering (suppress prompts during replay, flush after `replay_end`)
5. Buffer messages in `pendingMessages` until `session_info` received
6. Handle notification-only sessions from HTTP endpoint, reconcile with WebSocket sessions
7. Provide `sendPromptResponse(connectionId, requestId, value)` and `sendUserInput(connectionId, content)`
8. Emit events for SSE consumers via EventEmitter pattern

Reference files:
- `src/logging/headless_protocol.ts` — HeadlessMessage, HeadlessServerMessage types
- `src/logging/structured_messages.ts` — All 29 StructuredMessage types
- `scripts/manual-headless-prompt-harness.ts` — Example WebSocket server

### Step 5: Sessions SSE Endpoint & API

**File: `src/routes/api/sessions/events/+server.ts`**

SSE endpoint for session events:
- `session:list` — initial snapshot of all current sessions on connect
- `session:new` / `session:update` / `session:disconnect` — session lifecycle
- `session:message` — new message in a session (includes connectionId, formatted message)
- `session:prompt` / `session:prompt-cleared` — prompt lifecycle
- Handle client disconnection cleanup

**API endpoints:**
- `POST /api/sessions/[connectionId]/respond/+server.ts` — Send prompt response
- `POST /api/sessions/[connectionId]/input/+server.ts` — Send user input
- `POST /api/sessions/[connectionId]/dismiss/+server.ts` — Dismiss offline session

### Step 6: Sessions View UI

**Files:**
- `src/routes/sessions/+page.svelte` — Sessions view
- `src/lib/components/SessionList.svelte` — Grouped session list sidebar
- `src/lib/components/SessionRow.svelte` — Session row (status indicator, command, plan info)
- `src/lib/components/SessionDetail.svelte` — Message transcript view with auto-scroll
- `src/lib/components/SessionMessage.svelte` — Message rendering by category and body type
- `src/lib/components/PromptRenderer.svelte` — Prompt rendering (confirm/input/select/checkbox)
- `src/lib/components/MessageInput.svelte` — User input bar (Enter to send, Shift+Enter for newlines)
- `src/lib/stores/session_state.svelte.ts` — Client-side session state from SSE

Message rendering by body type:
- **Text** — plain text with category-based color
- **Monospaced** — preformatted code blocks
- **TodoList** — items with status icons (done, in_progress, pending, error, unknown)
- **FileChanges** — added (+) / modified (~) / removed (-) indicators with file paths
- **KeyValuePairs** — structured metadata table

Message categories and colors (matching macOS app):
- lifecycle → green, llmOutput → green, toolUse → cyan, fileChange → cyan, command → cyan, progress → blue, error → red, log → default, userInput → orange

### Step 7: Active Work Dashboard

**Files:**
- `src/routes/active/+page.svelte` — Active work dashboard
- `src/routes/active/+page.server.ts` — Load workspaces and active plans
- `src/lib/components/WorkspaceRow.svelte` — Workspace display (name, branch, assigned plan, status badge)
- `src/lib/components/ActivePlanRow.svelte` — Active plan display

Features:
- Reuses ProjectSidebar from layout
- Workspaces section: recently active by default (locked, primary, or updated <48hrs), toggle to show all
- Plans section: in_progress + blocked plans only
- Workspace status badges: Primary (blue), Locked (yellow), Available (gray)

### Testing Strategy

Tests for each child plan:
- **Plan 1 (Core + Plans)**: DB query helpers, plan display status computation, API endpoint responses
- **Plan 2 (Sessions)**: WebSocket message parsing, session lifecycle, replay buffering, prompt handling, message formatting
- **Plan 3 (Active Work)**: Recently-active filtering, workspace status computation

Use vitest with real DB fixtures (no mocking). Server-side tests in `src/lib/server/*.test.ts`.

### Manual Testing Steps
1. Start dev server (`bun run dev`) — verify it boots and serves pages
2. Browse Plans tab — verify projects load, plans display with correct statuses and filtering
3. Start a tim agent with headless mode — verify session appears in Sessions tab
4. Test prompt interaction — trigger prompts from agent, respond via web UI
5. Send free-form input to interactive session
6. Verify Active Work shows correct workspaces and active plans
7. Test SSE reconnection by reloading browser tab
8. Test multiple browser tabs simultaneously

## Implementation Notes

### Recommended Approach
- Start with Core + Plans browser (Plan 1) since it's the foundation and simplest (read-only DB queries, no real-time)
- Then Sessions view (Plan 2) which is the most complex (real-time + interactive)
- Active Work dashboard (Plan 3) last, as it reuses many components from Plans

### Potential Gotchas
- **SQLite in SvelteKit**: bun:sqlite is synchronous and works in server-side code, but must not be imported in client-side code. Use `$lib/server/` convention for server-only modules.
- **WebSocket server lifecycle**: The `Bun.serve()` WebSocket server on port 8123 needs to start when the SvelteKit server starts and persist across requests. Use a module-level singleton pattern, initialized from a server hook or layout server load.
- **SSE connection limits**: Browsers limit concurrent SSE connections per domain (typically 6). Each tab will use one connection per SSE endpoint.
- **Prompt race conditions**: A prompt may be answered from another client (terminal, another browser tab). The server must broadcast prompt cancellation to all SSE listeners.
- **Message sequence ordering**: Messages have sequence numbers; display must respect ordering even if SSE delivers out of order.
- **Headless adapter reconnection**: If the SvelteKit server restarts, agent connections will drop and reconnect with replay.
- **Bun.serve() port conflict**: Port 8123 will conflict if the macOS app is also running. Only one should run at a time.
