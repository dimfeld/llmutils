---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Sessions view with real-time streaming
goal: Implement real-time Sessions view with WebSocket server, session
  management, SSE streaming, and full UI including message rendering and prompt
  interaction
id: 229
uuid: fb9383c8-5ee1-4084-afe6-8a8572189d4e
generatedBy: agent
status: done
priority: medium
dependencies:
  - 228
parent: 227
references:
  "227": 6787e32d-3918-440e-8b8b-0562ba59e095
  "228": 68fe5243-cd4b-46cf-81e1-6f930d29e40b
planGeneratedAt: 2026-03-18T00:55:32.853Z
promptsGeneratedAt: 2026-03-18T00:55:32.853Z
createdAt: 2026-03-17T09:05:17.148Z
updatedAt: 2026-03-18T09:04:38.163Z
tasks:
  - title: Create session manager core with message categorization and event emission
    done: true
    description: "Create src/lib/server/session_manager.ts with: SessionData type
      (connectionId, sessionInfo, status active/offline/notification, projectId
      resolved from DB, messages, activePrompt, isReplaying, groupKey,
      timestamps), DisplayMessage type (id, seq, timestamp, category, bodyType,
      body, rawType), message categorization function mapping all 29
      StructuredMessage types plus TunnelMessage types to categories
      (lifecycle/llmOutput/toolUse/fileChange/command/progress/error/log/userIn\
      put) and body types (text/monospaced/todoList/fileChanges/keyValuePairs).
      Suppress debug tunnel messages. Render token_usage and llm_status as
      compact single-line summaries. Handle non-structured TunnelMessages
      (log/error/warn/stdout/stderr) with args joined by spaces. Implement
      EventEmitter pattern for SSE consumers with events: session:new,
      session:update, session:disconnect, session:message, session:prompt,
      session:prompt-cleared, session:dismissed. Methods:
      handleWebSocketMessage, handleWebSocketConnect/Disconnect,
      handleHttpNotification, sendPromptResponse, sendUserInput, dismissSession,
      getSessionSnapshot, subscribe/unsubscribe. Resolve session projectId by
      matching gitRemote against DB project remote_url. Handle replay buffering:
      messages during replay_start..replay_end are added to session message list
      but NOT emitted as SSE events. Write comprehensive tests for message
      categorization, session lifecycle, replay buffering, prompt tracking,
      notification sessions, and project resolution."
  - title: Create WebSocket server on port 8123 with HTTP notification endpoint
    done: true
    description: "Create src/lib/server/ws_server.ts using Bun.serve() pattern from
      scripts/manual-headless-prompt-harness.ts. Handle WebSocket upgrade for
      GET /tim-agent path. Handle HTTP POST /messages for notification-only
      messages (payload: {message, workspacePath, gitRemote, terminal?}). Return
      404 for other paths. Generate unique connectionId (UUID) per WebSocket
      connection. Store WebSocket references in a Map for sending responses
      back. Parse incoming messages as HeadlessMessage and delegate to
      SessionManager. Port configuration: check TIM_WS_PORT env var first, then
      parse from headless.url config / TIM_HEADLESS_URL, fall back to 8123.
      Export startWebSocketServer(sessionManager, config) function. Write tests
      for message parsing, HTTP notification handling, and port configuration
      logic."
  - title: Start WebSocket server from hooks.server.ts init function
    done: true
    description: Create src/hooks.server.ts with an init function that starts the
      WebSocket server when the SvelteKit server boots. Import
      getServerContext() to get config and db, create SessionManager instance,
      call startWebSocketServer(). Export the session manager singleton so it
      can be imported by SSE and API routes. Ensure the session manager is
      accessible to server routes (export from a server module or attach to
      server context).
  - title: Create SSE endpoint for streaming session events to browser
    done: true
    description: >-
      Create src/routes/api/sessions/events/+server.ts as a GET handler
      returning a ReadableStream with SSE headers (Content-Type:
      text/event-stream, Cache-Control: no-cache). On connect: send session:list
      event with full session snapshot. Subscribe to SessionManager events and
      forward as SSE events (session:new, session:update, session:disconnect,
      session:message, session:prompt, session:prompt-cleared,
      session:dismissed). On client disconnect: unsubscribe from SessionManager.
      Each SSE event has format: event: <type>

      data: <json>


      . Write tests for SSE event formatting and snapshot generation.
  - title: Create action API endpoints for prompt responses, user input, and session
      dismiss
    done: true
    description: "Create three POST API routes:
      src/routes/api/sessions/[connectionId]/respond/+server.ts (body:
      {requestId, value}, delegates to sessionManager.sendPromptResponse()),
      src/routes/api/sessions/[connectionId]/input/+server.ts (body: {content},
      delegates to sessionManager.sendUserInput()),
      src/routes/api/sessions/[connectionId]/dismiss/+server.ts (delegates to
      sessionManager.dismissSession()). Return appropriate status codes (200
      success, 404 session not found, 400 bad request). Write tests for each
      endpoint."
  - title: Create client-side session store with SSE connection management
    done: true
    description: "Create src/lib/stores/session_state.svelte.ts as a Svelte 5
      runes-based reactive store. Manage SSE connection to /api/sessions/events
      with auto-reconnect on disconnect. Maintain $state for: sessions Map,
      selectedSessionId, connectionStatus (connected/reconnecting/disconnected).
      Derive sessionGroups (sessions grouped by groupKey, with current project
      sorted to top). Expose connect()/disconnect() lifecycle,
      setCurrentProjectId(id) for group sorting, selectSession(id),
      sendPromptResponse(connectionId, requestId, value),
      sendUserInput(connectionId, content), dismissSession(connectionId). SSE
      event handlers update $state directly. Resolve group labels: use project
      display name when projectId matches a known project, fall back to
      workspace path (last 2 components)."
  - title: Create Sessions page with split-pane layout and session list
    done: true
    description: "Replace the placeholder
      src/routes/projects/[projectId]/sessions/+page.svelte with the full
      sessions view. Split-pane layout: left pane (w-96) with SessionList, right
      pane (flex-1) with SessionDetail or empty state. Initialize session store
      SSE connection from root +layout.svelte (stays open across all tabs).
      Create src/lib/components/SessionList.svelte with grouped session list:
      groups collapsible by project, group labels resolved from project DB or
      workspace path. Create src/lib/components/SessionRow.svelte: status
      indicator dot (green=active, gray=offline, blue=notification), command
      name, plan title/ID if available, dismiss button for offline/notification
      sessions. Highlight selected session."
  - title: Create message transcript view with auto-scroll and rich message rendering
    done: true
    description: "Create src/lib/components/SessionDetail.svelte: session header
      (command, plan, workspace, status), scrollable message list,
      fixed-position prompt area above messages, conditional message input bar.
      Implement scroll-position-based auto-scroll (active when at bottom,
      disabled when user scrolls up, resumes on scroll to bottom). Create
      src/lib/components/SessionMessage.svelte rendering by bodyType: text
      (colored by category), monospaced (preformatted code blocks for
      llm_thinking/diffs/commands), todoList (items with status icons),
      fileChanges (paths with +/~/- indicators), keyValuePairs (structured
      metadata table). Apply category color mapping: lifecycle=green,
      llmOutput=green, toolUse=cyan, fileChange=cyan, command=cyan,
      progress=blue, error=red, log=gray, userInput=orange. Truncate long
      content (tool inputs/outputs, diffs, command output) with expandable
      reveal."
  - title: Create prompt renderer and message input bar components
    done: true
    description: "Create src/lib/components/PromptRenderer.svelte rendered in a
      fixed position above the scrollable message area in SessionDetail. Render
      by promptType: confirm (Yes/No buttons with default highlighted), input
      (text field with submit button, optional default value and validation
      hint), select (radio button group from choices with descriptions),
      checkbox (checkbox group from choices with pre-checked options). Show
      header and question fields from promptConfig when present. Send responses
      via store sendPromptResponse(). Create
      src/lib/components/MessageInput.svelte: text input with Enter to send,
      Shift+Enter for newlines. Hidden (not disabled) when session is offline or
      non-interactive. Sends via store sendUserInput()."
  - title: End-to-end integration testing and final polish
    done: true
    description: "Write integration tests covering: WebSocket connection -> session
      appears in manager -> SSE delivers session:new event -> messages flow
      through to DisplayMessage format -> prompt lifecycle (request -> render ->
      respond -> prompt_answered clears it). Test HTTP notification flow: POST
      /messages -> notification session created -> SSE delivers it. Test prompt
      cancellation: prompt answered from terminal -> prompt_answered message ->
      SSE broadcasts session:prompt-cleared. Verify session grouping with
      project resolution. Run bun run check and bun run format. Verify manual
      testing steps from the implementation guide work end-to-end."
  - title: "Address Review Feedback: Malformed structured tunnel messages still
      crash the websocket pipeline instead of being handled defensively."
    done: true
    description: |-
      Malformed structured tunnel messages still crash the websocket pipeline instead of being handled defensively. [`parseHeadlessMessage()`](/Users/dimfeld/Documents/projects/llmutils/src/lib/server/ws_server.ts#L58) only validates the outer `HeadlessMessage`, so an `output` frame with `message.type === 'structured'` and an unknown nested structured `type` is accepted. [`formatTunnelMessage()`](/Users/dimfeld/Documents/projects/llmutils/src/lib/server/session_manager.ts#L560) assumes `summarizeStructuredMessage()` always returns a formatter result; for an unknown runtime type it returns `undefined`, and the code then dereferences `formatted.category` at lines 581-586 and throws. [`ws_server.ts`](/Users/dimfeld/Documents/projects/llmutils/src/lib/server/ws_server.ts#L128) does not wrap `sessionManager.handleWebSocketMessage()` in a guard, so a bad client frame can take down message processing for that socket. I reproduced this with a one-line `bun -e` invocation against `formatTunnelMessage()`, which throws `undefined is not an object (evaluating 'formatted.category')`.

      Suggestion: Validate nested tunnel/structured payloads before dispatch, and make `formatTunnelMessage()` resilient to unknown structured message types by handling an `undefined` formatter result or adding a default branch in `summarizeStructuredMessage()`. Also wrap websocket message dispatch in `ws_server.ts` so malformed client input cannot escape as an uncaught exception.

      Related file: src/lib/server/session_manager.ts:560-589
  - title: "Address Review Feedback: Active WebSocket sessions push messages to the
      messages array without any cap (line 734)."
    done: true
    description: >-
      Active WebSocket sessions push messages to the messages array without any
      cap (line 734). Notification sessions are capped at 200, but WS sessions
      grow indefinitely. A long-running agent session could accumulate thousands
      of messages, all held in server memory. The getSessionSnapshot() method
      (line 910-916) deep-clones ALL messages for ALL sessions on every new SSE
      client connection, compounding memory pressure. The SSE initial snapshot
      also serializes all messages as JSON over the wire.


      Suggestion: Add a MAX_SESSION_MESSAGES constant (e.g., 5000) and trim old
      messages when exceeded, similar to notification sessions. At minimum, cap
      what getSessionSnapshot() includes in the initial SSE snapshot.


      Related file: src/lib/server/session_manager.ts:734
  - title: "Address Review Feedback: getSessionSnapshot() deep-clones every message
      body for every session on each call."
    done: true
    description: >-
      getSessionSnapshot() deep-clones every message body for every session on
      each call. This is invoked for every new SSE client connection (browser
      tab open/reconnect). Combined with unbounded message growth, this creates
      significant CPU and memory spikes. The TODO comment on line 908
      acknowledges this issue.


      Suggestion: Separate the initial snapshot into metadata-only (like
      cloneSessionMetadata) plus a per-session message fetch, or cap the number
      of messages included in the snapshot (e.g., last 500 per session).


      Related file: src/lib/server/session_manager.ts:910-916
  - title: "Address Review Feedback: Notification-only sessions can generate
      duplicate message IDs once they hit the 200-message cap."
    done: true
    description: |-
      Notification-only sessions can generate duplicate message IDs once they hit the 200-message cap. In [`session_manager.ts`](/Users/dimfeld/Documents/projects/llmutils/src/lib/server/session_manager.ts#L814), the ID is built from `session.messages.length` and `Date.now()`. After the cap is applied at lines 828-830, `session.messages.length` goes back to 200, so two notifications arriving in the same millisecond can receive the same ID. The transcript view keys rows by `message.id` in [`SessionDetail.svelte`](/Users/dimfeld/Documents/projects/llmutils/src/lib/components/SessionDetail.svelte#L102), so duplicate IDs can cause dropped or incorrectly reused DOM rows.

      Suggestion: Use a monotonic per-session counter or a UUID for notification message IDs instead of `messages.length` plus `Date.now()`.

      Related file: src/lib/server/session_manager.ts:814-830
  - title: "Address Review Feedback: The WebSocket server is started in
      hooks.server.ts init but there's no registered shutdown handler to call
      serverHandle.stop() when the SvelteKit server shuts down."
    done: true
    description: >-
      The WebSocket server is started in hooks.server.ts init but there's no
      registered shutdown handler to call serverHandle.stop() when the SvelteKit
      server shuts down. In production, the Bun.serve instance on port 8123 may
      linger. During dev, this is mitigated by the Symbol.for-based singleton
      pattern for HMR survival.


      Suggestion: Register a process exit handler (process.on('SIGTERM', ...))
      or use SvelteKit shutdown hooks to call serverHandle.stop() for clean
      production shutdown.


      Related file: src/hooks.server.ts:30-33
  - title: "Address Review Feedback: Replay prompt suppression is broken for fresh
      SSE clients."
    done: true
    description: >-
      Replay prompt suppression is broken for fresh SSE clients. During replay,
      `handleStructuredSideEffects()` stores a replayed `prompt_request` in
      `session.activePrompt`, and `getSessionSnapshot()`/`cloneSession()`
      include that prompt even while `session.isReplaying` is still true.
      `SessionDetail` renders any non-null `activePrompt` unconditionally. A
      browser tab that connects mid-replay will therefore see a prompt before
      `replay_end`, which violates the plan's replay-buffering requirement and
      can let the user answer a replayed prompt early because
      `sendPromptResponse()` only checks `activePrompt`. I reproduced this with
      `bun -e`, and `getSessionSnapshot().sessions[0].activePrompt` is non-null
      after `replay_start` plus a replayed `prompt_request`.


      Suggestion: Keep replayed prompts only in internal deferred state until
      `replay_end`, or strip `activePrompt` from snapshots/metadata while
      `isReplaying` is true. Add a UI-side guard in `SessionDetail` as a second
      line of defense, and add a test for a client connecting mid-replay.


      Related file:
      src/lib/server/session_manager.ts:919-924,1005-1025,1065-1100
  - title: "Address Review Feedback: In session_state.svelte.ts:167-171, each
      `session:message` SSE event creates a new messages array via spread
      (`[...session.messages, event.message]`) and then re-spreads the entire
      session object (`{ ...session }`)."
    done: true
    description: >-
      In session_state.svelte.ts:167-171, each `session:message` SSE event
      creates a new messages array via spread (`[...session.messages,
      event.message]`) and then re-spreads the entire session object (`{
      ...session }`). For high-frequency message sessions (agents sending many
      tool results), this is O(n) per message, creating significant GC pressure
      as message lists grow. The lessons learned section notes that SvelteMap
      requires re-setting entries for reactivity, but the messages array copy
      could be avoided.


      Suggestion: Push to the existing array instead of spreading:
      `session.messages.push(event.message); sessions.set(event.connectionId, {
      ...session });` — this avoids copying the entire messages array on each
      message while still triggering SvelteMap reactivity.


      Related file: src/lib/stores/session_state.svelte.ts:167-171
changedFiles:
  - CLAUDE.md
  - README.md
  - bunfig.toml
  - docs/web-interface.md
  - package.json
  - src/hooks.server.ts
  - src/lib/components/MessageInput.svelte
  - src/lib/components/PromptRenderer.svelte
  - src/lib/components/SessionDetail.svelte
  - src/lib/components/SessionList.svelte
  - src/lib/components/SessionMessage.svelte
  - src/lib/components/SessionRow.svelte
  - src/lib/server/hooks.server.test.ts
  - src/lib/server/session_context.ts
  - src/lib/server/session_integration.test.ts
  - src/lib/server/session_manager.test.ts
  - src/lib/server/session_manager.ts
  - src/lib/server/session_routes.test.ts
  - src/lib/server/session_routes.ts
  - src/lib/server/ws_server.test.ts
  - src/lib/server/ws_server.ts
  - src/lib/stores/session_state.svelte.ts
  - src/lib/stores/session_state_events.test.ts
  - src/lib/stores/session_state_events.ts
  - src/lib/types/session.ts
  - src/lib/utils/session_colors.ts
  - src/routes/+layout.svelte
  - src/routes/api/sessions/[connectionId]/dismiss/+server.ts
  - src/routes/api/sessions/[connectionId]/input/+server.ts
  - src/routes/api/sessions/[connectionId]/respond/+server.ts
  - src/routes/api/sessions/actions.server.test.ts
  - src/routes/api/sessions/events/+server.ts
  - src/routes/api/sessions/events/events.server.test.ts
  - src/routes/projects/[projectId]/sessions/+page.svelte
  - src/tim/mcp/generate_mode.test.ts
  - src/tim/mcp/generate_mode.ts
tags: []
---

Implement the WebSocket server on port 8123 using Bun.serve() to receive tim agent connections, HTTP notification endpoint, server-side session manager with replay buffering and message formatting, SSE endpoint for streaming session events to browser, and the full Sessions UI with grouped session list, rich message rendering (text, monospaced, todo, file changes, key-value pairs), prompt rendering (confirm, input, select, checkbox), and user input bar.

## Expected Behavior/Outcome

The Sessions tab becomes a fully functional real-time monitoring interface for tim agent processes. Users can:
- See all active and recently-disconnected agent sessions grouped by project
- Watch live message transcripts as agents execute (LLM output, tool usage, file changes, etc.)
- Respond to prompts from running agents (confirm, input, select, checkbox)
- Send free-form input to interactive sessions
- Receive HTTP notification-only messages (fire-and-forget status updates without a WebSocket session)

### Relevant States
- **Session states**: Active (WebSocket connected, streaming), Offline (disconnected), Notification-only (HTTP message without WebSocket)
- **Message categories**: lifecycle (green), llmOutput (green), toolUse (cyan), fileChange (cyan), command (cyan), progress (blue), error (red), log (default), userInput (orange)
- **Message body types**: Text, Monospaced (code blocks), TodoList (task items with status icons), FileChanges (added/modified/removed indicators), KeyValuePairs (structured metadata)
- **Prompt types**: confirm (Yes/No buttons), input (text field), select (radio list), checkbox (toggle group)
- **Connection states**: Connected (SSE active), Reconnecting, Disconnected

## Key Findings

### Product & User Story
Developers running tim agents need to monitor real-time progress, respond to prompts, and send input — all from a web browser. The Sessions view replaces the macOS-only tim-gui Sessions tab with a cross-platform web interface.

### Design & UX Approach
- Split-pane layout matching the Active Work and Plans tabs: session list on left, message transcript on right
- Sessions grouped by project (gitRemote + workspacePath), resolved to project names from DB when possible
- All sessions shown regardless of selected project, but current project's sessions sorted to top
- Rich message rendering with category-based color coding matching the macOS app
- Auto-scroll to bottom of transcript, disabled when user scrolls up, re-enabled when scrolling back to bottom
- Prompt UI rendered in a fixed position above the message area (not inline in transcript) so it's always visible
- Message input bar at the bottom, hidden for non-interactive and offline sessions
- Long content (tool inputs/outputs, diffs, command output) truncated by default with expand to reveal

### Technical Plan & Risks
- **Server**: Bun.serve() WebSocket server on port 8123 runs as a separate server (not via SvelteKit adapter), started as a singleton alongside the SvelteKit dev server
- **Real-time**: Server connects to agents via WebSocket, streams events to browser via SSE
- **Risk**: WebSocket lifecycle management — reconnection, buffering, multi-client fan-out
- **Risk**: SSE connection limits (browsers limit ~6 per domain) — one SSE endpoint serves all session data
- **Risk**: Port 8123 conflicts with macOS tim-gui — only one should run at a time
- **Risk**: Prompt race conditions — a prompt may be answered from terminal or another browser tab; server must broadcast cancellation

### Pragmatic Effort Estimate
This is a large feature with 3 major components: WebSocket server + session manager, SSE streaming, and Sessions UI. Kept as a single plan since the pieces are tightly interdependent.

## Acceptance Criteria
- [ ] WebSocket server on port 8123 accepts tim agent connections at `/tim-agent` path
- [ ] HTTP POST endpoint at `/messages` on port 8123 accepts notification-only messages
- [ ] Session manager tracks active sessions, handles replay buffering, and groups by project
- [ ] SSE endpoint streams session lifecycle events and messages to browser clients
- [ ] Sessions UI displays grouped session list with status indicators
- [ ] Rich message rendering for all body types: text, monospaced, todo lists, file changes, key-value pairs
- [ ] Message categories are color-coded matching the macOS app scheme
- [ ] Users can respond to confirm, input, select, and checkbox prompts from the browser
- [ ] Users can send free-form input to interactive sessions via message input bar
- [ ] Prompt cancellation is broadcast when a prompt is answered from another source
- [ ] SSE reconnection works gracefully (browser receives current state on reconnect)
- [ ] All new code paths are covered by tests

## Dependencies & Constraints
- **Dependencies**: Plan 228 (core infrastructure) must be complete — provides shared layouts, server init, project sidebar, tab navigation
- **Technical Constraints**: Must implement the same headless WebSocket protocol that agents already use (cannot change agent-side code); Bun.serve() WebSocket server must coexist with SvelteKit dev server; SQLite WAL mode for concurrent reads; SSE must handle multiple browser tabs

## Research

### 1. Headless Protocol Architecture

The communication between tim agents and GUIs uses a well-defined WebSocket protocol:

**Connection flow:**
1. Agent creates a `HeadlessAdapter` which connects to `ws://localhost:8123/tim-agent`
2. On connect, sends `session_info` message with command, planId, planTitle, workspacePath, gitRemote, etc.
3. Sends `replay_start`, then replays all buffered historical messages, then `replay_end`
4. Continues streaming new `output` messages, each wrapping a `TunnelMessage` with a sequence number

**HeadlessMessage types (client→server):**
- `session_info` — session metadata (command, planId, planTitle, workspacePath, gitRemote, interactive, terminalPaneId, terminalType)
- `replay_start` / `replay_end` — markers for historical message replay
- `output` — wraps a `TunnelMessage` with a `seq` number

**HeadlessServerMessage types (server→client):**
- `prompt_response` — responds to a prompt_request (requestId + value or error)
- `user_input` — free-form text input from GUI

**TunnelMessage types (nested inside output):**
- `log` / `error` / `warn` / `debug` — logging with serialized args
- `stdout` / `stderr` — raw output data
- `structured` — wraps one of 29 StructuredMessage types

**Key files:**
- `src/logging/headless_protocol.ts` — HeadlessMessage, HeadlessServerMessage type definitions
- `src/logging/headless_adapter.ts` — Client-side adapter with reconnection, buffering, prompt racing
- `src/logging/tunnel_protocol.ts` — TunnelMessage types
- `src/logging/structured_messages.ts` — All 29 StructuredMessage types
- `src/tim/headless.ts` — URL resolution, session info building, command integration helpers
- `scripts/manual-headless-prompt-harness.ts` — Reference WebSocket server implementation

### 2. Structured Message Types (29 types)

All messages extend `StructuredMessageBase { timestamp: string; transportSource?: 'tunnel' }`.

**Agent Lifecycle:** `agent_session_start` (executor, mode, planId, tools, mcpServers), `agent_session_end` (success, durationMs, costUsd, turns, summary), `agent_iteration_start` (iterationNumber, taskTitle), `agent_step_start` (phase, message), `agent_step_end` (phase, success, summary)

**LLM Interaction:** `llm_thinking` (text), `llm_response` (text, isUserRequest), `llm_tool_use` (toolName, inputSummary, input), `llm_tool_result` (toolName, resultSummary, result), `llm_status` (status, detail, source)

**Task Management:** `todo_update` (items with label/status, source, explanation), `task_completion` (taskTitle, planComplete)

**File Operations:** `file_write` (path, lineCount), `file_edit` (path, diff), `file_change_summary` (changes with path/kind/diff, id, status)

**Command Execution:** `command_exec` (command, cwd), `command_result` (command, cwd, exitCode, stdout, stderr)

**Review:** `review_start` (executor, planId), `review_result` (verdict, issues, recommendations, actionItems)

**Progress:** `workflow_progress` (message, phase), `failure_report` (summary, requirements, problems, solutions), `execution_summary` (summary: ExecutionSummary)

**Tokens:** `token_usage` (inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens, rateLimits)

**User Interaction:** `input_required` (prompt), `user_terminal_input` (content, source), `prompt_request` (requestId, promptType, promptConfig, timeoutMs), `prompt_answered` (requestId, promptType, value, source)

**Discovery:** `plan_discovery` (planId, title), `workspace_info` (workspaceId, path, planFile)

**Prompt types:** `input`, `confirm`, `select`, `checkbox`, `prefix_select`

**PromptConfig:** `{ message, header?, question?, default?, choices?: PromptChoiceConfig[], pageSize?, command?, validationHint? }`

**PromptChoiceConfig:** `{ name, value, description?, checked? }`

### 3. HTTP Notification Endpoint

The macOS tim-gui app also accepts HTTP POST to `/messages` on port 8123 for fire-and-forget notification messages. The payload format is:
```typescript
interface MessagePayload {
  message: string;
  workspacePath: string;
  gitRemote: string | null;
  terminal?: { type: string; pane_id: string };
}
```

This is separate from the `sendNotification()` function in `src/tim/notifications.ts`, which spawns a subprocess. The HTTP endpoint is used by external tools to display one-off messages in the GUI without establishing a full WebSocket session.

**Important:** The agent-side code does NOT currently send HTTP POST notifications to port 8123. This endpoint is for external tooling. The `sendNotification()` in `notifications.ts` spawns a configurable shell command with JSON on stdin — it's a completely different mechanism. The HTTP `/messages` endpoint is purely a GUI feature.

### 4. Existing Web Interface Patterns

The SvelteKit app follows consistent patterns established by Plans (228) and Active Work (230):

**Route structure:** `/projects/[projectId]/{tab}` where tab is `sessions`, `active`, or `plans`

**Component patterns (Svelte 5 runes):**
- Props: `let { prop }: { prop: Type } = $props()`
- State: `let x = $state(initialValue)`
- Derived: `let x = $derived(expr)` or `$derived.by(() => { ... })` for multi-statement
- Snippets for children: `let { children }: { children: Snippet } = $props()`

**Data loading:** Server load functions use `await parent()` to access parent layout data, `getServerContext()` for DB access. All DB operations are synchronous (bun:sqlite).

**Layout pattern:** Split-pane with fixed-width left sidebar + flex-1 right content area. The Active Work tab at `src/routes/projects/[projectId]/active/+layout.svelte` is the best reference — it has a left pane with list and a right pane for detail.

**Styling:** Tailwind CSS utility classes throughout. Color palette: gray (default), blue (active/primary), amber (warnings), green (success), red (errors), purple (deferred), orange (warnings).

**Server context singleton:** `src/lib/server/init.ts` provides lazy `getServerContext()` returning `{ config, db }`.

### 5. Reference WebSocket Server Implementation

The `scripts/manual-headless-prompt-harness.ts` provides a complete reference for a Bun WebSocket server on port 8123:
- Uses `Bun.serve()` with `fetch()` for HTTP/upgrade and `websocket` handlers
- Handles `/tim-agent` path for WebSocket upgrade
- Parses `HeadlessMessage` types: `session_info`, `output`, `replay_start`, `replay_end`
- Extracts `TunnelMessage` from output, then `StructuredMessage` from structured tunnel messages
- Tracks active prompts by requestId
- Sends `HeadlessPromptResponseServerMessage` back to agents

### 6. HeadlessAdapter Client Behavior

The agent-side `HeadlessAdapter` (`src/logging/headless_adapter.ts`):
- Reconnects automatically every 5 seconds when disconnected
- Buffers up to 10MB of output messages
- On reconnection, replays full history (session_info → replay_start → history → replay_end)
- Pending prompts survive WebSocket disconnects (only rejected on adapter destroy)
- Each output message gets an incrementing `seq` number
- Prompt errors from server do NOT reject the promise — terminal continues as fallback

**Implications for our server:**
- Each WebSocket connection creates a new session (no reconnection merging for now — the common case is server restart, not agent reconnect)
- Replay messages during `replay_start`..`replay_end` should be added to the session's message list but NOT emitted as new SSE events to browser clients
- Prompt responses may come from terminal — server receives `prompt_answered` message indicating source

### 7. Session Grouping

The macOS app groups sessions by `sessionGroupKey(gitRemote, workspacePath)`. Each group can have multiple sessions (multiple agent runs in the same workspace). Sessions within a group are distinguished by their WebSocket connection.

### 8. Testing Patterns

Tests use:
- `vitest` with real database fixtures (no mocking DB)
- `openDatabase(':memory:')` or temp directory with `fs.mkdtemp()` for isolated DB
- `afterEach(() => db.close(false))` for cleanup
- `ModuleMocker` for mocking modules without cross-file contamination
- Assertions required: `expect.requireAssertions: true` in vitest config
- Reference test: `src/lib/server/db_queries.test.ts`

For WebSocket/SSE testing, we can test the session manager and message formatting logic directly without needing a real WebSocket connection.

## Implementation Guide

### Architecture Overview

```
Browser ←── SSE ──→ SvelteKit Routes ←── EventEmitter ──→ Session Manager
                         ↕ POST                              ↕ WebSocket
                    SvelteKit API                        Bun.serve(:8123)
                                                            ↕
                                                        Tim Agents
```

The WebSocket server (Bun.serve on 8123) and Session Manager are singletons started from `hooks.server.ts` `init` function when the SvelteKit server boots. The SSE endpoint subscribes to the Session Manager's event emitter. Browser POST endpoints for prompt responses and user input call through to the Session Manager which forwards to the appropriate WebSocket connection. The SSE connection is established from the root `+layout.svelte` so it stays open across all tab switches.

### Design Decisions (from refinement)

- **Session identity**: Each WebSocket connection creates a new session. No reconnection merging (common case is server restart, not agent reconnect).
- **WS port configuration**: Read from the `headless.url` config to determine the port, with a `TIM_WS_PORT` env var override for testing.
- **WS server start**: Started from `hooks.server.ts` `init` function (not lazy from `getServerContext()`).
- **SSE scope**: Single global SSE endpoint streams all sessions. Client filters/sorts locally.
- **Session filtering**: Sessions tab shows ALL sessions regardless of selected project. Current project's sessions are sorted to the top.
- **Project resolution**: Server matches session `gitRemote` against DB projects to include `projectId` in SSE data.
- **SSE always-on**: SSE connection established in root `+layout.svelte` — stays open across tab switches to support future notification badges.
- **Prompt position**: Fixed above the scrollable message area, not inline in transcript.
- **Input bar visibility**: Hidden for non-interactive and offline sessions (not just disabled).
- **Auto-scroll**: Scroll-position-based — active when at bottom, disabled when user scrolls up, resumes on scroll to bottom.
- **Message truncation**: Long content (tool inputs/outputs, diffs, command output) truncated by default with expandable reveal.
- **Debug messages**: Suppressed (not shown in transcript).
- **Compact messages**: `token_usage` and `llm_status` rendered as single-line compact summaries.
- **Non-structured messages**: `log`/`error`/`warn`/`stdout`/`stderr` tunnel messages shown, styled normally, args joined with spaces.
- **Notification sessions**: HTTP POST `/messages` creates a minimal session with "notification" status and a single message.
- **Session cleanup**: Offline/notification sessions persist until server restart. Manual dismiss button available.
- **HMR**: Accept that Vite HMR may restart the WS server during dev; agents auto-reconnect.

### Step 1: Session Manager Core (server-side singleton)

**Create `src/lib/server/session_manager.ts`**

This is the central state management module. It should:

1. Define `SessionData` type:
   - `connectionId`: unique UUID per WebSocket connection
   - `sessionInfo`: HeadlessSessionInfo (command, planId, planTitle, workspacePath, gitRemote, interactive, etc.)
   - `status`: 'active' | 'offline' | 'notification'
   - `projectId`: number | null (resolved by matching gitRemote against DB project remote_url)
   - `messages`: array of `DisplayMessage` (formatted for UI display)
   - `activePrompt`: current pending prompt (if any) — { requestId, promptType, promptConfig, timeoutMs }
   - `isReplaying`: boolean (true during replay_start..replay_end)
   - `groupKey`: string (derived from gitRemote + workspacePath)
   - `connectedAt`: timestamp
   - `disconnectedAt`: timestamp | null

2. Define `DisplayMessage` type — the UI-ready representation of a message:
   - `id`: unique message ID (could use seq number + connectionId)
   - `seq`: sequence number from the agent
   - `timestamp`: ISO string
   - `category`: message category for color coding
   - `bodyType`: 'text' | 'monospaced' | 'todoList' | 'fileChanges' | 'keyValuePairs'
   - `body`: the rendered content (varies by bodyType)
   - `rawType`: the original StructuredMessage type string

3. Define message categorization function `categorizeMessage(msg: StructuredMessage)`:
   - Map each of the 29 message types to a category and body type
   - Categories: `lifecycle`, `llmOutput`, `toolUse`, `fileChange`, `command`, `progress`, `error`, `log`, `userInput`
   - Body type extraction: most are `text`, but `todo_update` → `todoList`, `file_change_summary` → `fileChanges`, `llm_tool_use`/`llm_tool_result` with structured data → `keyValuePairs`, `llm_thinking` → `monospaced`, etc.

4. Maintain state:
   - `sessions: Map<string, SessionData>` keyed by connectionId
   - `notificationSessions: Map<string, SessionData>` for HTTP-only sessions
   - EventEmitter pattern for broadcasting to SSE consumers

5. Methods:
   - `handleWebSocketMessage(connectionId, message: HeadlessMessage)` — process incoming agent messages
   - `handleWebSocketConnect(connectionId)` / `handleWebSocketDisconnect(connectionId)`
   - `handleHttpNotification(payload: MessagePayload)` — create/update notification-only session
   - `sendPromptResponse(connectionId, requestId, value)` — forward to agent WebSocket
   - `sendUserInput(connectionId, content)` — forward to agent WebSocket
   - `dismissSession(connectionId)` — remove offline session from list
   - `getSessionSnapshot()` — return current state for SSE initial snapshot
   - `subscribe(listener)` / `unsubscribe(listener)` — SSE consumer management

6. Event types emitted:
   - `session:new` — new session connected
   - `session:update` — session info updated
   - `session:disconnect` — session went offline
   - `session:message` — new message in a session
   - `session:prompt` — new prompt waiting for response
   - `session:prompt-cleared` — prompt answered or cancelled
   - `session:dismissed` — offline session removed

**Testing:** Test message categorization, session lifecycle (connect → messages → disconnect), replay buffering (messages during replay_start..replay_end are added but not flagged as new), prompt tracking, and notification-only sessions.

### Step 2: WebSocket Server

**Create `src/lib/server/ws_server.ts`**

A Bun.serve() WebSocket server on port 8123 that:

1. Handles WebSocket upgrade for `GET /tim-agent` path
2. Handles HTTP POST for `/messages` (notification endpoint)
3. Returns 404 for other paths

Reference the `scripts/manual-headless-prompt-harness.ts` for the Bun.serve() pattern.

Key implementation details:
- Generate a unique connectionId (UUID) for each WebSocket connection
- Store WebSocket reference in a Map for sending responses back
- Parse incoming messages as `HeadlessMessage` and delegate to SessionManager
- On WebSocket close, notify SessionManager
- For HTTP POST `/messages`, parse body as `MessagePayload` and delegate to SessionManager

**Port configuration:**
- Check `TIM_WS_PORT` env var first (useful for testing)
- Otherwise parse port from `headless.url` config or `TIM_HEADLESS_URL` env var
- Fall back to default port 8123

**Lifecycle management:**
- Create `startWebSocketServer(sessionManager, port)` function that starts the server and returns a cleanup function
- Started from `hooks.server.ts` `init` function (not from `getServerContext()`)
- Store WebSocket references in a Map for sending prompt_response and user_input back to agents

**Testing:** Test WebSocket message parsing, HTTP notification handling, connection lifecycle. Can test the parsing/routing logic without a real WebSocket by mocking the socket interface.

### Step 3: SSE Endpoint

**Create `src/routes/api/sessions/events/+server.ts`**

SSE endpoint that:
1. On connect, sends initial snapshot of all sessions via `session:list` event
2. Subscribes to SessionManager events and forwards them as SSE events
3. On client disconnect, unsubscribes from SessionManager

SSE event format:
```
event: session:list
data: {"sessions": [...]}

event: session:message
data: {"connectionId": "...", "message": {...}}

event: session:prompt
data: {"connectionId": "...", "prompt": {...}}
```

Use SvelteKit's `+server.ts` pattern with a `GET` handler that returns a `ReadableStream` with proper SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`).

### Step 4: Action API Endpoints

**Create API routes for browser→server actions:**

- `src/routes/api/sessions/[connectionId]/respond/+server.ts` — POST: Send prompt response
  - Body: `{ requestId: string, value: unknown }`
  - Delegates to SessionManager.sendPromptResponse()

- `src/routes/api/sessions/[connectionId]/input/+server.ts` — POST: Send user input
  - Body: `{ content: string }`
  - Delegates to SessionManager.sendUserInput()

- `src/routes/api/sessions/[connectionId]/dismiss/+server.ts` — POST: Dismiss offline session
  - Delegates to SessionManager.dismissSession()

### Step 5: Client-Side Session Store

**Create `src/lib/stores/session_state.svelte.ts`**

A Svelte 5 runes-based reactive store that:
1. Manages SSE connection with auto-reconnect (started from root `+layout.svelte`, stays open across all tabs)
2. Maintains reactive `$state` for sessions, messages, prompts
3. Groups sessions by project using server-provided `projectId`, with current project's group sorted to top
4. Resolves group labels: project display name from DB when projectId matches, fall back to workspace path
5. Provides methods for sending prompt responses and user input via fetch POST

Key state:
- `sessions: Map<string, SessionData>` — all known sessions
- `selectedSessionId: string | null` — currently selected session
- `connectionStatus: 'connected' | 'reconnecting' | 'disconnected'`

Derived state:
- `sessionGroups: SessionGroup[]` — sessions grouped by project with configurable sort (current project first)

SSE event handlers update `$state` directly, which triggers Svelte reactivity. The store exposes a `connect()` / `disconnect()` lifecycle and a `setCurrentProjectId(id)` method for sorting groups.

### Step 6: Sessions View UI

**Replace `src/routes/projects/[projectId]/sessions/+page.svelte`** with the full Sessions view.

Consider the route structure:
- The sessions view doesn't need server-side data loading (all data comes via SSE)
- But it does need a layout structure similar to active/plans for the split-pane

**Layout:** Split-pane matching other tabs:
- Left pane (w-96): Grouped session list
- Right pane (flex-1): Selected session's message transcript + input bar

**Components to create:**

1. **`src/lib/components/SessionList.svelte`** — Grouped session sidebar
   - Groups collapsed/expanded by project
   - Each session row shows: command, plan info (if any), status indicator (green dot for active, gray for offline)
   - Highlight selected session

2. **`src/lib/components/SessionRow.svelte`** — Individual session row
   - Status indicator dot (green = active, gray = offline)
   - Command name (agent, review, generate, chat)
   - Plan title/ID if available
   - Workspace path (last 2 components)

3. **`src/lib/components/SessionDetail.svelte`** — Message transcript view
   - Session header with metadata (command, plan, workspace, status)
   - Scrollable message list with scroll-position-based auto-scroll (active at bottom, disabled when user scrolls up)
   - Message rendering delegated to SessionMessage component
   - Fixed-position prompt renderer above the scrollable area (always visible when prompt is active)
   - Message input bar at the bottom, hidden for non-interactive and offline sessions

4. **`src/lib/components/SessionMessage.svelte`** — Individual message renderer
   - Apply category-based text color
   - Render by body type:
     - **text**: Simple colored text with timestamp
     - **monospaced**: Preformatted code block (for llm_thinking, command output)
     - **todoList**: List items with status icons (✓ = completed, → = in_progress, ○ = pending, ✗ = blocked/error, ? = unknown)
     - **fileChanges**: File paths with change indicators (+ added, ~ modified, - removed)
     - **keyValuePairs**: Two-column table for structured metadata

5. **`src/lib/components/PromptRenderer.svelte`** — Interactive prompt display
   - **confirm**: Two buttons (Yes / No) with default highlighted
   - **input**: Text field with submit button, optional default value and validation hint
   - **select**: Radio button group from choices
   - **checkbox**: Checkbox group from choices with pre-checked options
   - All send response via the store's sendPromptResponse method
   - Show header and question fields from promptConfig if present

6. **`src/lib/components/MessageInput.svelte`** — User input bar
   - Text input with Enter to send, Shift+Enter for newlines
   - Hidden (not just disabled) when session is offline or non-interactive
   - Sends via store's sendUserInput method

### Step 7: Message Category Color Mapping

Define consistent color mapping in a shared utility:

```typescript
const categoryColors = {
  lifecycle: 'text-green-400',
  llmOutput: 'text-green-400',
  toolUse: 'text-cyan-400',
  fileChange: 'text-cyan-400',
  command: 'text-cyan-400',
  progress: 'text-blue-400',
  error: 'text-red-400',
  log: 'text-gray-300',
  userInput: 'text-orange-400',
};
```

### Step 8: Message Categorization Logic

Map each StructuredMessage type to a category and body type:

| Message Type | Category | Body Type |
|---|---|---|
| agent_session_start/end | lifecycle | text |
| agent_iteration_start | lifecycle | text |
| agent_step_start/end | lifecycle | text |
| llm_thinking | llmOutput | monospaced |
| llm_response | llmOutput | text |
| llm_tool_use | toolUse | keyValuePairs (or text if no input) |
| llm_tool_result | toolUse | text (summary) |
| llm_status | progress | text |
| todo_update | progress | todoList |
| task_completion | progress | text |
| file_write | fileChange | text |
| file_edit | fileChange | monospaced (diff) |
| file_change_summary | fileChange | fileChanges |
| command_exec | command | monospaced |
| command_result | command | monospaced (if output) |
| review_start | lifecycle | text |
| review_result | lifecycle | text |
| workflow_progress | progress | text |
| failure_report | error | text |
| execution_summary | lifecycle | keyValuePairs |
| token_usage | progress | keyValuePairs |
| input_required | lifecycle | text |
| user_terminal_input | userInput | text |
| prompt_request | lifecycle | text (displayed inline as prompt UI) |
| prompt_answered | lifecycle | text |
| plan_discovery | lifecycle | text |
| workspace_info | lifecycle | text |

**Compact messages:** `token_usage` and `llm_status` should be rendered as single-line compact summaries (not full key-value tables).

**Non-structured TunnelMessages:** `log` → `log` category, `error`/`warn` → `error` category, `stdout`/`stderr` → `log` category with monospaced body. Args joined with spaces. `debug` messages are suppressed (not shown).

### Manual Testing Steps

1. Start dev server (`bun run dev`) — verify Sessions tab loads
2. Start a tim agent with `TIM_HEADLESS_URL=ws://localhost:5173/...` or default port 8123
3. Verify session appears in Sessions tab in real-time
4. Verify messages stream in with correct colors and formatting
5. Trigger a prompt from agent — verify prompt UI appears in browser
6. Respond to prompt from browser — verify agent receives response
7. Send free-form input to interactive session
8. Disconnect agent — verify session shows as offline
9. Reconnect agent — verify session reconnects and replays history
10. Test with multiple simultaneous sessions
11. Test SSE reconnection by reloading browser tab
12. Send HTTP POST to /messages endpoint — verify notification appears

### Potential Gotchas

- **Bun.serve() port conflict**: Port 8123 will conflict if tim-gui macOS app is running. Only one should run at a time.
- **SSE connection limits**: Browsers limit ~6 concurrent SSE connections per domain. Using a single SSE endpoint for all session data avoids this.
- **Prompt race conditions**: A prompt may be answered from terminal (agent-side). The server receives a `prompt_answered` message and must broadcast prompt cancellation to all SSE listeners.
- **Replay handling**: Each new WebSocket connection creates a new session. Messages during `replay_start`..`replay_end` are added to the session's message list but not emitted as SSE events. After `replay_end`, new messages are emitted normally.
- **Message ordering**: Messages have sequence numbers. The UI should display messages in seq order even if SSE delivery is slightly out of order.
- **Large message payloads**: `llm_tool_result` can contain large raw results. Truncate in the display and render with expandable reveal.
- **WebSocket server lifecycle**: Must start before agents connect. Started from `hooks.server.ts` `init` function.
- **SvelteKit dev vs prod**: In dev mode, Vite HMR may restart the WS server. Agents auto-reconnect within 5 seconds. Accept this limitation.

## Current Progress
### Current State
- All 17 tasks complete. Plan is done.
### Completed (So Far)
- Task 1: Session manager core (`src/lib/server/session_manager.ts`) with all 29 structured message types categorized, replay buffering, prompt tracking, notification session reconciliation, project resolution from DB
- Task 2: WebSocket server (`src/lib/server/ws_server.ts`) with Bun.serve() on configurable port/path, WS upgrade, HTTP POST `/messages` for notifications, structural validation of HeadlessMessage types
- Task 3: SvelteKit hooks.server.ts init function starts WS server on boot, session context singleton (`src/lib/server/session_context.ts`) with Symbol.for for HMR survival
- Task 4: SSE endpoint (`src/routes/api/sessions/events/+server.ts`) with shared helpers in `src/lib/server/session_routes.ts`. Subscribe-before-snapshot pattern with buffering to avoid race conditions.
- Task 5: Action API routes (`respond`, `input`, `dismiss` under `src/routes/api/sessions/[connectionId]/`). Prompt response validates against active prompt requestId and requires `value` field.
- Task 6: Client-side session store (`src/lib/stores/session_state.svelte.ts`) with SSE connection management, auto-reconnect, SvelteMap-based reactive sessions, sessionGroups derived state
- Task 7: Sessions page with split-pane layout, SessionList with collapsible groups, SessionRow with status dot/command/plan/workspace path/dismiss
- Task 8: SessionDetail with session header, auto-scroll message list, prompt area, input bar. SessionMessage with rich rendering for all body types and truncation.
- Task 9: PromptRenderer for confirm/input/select/checkbox prompts. MessageInput with Enter to send, Shift+Enter for newlines, hidden when offline/non-interactive.
- Task 10: Integration tests (78 total) covering full WS→Manager→SSE flow, replay suppression, prompt lifecycle, notification reconciliation, URL-encoded connectionIds, WS server HTTP endpoints. Bug fixes for prompt_answered race condition, notification merge into active-only sessions, notification reconciliation message delivery to SSE clients.
- Task 11: Malformed structured tunnel messages handled defensively — default case in `summarizeStructuredMessage()`, try/catch in ws_server message handler, null guard on `handleStructuredSideEffects()` for missing nested message
- Task 12: WS session messages capped at MAX_SESSION_MESSAGES (5000) with `trimSessionMessages()` helper
- Task 13: `getSessionSnapshot()` caps messages per session at MAX_SNAPSHOT_MESSAGES (500), stale TODO comment updated
- Task 14: Notification message IDs use monotonic per-session counter (`nextNotificationId` in SessionInternals) instead of `messages.length`
- Task 15: SIGTERM/SIGINT shutdown handlers registered in hooks.server.ts, call `serverHandle.stop()` then `process.exit(0)`, with HMR-safe cleanup via Symbol.for singleton
- Task 16: Replay prompt suppression fixed — prompts deferred to internal state during replay, stripped from snapshots/clones while `isReplaying`, UI guard in SessionDetail, sendPromptResponse rejects during replay
- Task 17: Client-side message optimization — push instead of spread for O(1) append, client-side cap at 5000 messages, extracted SSE event logic to `session_state_events.ts` with comprehensive tests for all 8 event types
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- `llm_tool_result` renders as `text` body type (using resultSummary) rather than `keyValuePairs`, to handle large result payloads gracefully
- Notification sessions have a message cap of 200 to prevent unbounded growth
- Sender sends are wrapped in try/catch for resilience against closed sockets
- New prompt_request clears any existing active prompt before setting the new one
- Session manager uses `setMaxListeners(0)` on EventEmitter to support multiple SSE clients
- Notification sessions are reconciled when a WS session with the same group key connects; reconciled messages are re-emitted as session:message events for SSE clients
- HTTP notifications only merge into active WS sessions (not offline ones) to avoid burying notifications in stale transcripts
- `prompt_answered` only clears prompt when requestId matches the active prompt (prevents stale answers from clearing newer prompts)
- `sendPromptResponse` validates requestId against activePrompt, clears prompt on success, and emits `session:prompt-cleared`
- SSE subscribes before taking snapshot to avoid lost-event race window, with event buffering during snapshot delivery
- Respond endpoint requires `value` field to prevent sending undefined to agents
- Session:update and session:disconnect SSE events use `cloneSessionMetadata` (empty messages array) to reduce payload size; client preserves local messages when server sends empty array
- Client-side action URLs use `base` from `$app/paths` (not `resolve()`) to avoid SvelteKit typed route constraints
- Client-side action URLs encode connectionId to handle notification IDs containing `/`
- SessionDetail uses `{#key}` on connectionId for remount; PromptRenderer uses `{#key}` on requestId for state reset
- SessionRow uses `<div>` instead of `<button>` to avoid nested interactive elements (dismiss button inside row)
- WS server validates HeadlessMessage types structurally (known type string, required fields for output messages) before dispatching to SessionManager
- `isRecord` type guard excludes arrays
- WS server tests use port 0 (OS-assigned) to avoid TOCTOU port allocation flakiness
- WS server honors full configured headless URL pathname (not hardcoded `/tim-agent`) so agents with custom URLs connect correctly
- `prompt_answered` emission guarded by whether a prompt was actually cleared, preventing spurious SSE events
- Client-side message cap (MAX_CLIENT_MESSAGES=5000) mirrors server-side cap to prevent unbounded browser memory growth
### Lessons Learned
- SSE ReadableStream cancel() callback must not call controller.close() — the stream is already being torn down by the consumer and will throw
- SSE snapshot+subscribe ordering matters: subscribing after snapshot creates a window where events can be lost. Subscribe first and buffer.
- EventEmitter listeners that throw (e.g. from enqueue on a broken stream) propagate through emit() and can abort event delivery to other listeners — always wrap in try/catch
- SvelteMap only tracks `.set()`/`.delete()`/`.clear()` — mutating nested properties on stored objects does not trigger reactivity. Must re-set the entry after mutation.
- When server events carry both a session payload and a separate message event for the same data, the client will duplicate unless the session payload omits messages
- Notification connectionIds can contain `/` from workspace paths — must URL-encode when building action URLs
- When reconciling notification sessions into WS sessions, metadata-only clones don't carry messages — must explicitly emit session:message events for each merged message
- `prompt_answered` must check requestId before clearing active prompt — stale answers for previous prompts can incorrectly clear newer prompts
- SvelteKit's `resolve()` from `$app/paths` enforces typed route parameters — use `base` + template literals for dynamic paths
- Bun.serve() accepts port 0 for OS-assigned ports; `isValidPort` must allow 0 for test flexibility
- TypeScript exhaustive switch statements return `undefined` for unknown runtime values rather than throwing — a try/catch around the call won't help unless you add a `default` case that throws or returns a fallback
- Registering custom SIGTERM/SIGINT handlers suppresses default termination — must call `process.exit()` explicitly or the process may hang
- When testing shutdown handlers that call `process.exit()`, must spy on and mock `process.exit` to prevent the test process from actually exiting
- When a server listens on a hardcoded path but the agent connects to a configurable URL, the paths must match — always derive the server listen path from the same URL the agent uses
- Guarding event emission on whether state actually changed prevents spurious SSE broadcasts (e.g. prompt_answered for non-matching requestId)
- Extracting SSE event application logic from Svelte stores into plain TS functions makes it testable without Svelte runtime
### Risks / Blockers
- None
