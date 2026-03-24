---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: tim web gui connects to websocket server of tim processes
goal: ""
id: 223
uuid: 9414fc10-17e6-44de-b2bb-ba6feb2acf62
generatedBy: agent
status: done
priority: medium
dependencies:
  - 222
parent: 221
references:
  "221": 8d41284b-b510-4713-bd21-2db13687f2e5
  "222": 80e8e677-777a-4917-9d42-984dfca6d8f3
planGeneratedAt: 2026-03-24T02:05:00.457Z
promptsGeneratedAt: 2026-03-24T02:05:00.457Z
createdAt: 2026-03-07T07:52:33.763Z
updatedAt: 2026-03-24T04:51:43.729Z
tasks:
  - title: Add sessionId to HeadlessSessionInfo and planUuid to SessionInfoFile
    done: true
    description: "Add sessionId?: string to HeadlessSessionInfo in
      src/logging/headless_protocol.ts. Add planUuid?: string to SessionInfoFile
      in src/tim/session_server/runtime_dir.ts and update parseSessionInfoFile()
      to validate it as an optional string. Update buildSessionInfoFile() in
      src/logging/headless_adapter.ts to include sessionId and planUuid from
      sessionInfo. Update the session_info broadcast in
      sendReplayToServerClient() and broadcastSessionInfo() to include
      sessionId."
  - title: Create SessionDiscoveryClient class
    done: true
    description: "Create src/lib/server/session_discovery.ts with a
      SessionDiscoveryClient class. Constructor takes a SessionManager instance.
      On start(): performs initial scan of getTimSessionDir() using
      listSessionInfoFiles(), connects to each valid alive process, sets up
      fs.watch() on the session directory with debounced re-scan (500ms), and
      starts a periodic reconciliation poll (30s). On stop(): closes all
      outgoing WebSocket connections, stops fs.watch(), clears timers. On
      directory change: re-scan with listSessionInfoFiles(), diff against
      tracked connections, connect to new PIDs, disconnect removed PIDs. On
      reconciliation: check PID liveness for all tracked connections via
      process.kill(pid, 0), clean up dead connections and remove stale PID
      files."
  - title: Implement WebSocket client connection management in SessionDiscoveryClient
    done: true
    description: "For each discovered SessionInfoFile: check PID liveness, skip if
      already connected to this PID, skip with warning if info.token is true,
      create WebSocket client to ws://127.0.0.1:{port}/tim-agent, use sessionId
      from PID file as connectionId. On open: call
      sessionManager.handleWebSocketConnect(connectionId, senderCallback). On
      message: parse with parseHeadlessMessage(), call
      sessionManager.handleWebSocketMessage(). On close: call
      sessionManager.handleWebSocketDisconnect(), remove from tracked
      connections. On error with connection refused: retry with exponential
      backoff (100ms to 5s). Handle HMR: if a session with the same connectionId
      already exists in SessionManager (from before HMR), dismiss the old
      offline session before creating a new connection. Track mapping: PID -> {
      connectionId, ws, sessionInfoFile }."
  - title: Integrate SessionDiscoveryClient into hooks.server.ts
    done: true
    description: Update src/hooks.server.ts to create and start a
      SessionDiscoveryClient after the WebSocket server is initialized. Keep the
      existing startWebSocketServer() call. Store the discovery client in
      session_context.ts via new
      getSessionDiscoveryClient()/setSessionDiscoveryClient() accessors. Update
      shutdown handlers to also call discoveryClient.stop(). Add the discovery
      client handle to the SessionContextState interface in session_context.ts.
      Follow the same HMR-safe singleton pattern using Symbol.for().
  - title: Remove WebSocket client code from HeadlessAdapter
    done: true
    description: "Remove the WebSocket client connection logic from
      src/logging/headless_adapter.ts: remove the client WebSocket connection to
      TIM_HEADLESS_URL, remove reconnection logic and connection state machine
      (disconnected/connecting/connected/draining states), remove the drain loop
      that sends queued messages over the client WebSocket, remove the queue
      (keep only the history buffer for replay to server-connected clients).
      Keep: embedded server mode, message history/buffering, replay logic
      (sendReplayToServerClient), updateSessionInfo(), destroy(). Ensure
      messages arriving during replay to a new server client are not lost —
      verify the synchronous replay + subsequent broadcast pattern handles this.
      When TIM_NO_SERVER=1, the adapter just buffers messages internally with no
      external visibility."
  - title: Update headless.ts integration functions
    done: true
    description: "Update src/tim/headless.ts: remove resolveHeadlessUrl() usage for
      client connections (keep the function itself since ws_server.ts still uses
      it), simplify createHeadlessAdapter() to only configure server options,
      remove TIM_HEADLESS_URL env var handling from the adapter setup. The
      adapter now always runs an embedded server by default (unless
      TIM_NO_SERVER=1). Keep TIM_SERVER_PORT, TIM_SERVER_HOSTNAME,
      TIM_WS_BEARER_TOKEN env var handling for the embedded server."
  - title: Unit tests for SessionDiscoveryClient
    done: true
    description: "Create src/lib/server/session_discovery.test.ts. Test: discovery
      of existing PID files on startup, connection to discovered processes (use
      startEmbeddedServer from plan 222), PID liveness check with dead
      processes, stale PID file cleanup (removes file for dead PIDs), directory
      watching triggers re-scan on new PID file, removed PID file triggers
      disconnection, reconnection on transient connection failure with backoff,
      processes with token: true are skipped with warning, stop() cleans up all
      WebSocket connections and watchers, HMR scenario where old offline session
      exists with same connectionId."
  - title: Integration tests for full discovery-to-session flow
    done: true
    description: "Test the full end-to-end flow: start an embedded server using
      startEmbeddedServer(), write a PID file using writeSessionInfoFile(),
      create a SessionManager and SessionDiscoveryClient, verify discovery
      client connects and SessionManager receives session_info + replay
      messages, send output messages from the embedded server and verify
      SessionManager receives them as DisplayMessages, send prompt response via
      SessionManager and verify the embedded server receives it, remove the PID
      file and verify the session transitions to offline, verify cleanup on
      stop()."
  - title: Update HeadlessAdapter tests for client removal
    done: true
    description: "Update existing tests in src/logging/headless_adapter.test.ts:
      remove tests for client WebSocket connection, reconnection, and drain
      logic. Verify the adapter works in server-only mode (starts embedded
      server, writes PID file, broadcasts to connected clients, replays
      history). Verify TIM_NO_SERVER=1 disables the server and the adapter
      buffers messages locally. Verify sessionId is included in session_info
      broadcasts. Verify planUuid is included in PID file. Also update
      src/tim/headless.test.ts to remove client URL resolution tests."
  - title: Update documentation
    done: true
    description: Update docs/web-interface.md to document the SessionDiscoveryClient
      alongside the existing WebSocket server. Update CLAUDE.md session server
      description to mention both connection modes (agents discovered via PID
      files, WebSocket server kept for notifications). Update README to document
      the new session discovery mechanism and the removal of the agent-to-GUI
      client connection.
changedFiles:
  - CLAUDE.md
  - README.md
  - docs/web-interface.md
  - src/common/input.test.ts
  - src/hooks.server.ts
  - src/lib/server/session_context.ts
  - src/lib/server/session_discovery.test.ts
  - src/lib/server/session_discovery.ts
  - src/logging/headless_adapter.test.ts
  - src/logging/headless_adapter.ts
  - src/logging/headless_protocol.ts
  - src/logging/send_structured.e2e.test.ts
  - src/tim/commands/review.notifications.test.ts
  - src/tim/headless.ts
  - src/tim/session_server/runtime_dir.test.ts
  - src/tim/session_server/runtime_dir.ts
tags: []
---

Add a session discovery client to tim-gui that scans the well-known directory defined in plan 222 for tim processes and connects to their embedded WebSocket servers. The existing WebSocket server in tim-gui is kept but agents no longer connect to it — the WebSocket client code in HeadlessAdapter is removed. From there the data protocol is the same.

## Expected Behavior/Outcome

After this change, agent processes no longer connect to the GUI's WebSocket server as clients. Instead, the GUI discovers agents and connects to them. The WebSocket server (port 8123) is kept for the notification endpoint and future use. The GUI now:

1. **Scans** the well-known session directory (`~/.cache/tim/sessions/`) for `SessionInfoFile` JSON files written by running tim processes (plan 222).
2. **Connects** as a WebSocket client to each discovered tim process's embedded server.
3. **Receives** the same `HeadlessMessage` protocol (session_info, replay_start/end, output) from each process.
4. **Sends** `HeadlessServerMessage` (prompt_response, user_input, end_session) back through those client connections.
5. **Watches** the session directory for new/removed files using filesystem watching, so new tim processes are auto-discovered and dead ones are cleaned up.

The existing WebSocket server (port 8123) is kept in the web app for future use and the notification endpoint, but agents no longer connect to it as clients. The WebSocket client code in `HeadlessAdapter` is removed — agent processes only run their embedded servers. The discovery client is the sole mechanism for the GUI to find and connect to agents.

Additionally, `sessionId` is added to the `HeadlessSessionInfo`/`session_info` protocol message, and `planUuid` is added to the `SessionInfoFile` interface.

### Relevant States

- **Discovery**: Tim-gui watches the session directory. When a new PID file appears, it reads the file, validates the process is alive (PID check), and initiates a WebSocket client connection to the advertised port.
- **Connected**: WebSocket open to a tim process. Messages flow bidirectionally using the existing protocol. The session appears as "active" in the SessionManager.
- **Replaying**: Upon connection, the tim process sends `replay_start`, history, `replay_end`. During this phase, the session is marked `isReplaying` (same as current behavior).
- **Disconnected/Stale**: If the WebSocket closes or PID file disappears, the session transitions to "offline". Stale PID files (process no longer running) are detected and cleaned up.
- **Reconnecting**: If a connection drops but the PID file still exists and the process is alive, the GUI can attempt reconnection.

## Key Findings

### Product & User Story

As a developer using tim, I want the web GUI to automatically discover and connect to all running tim agent processes on my machine, so that I can monitor and interact with sessions without needing the agent processes to know about the GUI's address. This inverts the connection direction: instead of agents connecting to a known server port, the GUI discovers agents and connects to them. This is a prerequisite for remote workspace support (plans 224-226) where the GUI may not be reachable from agent processes.

### Design & UX Approach

From the user's perspective, this change should be invisible — the Sessions tab continues to show active and offline sessions with the same UI. The key difference is operational: the GUI no longer needs to be running before agent processes start, and agents no longer need to know the GUI's address.

### Technical Plan & Risks

**Core change**: Add a `SessionDiscoveryClient` alongside the existing WebSocket server, and remove the WebSocket client code from `HeadlessAdapter`. The discovery client:
- Watches the session directory for file changes
- Manages WebSocket client connections to discovered processes
- Bridges those connections into the existing `SessionManager` via its `handleWebSocketConnect/Message/Disconnect` API

**Risks**:
- **Stale PID files**: Processes that crash without cleanup leave orphan files. Need PID liveness checks before connecting.
- **Race conditions**: File appearing before the embedded server is ready to accept connections. Need retry logic.
- **Bearer token**: Deferred to remote workspace plans (224-225). For local discovery, agents bind to 127.0.0.1 and no auth is needed. The discovery client should skip PID files with `token: true` for now (or log a warning).
- **Client code removal**: Removing the WebSocket client from HeadlessAdapter is a significant change — need to ensure the embedded server mode still works correctly without the client connection fallback.

### Pragmatic Effort Estimate

Medium complexity. The SessionManager API is already well-factored for receiving connections — the main work is the discovery/client layer and updating initialization code.

## Acceptance Criteria

- [ ] Tim-gui discovers running tim processes by scanning `~/.cache/tim/sessions/` directory
- [ ] Tim-gui connects as a WebSocket client to each discovered process's embedded server
- [ ] Sessions appear in the GUI with full message history (via replay protocol)
- [ ] Prompt responses, user input, and end-session commands flow back to agent processes
- [ ] New tim processes are auto-discovered when their PID files appear
- [ ] Dead processes are detected and sessions marked as offline
- [ ] Stale PID files (crashed processes) are handled gracefully with PID liveness checks
- [ ] Processes with `token: true` in PID file are skipped with a log warning (token auth deferred to remote plans)
- [ ] All new code paths are covered by tests
- [ ] Existing session UI behavior is unchanged from the user's perspective

## Dependencies & Constraints

- **Dependencies**: Plan 222 (tim runs websocket server) — completed. Provides the embedded server, session info files, and runtime directory utilities.
- **Technical Constraints**: Must use the existing `HeadlessMessage`/`HeadlessServerMessage` protocol without changes. Must integrate with the existing `SessionManager` API. The session directory path must match what plan 222 established (`~/.cache/tim/sessions/`).

## Implementation Notes

### Recommended Approach

1. Create a `SessionDiscoveryClient` class in `src/lib/server/` that:
   - Uses `fs.watch()` + periodic reconciliation polling to monitor the session directory
   - Connects to discovered processes as a WebSocket client
   - Feeds messages into `SessionManager.handleWebSocketConnect/Message/Disconnect`
   - Handles stale file cleanup and PID liveness checks
   - Uses the PID file's `sessionId` as the `connectionId` for SessionManager

2. Add the discovery client alongside the existing WebSocket server in `hooks.server.ts`.

3. Remove the WebSocket client code from `HeadlessAdapter` — agents only run embedded servers.

4. Add `sessionId` to `HeadlessSessionInfo` and `planUuid` to `SessionInfoFile`.

5. Keep the session_context.ts singleton pattern, adding a new getter/setter for the discovery client handle.

### Potential Gotchas

- **`fs.watch()` reliability**: Node's `fs.watch` is platform-dependent. On macOS (FSEvents), it works well. On Linux (inotify), it may miss events in edge cases. Consider a hybrid approach: watch + periodic polling as a fallback.
- **Connection timing**: A PID file may be written before the embedded server is actually listening. Need a short retry delay or exponential backoff on connection failure.
- **Message direction**: In the current model, `HeadlessServerMessage` names (prompt_response, user_input, end_session) make sense — the server sends them to the client agent. In the new model, the GUI is the WebSocket *client* sending these same message types to the agent's WebSocket *server*. The naming is confusing but the protocol is unchanged.
- **Multiple GUI instances**: If multiple web GUI instances run simultaneously, they'd all try to connect to the same agent processes. The embedded server already supports multiple clients, so this works, but prompt responses could race.
- **HMR during development**: The discovery client must survive HMR restarts, similar to how the current WebSocket server handle survives via Symbol.for() globals.

## Research

### Overview

This plan inverts the WebSocket connection direction between tim-gui and tim agent processes. Currently, tim-gui runs a WebSocket server (port 8123) and agents connect to it as clients. Plan 222 added embedded WebSocket servers inside each agent process, along with PID-based session discovery files. This plan makes tim-gui scan those discovery files and connect as a WebSocket client to each agent's embedded server.

### Critical Discoveries

1. **The SessionManager is transport-agnostic**: `SessionManager.handleWebSocketConnect(connectionId, sendToAgent)` accepts a connectionId and a callback function for sending messages back. It doesn't care whether the underlying transport is a WebSocket server connection or a WebSocket client connection. This is the key insight — the SessionManager can be reused as-is.

2. **The `AgentSender` callback pattern is perfect for this**: The `trySend()` method just calls `sender(message)` and catches errors. For the new client connections, the sender callback simply becomes `(msg) => ws.send(JSON.stringify(msg))` on the client-side WebSocket.

3. **Replay protocol works from the agent side**: When a client connects to the agent's embedded server, the agent sends `session_info`, `replay_start`, all history, `replay_end`, then streams live. The SessionManager already handles this exact sequence via `handleWebSocketMessage()`. No changes needed.

4. **PID liveness check**: The `SessionInfoFile` contains a `pid` field. Use `process.kill(pid, 0)` (signal 0 = existence check) to verify the process is still running before connecting. This is a common Unix pattern that throws ESRCH if the process doesn't exist.

5. **Bearer token deferred**: PID files store `token: boolean` but not the token value. For this plan, processes with `token: true` are skipped. Bearer token support will be added in the remote workspace plans (224-225).

### Notable Files and Modules

#### Session Discovery Infrastructure (from plan 222)
- **`src/tim/session_server/runtime_dir.ts`**: Provides `getTimSessionDir()`, `listSessionInfoFiles()`, `readSessionInfoFile()`. The `listSessionInfoFiles()` function scans the directory and returns all valid `SessionInfoFile` objects, silently ignoring malformed files.
- **`src/tim/session_server/embedded_server.ts`**: The agent-side server. Listens on `/tim-agent`, supports bearer token auth, multiple clients, broadcast/sendTo.

#### Current Web Server (kept, discovery client added alongside)
- **`src/lib/server/ws_server.ts`**: `startWebSocketServer()` creates a `Bun.serve()` WebSocket server. Kept running for the notification endpoint and future use.
- **`src/hooks.server.ts`**: Currently calls `startWebSocketServer()` in the `init` hook. Will be updated to also start the discovery client.
- **`src/lib/server/session_context.ts`**: Stores the SessionManager and server handle as HMR-safe globals. Will add a getter/setter for the discovery client handle.

#### SessionManager (kept as-is)
- **`src/lib/server/session_manager.ts`**: 1340+ lines. Key methods:
  - `handleWebSocketConnect(connectionId, sendToAgent)` — creates a new session
  - `handleWebSocketMessage(connectionId, message)` — processes HeadlessMessage types
  - `handleWebSocketDisconnect(connectionId)` — marks session offline
  - `sendPromptResponse()`, `sendUserInput()`, `endSession()` — send HeadlessServerMessage via AgentSender callback
  - `handleHttpNotification()` — creates notification sessions from HTTP POST
  - `resolveProjectId()` — maps git remote to project ID
  - `getSessionSnapshot()` — returns all sessions for SSE initial sync

#### Protocol Types
- **`src/logging/headless_protocol.ts`**: `HeadlessMessage` (agent→GUI: session_info, output, replay_start, replay_end) and `HeadlessServerMessage` (GUI→agent: prompt_response, user_input, end_session).
- **`src/logging/headless_message_utils.ts`**: `parseHeadlessMessage()` for validating incoming agent messages. Already used by ws_server.ts.

#### SSE Streaming (unchanged)
- **`src/routes/api/sessions/events/+server.ts`** and **`src/lib/server/session_routes.ts`**: SSE streaming to the browser. These subscribe to SessionManager events and stream them. Completely unchanged by this plan — they don't care how sessions are created.

#### Client-Side (unchanged)
- **`src/lib/stores/session_state.svelte.ts`**: Browser-side SSE client and session state store. Unchanged.
- **`src/lib/remote/session_actions.remote.ts`**: Remote commands for prompt response, user input, etc. These call SessionManager methods, which use the AgentSender callback. Unchanged.

### Architectural Considerations

1. **WebSocket server kept, client code removed**: The GUI's WebSocket server stays running for the notification endpoint and potential future use, but agents no longer connect to it. The WebSocket client code in `HeadlessAdapter` is removed entirely — agents only run their embedded servers. This eliminates any deduplication concern.

2. **Protocol additions**: `sessionId` is added to `HeadlessSessionInfo` so the GUI can correlate the WebSocket session with the PID file. `planUuid` is added to `SessionInfoFile` so it matches what `HeadlessSessionInfo` already provides.

3. **Connection lifecycle**: When a PID file appears, the GUI should:
   a. Read the file and validate contents
   b. Check PID liveness
   c. Connect WebSocket to `ws://127.0.0.1:{port}/tim-agent`
   d. Handle the replay protocol (session_info → replay_start → history → replay_end → live)
   e. Register with SessionManager via `handleWebSocketConnect()`
   f. On disconnect, mark session offline but retain data
   g. On PID file removal, close connection if still open

3. **Directory watching strategy**: Two viable approaches:
   - `fs.watch()` for real-time discovery + periodic `listSessionInfoFiles()` poll as reconciliation
   - Pure polling with configurable interval (simpler, more reliable cross-platform)

4. **Token handling deferred**: Processes with `token: true` in their PID file are skipped by the discovery client. Bearer token authentication will be implemented in the remote workspace plans (224-225).

5. **Cleanup on GUI shutdown**: When the GUI stops, it should close all outgoing WebSocket connections gracefully (send close frame). The agent processes will continue running — they don't depend on the GUI.

## Implementation Guide

### Phase 1: Session Discovery Client

**Step 1: Create the SessionDiscoveryClient class**

Create `src/lib/server/session_discovery.ts` with a `SessionDiscoveryClient` class that:

- Takes a `SessionManager` instance and config options
- On `start()`:
  - Performs initial scan of `getTimSessionDir()` using `listSessionInfoFiles()`
  - For each valid, alive process: initiates WebSocket client connection
  - Sets up directory watching (fs.watch or polling) for new/removed files
- On `stop()`:
  - Closes all outgoing WebSocket connections
  - Stops directory watcher
  - Cleans up timers

**Directory monitoring approach**: Use `fs.watch()` for the session directory. On any change event, re-scan the directory with `listSessionInfoFiles()` and diff against currently-tracked connections. This is simpler and more reliable than trying to parse individual file events. Add a debounce (e.g., 500ms) to avoid scanning on rapid successive events.

Also run a periodic reconciliation poll (e.g., every 30 seconds) that:
- Re-scans the directory
- Checks PID liveness for all tracked connections
- Cleans up connections to dead processes

**Step 2: WebSocket client connection management**

For each discovered `SessionInfoFile`, the discovery client should:

1. Check PID liveness: `process.kill(info.pid, 0)` — returns true if alive, throws ESRCH if dead
2. Check if already connected to this PID (avoid duplicate connections)
3. If `info.token` is true, skip this PID file and log a warning (bearer token auth deferred to remote plans)
4. Create a `WebSocket` client to `ws://127.0.0.1:{info.port}/tim-agent`
5. On WebSocket open:
   - Use the `sessionId` from the PID file as the `connectionId`
   - Call `sessionManager.handleWebSocketConnect(connectionId, senderCallback)` where `senderCallback = (msg) => ws.send(JSON.stringify(msg))`
   - Track the mapping: PID → { connectionId, ws, sessionInfoFile }
6. On WebSocket message:
   - Parse with `parseHeadlessMessage()`
   - Call `sessionManager.handleWebSocketMessage(connectionId, message)`
7. On WebSocket close:
   - Call `sessionManager.handleWebSocketDisconnect(connectionId)`
   - Remove from tracked connections
   - The periodic reconciliation poll will re-discover and reconnect if PID file still exists and process is alive
8. On WebSocket error:
   - Log and handle (may trigger close event)
   - For connection refused errors, retry with backoff (server may not be ready yet)

**Step 3: Stale PID file handling**

When discovering a PID file:
- Call `process.kill(pid, 0)` to check if process exists
- If process is dead: remove the stale PID file (using `removeSessionInfoFile(pid)` from runtime_dir.ts)
- If process is alive but connection fails: retry with exponential backoff (100ms, 200ms, 400ms, up to 5s), then give up and log a warning

### Phase 2: Integration with hooks.server.ts

**Step 4: Add discovery client alongside existing WebSocket server**

Update `src/hooks.server.ts`:
- Keep the existing `startWebSocketServer()` call — the WebSocket server continues to run for backward compatibility and the notification endpoint
- Create and start a `SessionDiscoveryClient` after the server is up
- Store the discovery client handle in `session_context.ts` (add a new getter/setter)
- Update shutdown handlers to also call `discoveryClient.stop()`

Update `src/lib/server/session_context.ts`:
- Add `getSessionDiscoveryClient()` / `setSessionDiscoveryClient()` for the discovery client handle

**Step 5: Add sessionId to HeadlessSessionInfo and planUuid to SessionInfoFile**

Add `sessionId?: string` to `HeadlessSessionInfo` in `src/logging/headless_protocol.ts`. This allows the GUI to correlate the session_info message with the PID file's sessionId.

Add `planUuid?: string` to `SessionInfoFile` in `src/tim/session_server/runtime_dir.ts`. Update `parseSessionInfoFile()` to validate it as an optional string. Update `buildSessionInfoFile()` in `headless_adapter.ts` to include planUuid from sessionInfo.

**Step 6: Remove WebSocket client code from HeadlessAdapter**

Remove the WebSocket client connection logic from `src/logging/headless_adapter.ts`:
- Remove the client WebSocket connection to `TIM_HEADLESS_URL`
- Remove reconnection logic, connection state machine (disconnected/connecting/connected/draining)
- Remove the drain loop that sends queued messages over the client WebSocket
- Keep the embedded server mode, message buffering/history, and replay logic (these serve the server-connected clients)
- Keep `updateSessionInfo()` for updating the PID file and broadcasting to server clients
- Remove `resolveHeadlessUrl()` usage and the `TIM_HEADLESS_URL` env var handling

Also update `src/tim/headless.ts`:
- Remove URL resolution for client connections
- Simplify `createHeadlessAdapter()` to only configure server options
- The adapter now always runs an embedded server (unless `TIM_NO_SERVER=1`, in which case it just buffers locally)

### Phase 3: Testing

**Step 7: Unit tests for SessionDiscoveryClient**

Test `src/lib/server/session_discovery.test.ts`:
- Discovery of existing PID files on startup
- Connection to discovered processes
- PID liveness check (mock `process.kill`)
- Stale file cleanup
- Directory watching triggers re-scan
- New PID file → new connection
- Removed PID file → disconnection
- Reconnection on transient failure
- Processes with `token: true` are skipped
- Stop() cleans up all connections and watchers

**Step 8: Integration tests**

Test the full flow:
- Start an embedded server (using `startEmbeddedServer()` from plan 222)
- Write a PID file
- Start the discovery client
- Verify it connects and receives session_info + replay
- Send messages from the embedded server, verify SessionManager receives them
- Send prompt response via SessionManager, verify embedded server receives it
- Remove PID file, verify session goes offline
- Clean up

**Step 9: Tests for HeadlessAdapter client removal**

Update existing tests in `src/logging/headless_adapter.test.ts`:
- Remove tests for client WebSocket connection, reconnection, and drain logic
- Verify the adapter still works in server-only mode
- Verify `TIM_NO_SERVER=1` disables the server and the adapter still buffers messages locally
- Verify `sessionId` is included in session_info broadcasts
- Verify `planUuid` is included in PID file

### Phase 4: Documentation

**Step 10: Update documentation**

- Update `docs/web-interface.md` to document the discovery client alongside the existing WebSocket server
- Update CLAUDE.md session server description to mention both connection modes
- Update README if relevant

### Manual Testing Steps

1. Start the web GUI with `bun run dev`
2. Run `tim agent <plan>` in a separate terminal
3. Verify the session appears in the Sessions tab (discovered via PID file, not direct WebSocket connection)
4. Verify message history is replayed
5. Send a prompt response from the GUI
6. End a session from the GUI
7. Kill a tim process and verify the session goes offline
8. Start a new tim process and verify it's auto-discovered
9. Start the web GUI after tim processes are already running — verify existing sessions are discovered
10. Test with `TIM_WS_BEARER_TOKEN=secret` set for the agent process
11. Verify that agent processes no longer attempt to connect to port 8123

### Rationale for Key Decisions

- **Remove client code from HeadlessAdapter**: Agents no longer need to know the GUI's address. This is a prerequisite for remote workspace support where agents may run on different machines.
- **Keep the WebSocket server in the GUI**: It serves the notification endpoint and may be useful for future features. No cost to keeping it.
- **Reuse SessionManager as-is**: The AgentSender callback pattern makes the transport layer completely pluggable. The discovery client just provides a different sender callback.
- **Directory scan + diff approach**: Simpler and more reliable than parsing individual fs.watch events, which vary by platform.
- **Periodic reconciliation**: Catches any missed events and handles stale PID files from crashes that happened while the GUI was not running.
- **Use session info file's sessionId as connectionId**: Provides a stable identifier across GUI restarts, preventing duplicate sessions if the GUI reconnects to the same process.
- **Add sessionId to protocol**: Allows the GUI to correlate WebSocket sessions with PID files, useful for debugging and future features.

## Current Progress
### Current State
- All 10 tasks complete plus all review feedback addressed. Plan is done.
### Completed (So Far)
- Added `sessionId` to `HeadlessSessionInfo`, `planUuid` to `SessionInfoFile` with validation
- Wired sessionId/planUuid through HeadlessAdapter's buildSessionInfoFile, sendReplayToServerClient, broadcastSessionInfo
- Created `SessionDiscoveryClient` in `src/lib/server/session_discovery.ts` with full lifecycle management
- WebSocket client connection management with retry/backoff, PID liveness checks, stale file cleanup, token skip, HMR support
- Integrated SessionDiscoveryClient into hooks.server.ts with HMR-safe singleton pattern, shutdown handlers, and init failure cleanup
- Added getSessionDiscoveryClient()/setSessionDiscoveryClient() to session_context.ts
- Removed all WebSocket client code from HeadlessAdapter (connection state machine, drain loop, queue, reconnection logic, maybeConnect, etc.)
- HeadlessAdapter is now embedded-server-only: keeps history buffer, replay, broadcast, prompt/input handling
- Removed url parameter from HeadlessAdapter constructor; headless.ts no longer resolves client URLs
- Updated all callers and tests for the new constructor signature
- 18 unit/integration tests in session_discovery.test.ts covering all scenarios
- HeadlessAdapter and headless.ts tests verified for server-only mode, sessionId/planUuid inclusion, TIM_NO_SERVER
- Documentation updated in docs/web-interface.md, CLAUDE.md, README.md
- Added `hostname` field to `SessionInfoFile` for non-default bind addresses
- Review feedback addressed:
  - Init failure cleanup only tears down resources created in current attempt, not reused globals
  - IPv6 wildcard `::` maps to `[::1]` instead of `127.0.0.1`
  - `sessionId` persisted in SessionManager's session.sessionInfo and visible in snapshots/SSE
  - Removed unused `config` parameter from `RunWithHeadlessOptions`/`CreateHeadlessAdapterOptions`
  - Loopback-only hostname enforcement: non-loopback hostnames rejected with warning
  - Full `127.0.0.0/8` range accepted for loopback detection
  - Session registration gated on validated `session_info` (sessionId must match PID file)
  - First-time connections register on validated session_info; reconnections buffer until replay_end
  - Reconnect replay buffering protects existing offline session history until replacement proves viable
  - Pending message buffer capped at 10,000 to prevent unbounded memory growth
  - PID validation rejects `pid <= 0` in `parseSessionInfoFile()`
  - Stale socket guard (early return) in WebSocket close handler
  - Public `forceReconcile()` method for deterministic test timing
  - Renamed `QueuedMessage` to `HistoryEntry` in headless_adapter.ts
  - Removed unused `_timeoutMs` from `HeadlessAdapter.destroy()`
  - sessionId mismatch sets `tracked.stopped = true` to prevent wasteful retry loop
### Remaining
- None
### Next Iteration Guidance
- None — plan complete
### Decisions / Changes
- sessionId spread order in HeadlessAdapter: `...this.sessionInfo` must come before `sessionId: this.serverSessionId` to prevent caller-provided sessionInfo from overriding the runtime ID
- Watcher installed before initial scan to avoid discovery gap for files created during startup
- fs.watch() failure is non-fatal; falls back to polling-only mode
- Token transition: existing tracked connections are disposed when a PID transitions to token:true
- Retry exhaustion recovery: reconciliation resets retry attempts for idle tracked connections so they can reconnect
- hooks.server.ts tracks which resources were created vs reused; catch block only tears down newly-created ones
- hostname field added to SessionInfoFile to support non-default TIM_SERVER_HOSTNAME; discovery restricts to loopback-only
- Session registration requires validated session_info: first-time connects register on session_info, reconnects buffer until replay_end but require session_info first
- sessionId mismatch stops the tracked connection to prevent wasteful retry loops
### Lessons Learned
- Object spread order matters for pinned fields: placing `...obj` before the pinned value lets the spread overwrite it. Always put pinned/authoritative fields after the spread.
- When `disposeTrackedConnection` sets `tracked.stopped = true` and then calls `ws.close()`, the async close handler must check `tracked.stopped` before calling `handleWebSocketDisconnect` to avoid double-notify.
- stop() should mark sessions offline (notifyDisconnect=true) since SessionManager persists across HMR; leaving sessions active breaks status display.
- Init functions that create multiple resources must track which were newly created. On failure, only clean up new resources — tearing down reused globals turns a partial failure into a full outage.
- Bind addresses and connect addresses are different concepts: wildcard binds (0.0.0.0, ::) are not dialable endpoints. Always normalize bind addresses to loopback for local discovery, and bracket IPv6 literals in URLs. Map `::` to `[::1]` (not `127.0.0.1`) for IPv6-only hosts.
- `void promise` silently discards rejections. Always add `.catch()` when fire-and-forgetting promises in timer/event callbacks to prevent unhandled rejection crashes.
- WebSocket message handlers need the same stale-socket guards as open/close handlers — buffered frames can arrive after a socket is logically disposed.
- Registration should be gated on protocol validation (validated session_info), not on transport events (socket open). This prevents phantom sessions from endpoints that accept connections but never identify themselves correctly.
- For reconnects to offline sessions, buffer the replay stream and only swap after replay_end. For new sessions, register on session_info so they're visible during replay. These are fundamentally different use cases requiring different strategies.
- `process.kill(0, 0)` checks the process group, not PID 0. Always reject `pid <= 0` in session file validation.
### Risks / Blockers
- None
