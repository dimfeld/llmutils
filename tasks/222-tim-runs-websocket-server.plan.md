---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: tim runs websocket server
goal: ""
id: 222
uuid: 80e8e677-777a-4917-9d42-984dfca6d8f3
generatedBy: agent
status: pending
priority: medium
parent: 221
references:
  "221": 8d41284b-b510-4713-bd21-2db13687f2e5
planGeneratedAt: 2026-03-23T18:46:25.055Z
promptsGeneratedAt: 2026-03-23T18:46:25.055Z
createdAt: 2026-03-07T07:46:46.426Z
updatedAt: 2026-03-23T18:46:25.056Z
tasks:
  - title: Create runtime directory utilities
    done: false
    description: Create src/tim/session_server/runtime_dir.ts with
      getTimSessionDir() (XDG_CACHE_HOME-aware ~/.cache/tim/sessions/),
      writeSessionInfoFile(), removeSessionInfoFile(), readSessionInfoFile(),
      and listSessionInfoFiles(). Also add getTimCacheDir() to
      src/common/config_paths.ts following the same XDG pattern as
      getTimConfigRoot(). Register process.on(exit) cleanup handler for PID file
      removal. Define SessionInfoFile interface with sessionId, pid, port,
      command, workspacePath, planId, planTitle, gitRemote, startedAt, token
      fields.
  - title: Create embedded WebSocket server module
    done: false
    description: "Create src/tim/session_server/embedded_server.ts with
      startEmbeddedServer(options). Uses Bun.serve() with WebSocket on
      /tim-agent path. Options: port (default 0), bearerToken (optional),
      onConnect/onMessage/onDisconnect callbacks. Validates bearer token on
      upgrade (Authorization header or token query param), returns 401 on
      failure. Tracks clients in Map, provides broadcast() and sendTo() methods.
      Returns handle with { port, stop(), broadcast(), sendTo(),
      connectedClients }. Supports multiple simultaneous client connections."
  - title: Extract shared protocol utilities
    done: false
    description: Move parseHeadlessMessage() and message validation logic from
      src/lib/server/ws_server.ts into a shared location
      (src/logging/headless_message_utils.ts or add to
      src/logging/headless_protocol.ts). Update ws_server.ts to import from the
      shared location. Both the existing tim-gui server and the new embedded
      server need this parsing logic.
  - title: Extend HeadlessAdapter with server mode
    done: false
    description: "Extend HeadlessAdapter in src/logging/headless_adapter.ts to
      optionally start and manage the embedded server alongside its existing
      client connection. Add serverPort and bearerToken constructor options.
      When serverPort is provided (including 0), start embedded server, write
      PID info file, and broadcast all output messages to server-connected
      clients in addition to the client WebSocket. Route incoming server
      messages (prompt_response, user_input, end_session) through same handlers
      as client-received messages, first-response-wins for prompts. On new
      client connect: send replay_start, replay history buffer, send replay_end,
      then stream live. On updateSessionInfo(), rewrite PID file. On destroy(),
      stop server and remove PID file. Register process.on(exit) for synchronous
      PID file cleanup."
  - title: Update headless.ts integration functions
    done: false
    description: Modify createHeadlessAdapter() in src/tim/headless.ts to read env
      vars (TIM_SERVER_PORT, TIM_NO_SERVER, TIM_WS_BEARER_TOKEN) and pass server
      options to HeadlessAdapter. When TIM_NO_SERVER=1, skip server
      (client-only). When TIM_SERVER_PORT set, use that port; default to 0. When
      TIM_WS_BEARER_TOKEN set, pass as bearer token. Both
      runWithHeadlessAdapterIfEnabled() and createHeadlessAdapterForCommand()
      automatically pick up env vars, so no changes needed in individual command
      files.
  - title: Unit tests for runtime directory utilities
    done: false
    description: "Test src/tim/session_server/runtime_dir.ts:
      writing/reading/listing/removing PID files, directory creation with proper
      permissions, concurrent writes, stale file detection (file exists but PID
      is dead). Use temp directories for test isolation."
  - title: Unit tests for embedded server
    done: false
    description: "Test src/tim/session_server/embedded_server.ts: server starts on
      random port (port 0), server starts on specific port, port conflict causes
      error, bearer token validation (accepts valid, rejects invalid with 401,
      no auth when no token configured), WebSocket message parsing and routing,
      multiple simultaneous client connections, broadcast to all clients, client
      disconnect handling."
  - title: Integration tests for HeadlessAdapter server mode
    done: false
    description: "Test full flow: adapter starts with server mode, writes PID file,
      serves WebSocket on /tim-agent. Client connects and receives replay of
      message history (replay_start, history, replay_end). New messages
      broadcast to connected clients. Prompt response flow works end-to-end
      (first-response-wins). PID file updated on updateSessionInfo(). PID file
      cleaned up on adapter destroy. Both client and server modes run
      simultaneously."
  - title: Test env var integration
    done: false
    description: "Test that headless.ts correctly reads env vars and configures the
      adapter: TIM_SERVER_PORT sets specific port, TIM_NO_SERVER=1 disables
      server, default (no env vars) starts server on random port,
      TIM_WS_BEARER_TOKEN enables auth. Server stops when adapter is destroyed."
tags: []
---

As a complement or replacement to current system where it is a client and tries to connect to tim-gui.

We need a way to list active processes locally by looking in a well-known directory where each process has a PID-named
info file which contains JSON information containing:
- session ID (random uuid)
- the port is is listening on (should request 0 by default to get a random port)
- the active directory, workspace, plan ID

And then tim GUI can connect to that and see new sessions by watching the directory.

Add an option to the various long-running commands (agent, review, generate, etc) to allows setting a particular port.
If a port is requested but not available, then exit. This will facilitate running on a remote server or inside a
container where there will be just a single tim instance at a time.

This should have an option to require a bearer token to connect, if an environment variable is set with the token.

## Research

### Overview

Currently, tim long-running commands (agent, generate, chat, review, run-prompt) act as **WebSocket clients** that connect to a WebSocket server hosted inside the SvelteKit-based tim-gui web interface. This plan inverts that model: each tim process will run its own **embedded WebSocket server**, and tim-gui (or other consumers) will connect to it. A process discovery mechanism via PID files in a well-known directory enables tim-gui to find and connect to running instances.

### Critical Discoveries

1. **Current Architecture is Client→Server**: The `HeadlessAdapter` class (`src/logging/headless_adapter.ts`) is a WebSocket *client* that connects to a URL (default `ws://localhost:8123/tim-agent`). The SvelteKit app runs a `Bun.serve()` WebSocket *server* (`src/lib/server/ws_server.ts`) on that port. This plan flips the direction for the tim process side.

2. **The protocol is already well-defined and bidirectional**: Client→server messages (`HeadlessMessage`): `session_info`, `output`, `replay_start`, `replay_end`. Server→client messages (`HeadlessServerMessage`): `prompt_response`, `user_input`, `end_session`. This protocol can be reused as-is — only the transport direction changes.

3. **Five commands use the headless adapter**: `agent`, `generate`, `chat`, `review`, and `run-prompt`. They all use either `runWithHeadlessAdapterIfEnabled()` or `createHeadlessAdapterForCommand()` from `src/tim/headless.ts`. Since server mode is integrated into the `HeadlessAdapter` itself and controlled by env vars, no individual command changes are needed.

4. **The tim-gui side (plan 223) will handle the client connection logic**. This plan (222) focuses solely on making each tim process capable of serving WebSocket connections and advertising its existence.

### Key Files and Modules

#### Headless Adapter System
- **`src/logging/headless_adapter.ts`**: The `HeadlessAdapter` class wraps a logger and streams all output to a WebSocket. Currently acts as a *client*. Key behaviors: buffering/replay, reconnection, prompt handling, session info updates, graceful drain on destroy.
- **`src/logging/headless_protocol.ts`**: Type definitions for the bidirectional protocol. `HeadlessMessage` (client→server), `HeadlessServerMessage` (server→client), `HeadlessSessionInfo`.
- **`src/tim/headless.ts`**: High-level integration functions: `resolveHeadlessUrl()`, `buildHeadlessSessionInfo()`, `runWithHeadlessAdapterIfEnabled()`, `createHeadlessAdapterForCommand()`, `updateHeadlessSessionInfo()`.

#### WebSocket Server (current, in tim-gui)
- **`src/lib/server/ws_server.ts`**: `startWebSocketServer()` uses `Bun.serve()` with WebSocket upgrade on `/tim-agent` and HTTP POST on `/messages`. Parses and validates incoming `HeadlessMessage`, delegates to `SessionManager`.
- **`src/lib/server/session_manager.ts`**: `SessionManager` class manages session state, message categorization, event emission. Handles connect/disconnect/message lifecycle. Emits typed events consumed by SSE streaming.
- **`src/lib/server/session_context.ts`**: Global singleton storage for `SessionManager` and `WebSocketServerHandle`, survives HMR.
- **`src/hooks.server.ts`**: SvelteKit init hook creates `SessionManager`, starts WebSocket server, registers shutdown handlers.

#### Command Entry Points
- **`src/tim/commands/agent/agent.ts`**: Uses `runWithHeadlessAdapterIfEnabled()` with `enabled: !isTunnelActive()`.
- **`src/tim/commands/generate.ts`**: Same pattern.
- **`src/tim/commands/chat.ts`**: Same pattern, also calls `updateHeadlessSessionInfo()` when workspace changes.
- **`src/tim/commands/review.ts`**: Manual lifecycle with `createHeadlessAdapterForCommand()`.
- **`src/tim/commands/run_prompt.ts`**: Uses `runWithHeadlessAdapterIfEnabled()`.

#### Configuration
- **`src/tim/configSchema.ts`**: `headless` config section has only `url: string` currently. No config schema changes needed — all new settings are environment variables.
- **`src/common/config_paths.ts`**: `getTimConfigRoot()` provides XDG-aware config dir (`~/.config/tim/`). A similar `getTimCacheDir()` function will provide `~/.cache/tim/` respecting `XDG_CACHE_HOME`.

### Existing Utilities and Patterns

- **Port resolution**: `resolveHeadlessServerConfig()` in `ws_server.ts` handles port from env var → config → URL → default. The new embedded server should follow a similar pattern but default to port 0 (random).
- **Bun.serve() WebSocket**: The existing `ws_server.ts` demonstrates the exact Bun WebSocket server pattern to reuse — upgrade handling, typed `WebSocketData`, message parsing.
- **Session info building**: `buildHeadlessSessionInfo()` gathers workspace, git remote, plan info, terminal metadata. This same function provides the data needed for the PID info file.
- **Cleanup handlers**: The workspace lock system (`src/tim/workspace/workspace_lock.ts`) demonstrates PID-based cleanup with `process.on('SIGTERM/SIGINT')` and `beforeExit` handlers. The PID file cleanup should follow the same pattern.
- **`isTunnelActive()`**: In `src/logging/tunnel_client.ts`, checks if `TIM_OUTPUT_SOCKET` env var is set. The headless adapter is only enabled when tunnel is not active. The new server mode should integrate with this same gating logic.

### Architectural Considerations

1. **Dual mode support**: The tim process runs BOTH modes simultaneously by default — connecting as a client to tim-gui (existing behavior) AND running its own embedded server. Future work will either remove the client mode or update how it works. `--no-server` disables only the embedded server; the client connection continues as before.

2. **PID file directory**: Use `~/.cache/tim/sessions/` (respecting `XDG_CACHE_HOME` if set, similar to how `getTimConfigRoot()` respects `XDG_CONFIG_HOME`). Files named by PID (e.g., `12345.json`). Stale files from crashes/reboots are expected and handled by consumers checking PID liveness.

3. **PID file lifecycle**: Must be cleaned up on normal exit AND signal-based termination. Stale file detection (process no longer running) should be handled by the consumer (tim-gui, plan 223), not the writer.

4. **Bearer token auth**: The `TIM_WS_BEARER_TOKEN` environment variable provides a bearer token. When set, the embedded server validates `Authorization: Bearer <token>` on WebSocket upgrade. When not set, no auth required (local development default).

5. **Port conflicts**: When a specific port is requested (e.g., for container/remote use) and it's unavailable, the process should exit with a clear error. When port 0 is used (default), OS assigns a random available port.

6. **Protocol reuse**: The same `HeadlessMessage` and `HeadlessServerMessage` types work regardless of who is the server and who is the client. The SessionManager's message categorization logic could potentially be extracted for reuse, but that's plan 223's concern.

### Dependencies and Prerequisites

- No external dependencies needed — Bun's built-in `Bun.serve()` handles WebSocket natively.
- Plan 223 depends on this plan — tim-gui connecting to these servers is a separate effort.
- Plans 224 and 225 (persistent/ephemeral remote servers) also depend on this plan.

### Surprising Findings

- The `HeadlessAdapter` has sophisticated buffering and replay logic (10MB buffer, message history, replay_start/replay_end flow). When running as a server, this replay mechanism becomes even more important — a client that connects after the session has started needs to receive the full history.
- The existing `startWebSocketServer()` is tightly coupled to `SessionManager` which is a tim-gui concept. The new embedded server in the tim process will be simpler — it just needs to bridge the existing adapter's output to connected WebSocket clients and forward incoming messages to the adapter's handlers.
- The `HeadlessAdapter` already supports multiple prompt types and user input forwarding — the embedded server gets these capabilities for free.

## Implementation Guide

### Phase 1: PID Info File Infrastructure

**Step 1: Create runtime directory utilities**

Create a new module `src/tim/session_server/runtime_dir.ts` that provides:
- `getTimSessionDir()`: Returns `~/.cache/tim/sessions/` (respecting `XDG_CACHE_HOME` if set, following the same pattern as `getTimConfigRoot()` respects `XDG_CONFIG_HOME`). Ensure the directory exists (create with mode 0o700 for security).
- `writeSessionInfoFile(pid, info)`: Write a JSON file named `<pid>.json` to the runtime dir. Contents: `{ sessionId, port, workspacePath, planId, planTitle, command, gitRemote, startedAt }`.
- `removeSessionInfoFile(pid)`: Remove the PID file. Should not throw if file doesn't exist.
- `readSessionInfoFile(pidOrPath)`: Read and parse a PID file (for testing and for plan 223).
- `listSessionInfoFiles()`: List all `*.json` files in the runtime dir, parse them, return array (for plan 223).

Register cleanup for the PID file in signal handlers following the same pattern as workspace lock cleanup. Use `process.on('exit')` (synchronous) for the file removal since it must happen even on uncaught exceptions.

**Step 2: Define the session info file schema**

Use a simple interface (no Zod needed for internal runtime files):
```typescript
interface SessionInfoFile {
  sessionId: string;       // crypto.randomUUID()
  pid: number;             // process.pid
  port: number;            // The port the embedded server is listening on
  command: string;         // agent, generate, chat, review, run-prompt
  workspacePath?: string;
  planId?: number;
  planTitle?: string;
  gitRemote?: string;
  startedAt: string;       // ISO timestamp
  token?: boolean;         // true if bearer token is required (don't store the token itself!)
}
```

### Phase 2: Embedded WebSocket Server

**Step 3: Create the embedded WebSocket server module**

Create `src/tim/session_server/embedded_server.ts`:
- `startEmbeddedServer(options)`: Starts a `Bun.serve()` WebSocket server. Options include: `port` (default 0), `bearerToken` (optional), `onConnect`, `onMessage`, `onDisconnect` callbacks.
- The server should:
  - Listen on the requested port (0 = random)
  - Serve WebSocket connections on `/tim-agent` path (consistent with existing protocol)
  - On WebSocket upgrade: validate bearer token if configured (check `Authorization` header or `token` query parameter for flexibility), reject with 401 if invalid, assign a connection ID
  - Track connected clients in a Map
  - Forward incoming WebSocket messages to the `onMessage` callback
  - Provide a `broadcast(message)` method to send to all connected clients
  - Provide a `sendTo(connectionId, message)` method to send to a specific client
  - Support multiple simultaneous client connections
  - Handle disconnections gracefully
- Return a handle with `{ port, stop(), broadcast(), sendTo(), connectedClients }`.

**Step 4: Extract shared protocol utilities**

Move `parseHeadlessMessage()` and message validation from `ws_server.ts` into a shared location (e.g., `src/logging/headless_protocol.ts` or a new `src/logging/headless_message_utils.ts`). Both the existing tim-gui server and the new embedded server need this parsing logic.

### Phase 3: Integrate Server Mode into HeadlessAdapter

**Step 5: Extend HeadlessAdapter to support embedded server mode**

Extend `HeadlessAdapter` in `src/logging/headless_adapter.ts` to optionally start and manage the embedded server alongside its existing client connection:
- Add server-related options to the constructor: `serverPort` (number | undefined), `bearerToken` (string | undefined). When `serverPort` is provided (including 0), server mode is enabled.
- When server mode is enabled, the adapter starts the embedded server on construction/init and writes the PID info file.
- All output messages are sent to both the client WebSocket (existing behavior) AND broadcast to all server-connected clients.
- Incoming messages from server clients (`prompt_response`, `user_input`, `end_session`) are routed through the same handlers as client-received messages. First response wins for prompts.
- When a new client connects to the server: send `replay_start`, replay full message history, send `replay_end`, then stream live. This reuses the existing history buffer.
- On `updateSessionInfo()`, also rewrite the PID info file with updated data.
- On `destroy()`, stop the embedded server and remove the PID info file.
- Register `process.on('exit')` handler to synchronously remove the PID file.

**Step 6: Update headless.ts integration functions**

Modify `src/tim/headless.ts`:
- Update `createHeadlessAdapter()` to read environment variables (`TIM_SERVER_PORT`, `TIM_NO_SERVER`, `TIM_WS_BEARER_TOKEN`) and pass server options to the `HeadlessAdapter`.
- When `TIM_NO_SERVER=1` is set, don't pass server options (client-only mode, existing behavior).
- When `TIM_SERVER_PORT` is set, use that port; otherwise default to 0 (random).
- When `TIM_WS_BEARER_TOKEN` is set, pass it as the bearer token for server auth.
- Both `runWithHeadlessAdapterIfEnabled()` and `createHeadlessAdapterForCommand()` automatically pick up these env vars — no changes needed in individual commands.

**Step 7: No changes needed to individual command files**

Since the server mode is integrated directly into the `HeadlessAdapter` and env vars control behavior, the five command files (`agent.ts`, `generate.ts`, `chat.ts`, `review.ts`, `run_prompt.ts`) require no modifications. The existing `runWithHeadlessAdapterIfEnabled()` calls work as before, with the adapter now also running the embedded server by default.

### Phase 4: Testing

**Step 8: Unit tests for runtime directory utilities**

Test `src/tim/session_server/runtime_dir.ts`:
- Writing, reading, listing, removing PID files
- Concurrent writes don't corrupt
- Directory creation with proper permissions
- Stale file handling (file exists but PID is dead)

**Step 9: Unit tests for embedded server**

Test `src/tim/session_server/embedded_server.ts`:
- Server starts on random port, port 0 works
- Server starts on specific port
- Specific port conflict causes error
- Bearer token validation (accepts valid, rejects invalid, no auth when no token configured)
- WebSocket message parsing and routing
- Multiple client connections
- Broadcast to all clients
- Client disconnect handling

**Step 10: Integration tests for HeadlessAdapter server mode**

Test the full flow:
- Server adapter starts, writes PID file, serves WebSocket
- Client connects, receives replay of message history
- New messages broadcast to connected client
- Prompt response flow works end-to-end
- PID file cleaned up on adapter destroy
- PID file cleaned up on signal (test with child process)

**Step 11: Test env var integration**

Test that environment variables correctly control the embedded server:
- `TIM_SERVER_PORT=9999` starts server on that port
- `TIM_NO_SERVER=1` disables the server
- Default behavior (no env vars) starts server on random port
- `TIM_WS_BEARER_TOKEN=secret` enables auth
- Server stops when adapter is destroyed

### Manual Testing Steps

1. Run `tim agent <plan>` and verify a PID file appears in the runtime directory
2. Check the PID file contains correct JSON with port, session ID, etc.
3. Connect to the WebSocket port with a tool like `websocat` and verify messages flow
4. Kill the tim process and verify the PID file is cleaned up
5. Run with `TIM_SERVER_PORT=9999 tim agent <plan>` and verify it listens on that port
6. Run two instances with `TIM_SERVER_PORT=9999` and verify the second exits with error
7. Set `TIM_WS_BEARER_TOKEN=secret` and verify unauthenticated connections are rejected
8. Verify backward compatibility: `TIM_HEADLESS_URL` still works to connect as a client (both modes run simultaneously)

### Rationale for Key Decisions

- **Single HeadlessAdapter for both modes**: Rather than a separate server adapter class, the `HeadlessAdapter` is extended to handle both client and server roles. It already has buffering/history/serialization; adding server broadcast is a natural extension. Both modes run simultaneously by default.
- **Port 0 default**: The OS assigns a random available port, avoiding conflicts when multiple tim instances run. The PID file advertises the actual port.
- **`~/.cache/tim/sessions/` for PID files**: A well-known, cross-platform path that doesn't require env var setup. Respects `XDG_CACHE_HOME` when set. Stale files from crashes are expected and handled by consumers via PID liveness checks.
- **Bearer token via env var**: Avoids exposing secrets in `ps` output. The PID file stores only a boolean `token: true` flag so consumers know auth is required, not the token itself.
- **Replay on client connect**: Essential for the use case where tim-gui discovers a running session and connects mid-stream. The client needs the full history to render the session state.
