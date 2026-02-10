---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: two-way tunnel for inquirer in subagents
goal: ""
id: 170
uuid: 7dbef580-dad0-4961-a66a-96c46839a354
generatedBy: agent
status: done
priority: medium
parent: 160
references:
  "160": 514cedb9-6431-400a-a997-12d139376146
planGeneratedAt: 2026-02-10T21:27:49.212Z
promptsGeneratedAt: 2026-02-10T21:27:49.212Z
createdAt: 2026-02-10T21:01:13.145Z
updatedAt: 2026-02-10T22:46:59.903Z
tasks:
  - title: Define prompt_request structured message type and ServerTunnelMessage union
    done: true
    description: "In src/logging/structured_messages.ts, add PromptRequestMessage
      with fields: requestId (string), promptType
      (input|confirm|select|checkbox), promptConfig (message, default, choices,
      pageSize, validationHint), timeoutMs (optional number). Add to
      StructuredMessage union and structuredMessageTypeList. In
      src/logging/tunnel_protocol.ts, add TunnelPromptResponseMessage (type:
      prompt_response, requestId, value?, error?) and ServerTunnelMessage union
      type for server→client messages."
  - title: Update tunnel server validation for prompt_request
    done: true
    description: "In src/logging/tunnel_server.ts, add a prompt_request case in
      isValidStructuredMessagePayload that validates: requestId is a string,
      promptType is one of the valid types, promptConfig is a valid object with
      message string, choices array (if present) has valid entries with
      JSON-serializable values, timeoutMs (if present) is a number. Add
      prompt_request validation tests to tunnel_server.test.ts."
  - title: Add response listening to TunnelAdapter (client-side bidirectional
      transport)
    done: true
    description: "In src/logging/tunnel_client.ts, extend TunnelAdapter to: add a
      createLineSplitter() for incoming data on the socket, register a data
      event handler on the socket in the constructor to parse
      ServerTunnelMessage responses, maintain a Map<string, {resolve, reject,
      timer}> for pending prompt requests, add sendPromptRequest(message:
      PromptRequestMessage, timeoutMs?: number): Promise<unknown>. On socket
      close/error events, reject all pending prompt requests with a connection
      error. In destroy()/destroySync(), reject all pending. Add tests to
      tunnel_client.test.ts for: send request and receive response, timeout
      behavior, connection loss during pending request, multiple concurrent
      requests, unknown requestId responses silently ignored."
  - title: Add prompt request handling to TunnelServer (server-side bidirectional
      transport)
    done: true
    description: "Modify createTunnelServer to accept an optional onPromptRequest
      callback: (message: PromptRequestMessage, respond: (response:
      TunnelPromptResponseMessage) => void) => void. When a prompt_request
      structured message is received: still dispatch via sendStructured() for
      logging, and if onPromptRequest callback is provided, call it with the
      message and a respond function that writes the response JSONL back to the
      originating socket. The respond function captures the socket reference
      from the connection handler closure. This requires refactoring
      dispatchMessage or the connection handler to have access to the socket.
      Add integration tests to tunnel_integration.test.ts."
  - title: Create server-side prompt handler module
    done: true
    description: "Create src/logging/tunnel_prompt_handler.ts with
      createPromptRequestHandler(): PromptRequestHandler. This returns a
      function that maps promptType to the corresponding @inquirer/prompts
      function (confirm, select, input, checkbox), translates promptConfig to
      inquirer options, handles timeoutMs via AbortController with setTimeout,
      calls the inquirer function, and calls respond() with {value} on success
      or {error} on failure. Create src/logging/tunnel_prompt_handler.test.ts
      with tests for prompt type mapping, timeout handling, and error cases."
  - title: Create prompt wrapper module
    done: true
    description: "Create src/common/prompt.ts with wrapper functions: promptConfirm,
      promptSelect, promptInput, promptCheckbox. Each builds a
      PromptRequestMessage, checks if getLoggerAdapter() is instanceof
      TunnelAdapter. If tunneled: calls adapter.sendPromptRequest(). If not
      tunneled: sends via sendStructured() for visibility, then calls
      @inquirer/prompts directly. All functions accept timeoutMs parameter. In
      tunneled mode, timeoutMs is in the message and client starts local timer.
      In non-tunneled mode, creates AbortController with setTimeout for
      inquirer. Also update src/logging/console_formatter.ts to handle
      prompt_request message type. Create src/common/prompt.test.ts with tests
      for both tunneled and non-tunneled paths."
  - title: Migrate 4 call sites to use prompt wrappers
    done: true
    description: "Migrate these call sites to use the new wrapper functions: (1)
      src/tim/workspace/workspace_auto_selector.ts: replace confirm() with
      promptConfirm(), remove preceding sendStructured input_required call. (2)
      src/tim/executors/claude_code/permissions_mcp_setup.ts: replace select()
      with promptSelect(), remove preceding sendStructured input_required call,
      convert AbortController timeout to timeoutMs parameter. (3)
      src/tim/commands/agent/batch_mode.ts: replace confirm() with
      promptConfirm(), remove preceding sendStructured input_required call. (4)
      src/tim/commands/agent/agent.ts: replace confirm() with promptConfirm(),
      remove preceding sendStructured input_required call."
  - title: Wire up prompt handler in tunnel server creation sites
    done: true
    description: "Update src/tim/commands/subagent.ts to pass the onPromptRequest
      handler when creating the tunnel server: const promptHandler =
      createPromptRequestHandler(); tunnelServer = await
      createTunnelServer(tunnelSocketPath, { onPromptRequest: promptHandler }).
      Also check src/tim/executors/claude_code.ts and
      src/tim/executors/codex_cli/codex_runner.ts for createTunnelServer calls
      and wire up the handler there too."
changedFiles:
  - README.md
  - package.json
  - src/common/prompt.test.ts
  - src/common/prompt.ts
  - src/logging/console_formatter.ts
  - src/logging/structured_messages.test.ts
  - src/logging/structured_messages.ts
  - src/logging/tunnel_client.test.ts
  - src/logging/tunnel_client.ts
  - src/logging/tunnel_integration.test.ts
  - src/logging/tunnel_prompt_handler.test.ts
  - src/logging/tunnel_prompt_handler.ts
  - src/logging/tunnel_protocol.ts
  - src/logging/tunnel_server.test.ts
  - src/logging/tunnel_server.ts
  - src/tim/commands/agent/agent.integration.test.ts
  - src/tim/commands/agent/agent.summary_file.integration.test.ts
  - src/tim/commands/agent/agent.test.ts
  - src/tim/commands/agent/agent.timeout.integration.test.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/agent/agent_batch_mode.test.ts
  - src/tim/commands/agent/batch_mode.ts
  - src/tim/commands/subagent.test.ts
  - src/tim/commands/subagent.ts
  - src/tim/configSchema.test.ts
  - src/tim/configSchema.ts
  - src/tim/executors/claude_code/orchestrator_integration.test.ts
  - src/tim/executors/claude_code/orchestrator_prompt.test.ts
  - src/tim/executors/claude_code/orchestrator_prompt.ts
  - src/tim/executors/claude_code/permissions_mcp_setup.ts
  - src/tim/executors/claude_code.test.ts
  - src/tim/executors/claude_code.ts
  - src/tim/executors/claude_code_model_test.ts
  - src/tim/executors/codex_cli/codex_runner.ts
  - src/tim/executors/types.ts
  - src/tim/tim.ts
  - src/tim/workspace/workspace_auto_selector.ts
tags: []
---

When running in a subagent like in src/tim/commands/subagent.ts we will run in to problems when we need to show interactive prompts to the user. 

We should create a wrapper around all the `inquirer` calls which will:
  - sendStructured the input_required message, but extended with additional information to include the type of input (input, confirm, select, etc.), any data needed to render it, and additional metadata
  like timeouts
  - If tunneling is disabled, act like normal and just call the regular inquirer function
  - If tunneling is enabled, wait for a reply over the tunnel

  The tunnel server, when it receives this message, should translate the structured message into the appropriate inquirer prompt call and call it. And then, when it receives a response, or the timeout expires (if set) then send a message back through the tunnel containing the result.

## Expected Behavior/Outcome

When a subagent running inside a tunnel needs user input (confirm, select, input, checkbox), the prompt is transparently tunneled to the orchestrator, which renders the real inquirer prompt for the user. The user's response flows back through the tunnel to the subagent. When not running in a tunnel, all prompts work exactly as before — calling inquirer directly.

### States
- **Not tunneled**: Wrapper calls inquirer directly. Identical to current behavior.
- **Tunneled, prompt sent**: Subagent sends `prompt_request` structured message and awaits response. Orchestrator renders the inquirer prompt to the user.
- **Tunneled, response received**: Subagent resolves the prompt promise with the user's answer.
- **Tunneled, timeout**: If a timeout is configured and expires, the subagent's promise rejects with a timeout error.
- **Tunneled, connection lost**: If the tunnel disconnects while awaiting a response, the subagent's promise rejects with a connection error.

## Key Findings

### Product & User Story
As a user running tim orchestrators with subagents, I need interactive prompts (like permission approvals, review action selection, stale lock confirmation) to work correctly even when the code runs inside a subagent process, so that I can interact with the subagent through the orchestrator's terminal.

### Design & UX Approach
Transparent to the user — prompts appear in the orchestrator's terminal exactly as they would if running directly. The tunneling mechanism is invisible to both the user and the calling code (which uses wrapper functions identical to the inquirer API).

### Technical Plan & Risks
- **Risk**: Socket disconnection during a pending prompt could leave the subagent hanging. Mitigated by connection-loss detection on the client socket's `close`/`error` events.
- **Risk**: Serialization of choice values across the tunnel. Mitigated by requiring all choice values to be JSON-serializable primitives (string, number, boolean).
- **Risk**: The `editor` and `search` prompt types require real TTY interaction and cannot be meaningfully tunneled. Deferred — not used in subagent-reachable code paths.

### Pragmatic Effort Estimate
Medium complexity. Core protocol + transport changes are well-scoped. The wrapper and server-side handler are straightforward. Migration of 4 call sites validates the system end-to-end.

## Acceptance Criteria

- [ ] `prompt_request` structured message type defined with requestId, promptType, promptConfig, and optional timeoutMs
- [ ] Separate `ServerTunnelMessage` union type for server→client messages (containing `prompt_response`)
- [ ] `TunnelAdapter` can listen for responses on its socket and resolve pending prompt requests
- [ ] `TunnelServer` dispatches `prompt_request` messages to a handler that renders inquirer prompts and sends responses back
- [ ] Server-side prompt handler in a dedicated `tunnel_prompt_handler.ts` module
- [ ] Prompt wrapper functions (`promptConfirm`, `promptSelect`, `promptInput`, `promptCheckbox`) that auto-detect tunnel via `getLoggerAdapter()` instanceof check
- [ ] When not tunneled, wrappers call inquirer directly (no behavioral change)
- [ ] 4 call sites migrated: `workspace_auto_selector.ts`, `permissions_mcp_setup.ts`, `batch_mode.ts`, `agent.ts`
- [ ] Connection loss during pending prompt rejects the promise
- [ ] Optional timeout support on prompt requests
- [ ] All new code paths covered by tests (unit, transport, integration)

## Dependencies & Constraints

- **Dependencies**: Existing tunnel infrastructure (`tunnel_client.ts`, `tunnel_server.ts`, `tunnel_protocol.ts`), `@inquirer/prompts` package, `AsyncLocalStorage` adapter system
- **Technical Constraints**: Choice values must be JSON-serializable (string, number, boolean). `editor` and `search` prompt types are not supported (deferred).

## Implementation Notes

### Recommended Approach
Use a new `prompt_request` structured message type (not extending `input_required`). Create a separate `ServerTunnelMessage` union for server→client messages. Detect tunnel via `getLoggerAdapter()` instanceof `TunnelAdapter`. No default timeout — wait indefinitely unless caller specifies one. Prompt rendering logic in a dedicated `tunnel_prompt_handler.ts` module.

### Potential Gotchas
- `dispatchMessage` in `tunnel_server.ts` currently has no access to the originating socket — it only receives the parsed message. This needs to be refactored to pass the socket reference alongside messages so responses can be routed back.
- The existing `input_required` message type continues to exist for informational notifications. The new `prompt_request` type is a separate, interactive message. Existing call sites that send `input_required` before calling inquirer should be updated to use the wrapper (which handles both notification and interactive prompt in one call).
- When migrating call sites, the existing `sendStructured({ type: 'input_required' })` calls that precede inquirer calls should be removed — the wrapper handles the structured message emission internally.

## Research

### Overview

The current tunnel system (`src/logging/tunnel_*`) is unidirectional: the child (subagent) sends JSONL messages to the parent (orchestrator) over a Unix domain socket. There is no mechanism for the parent to send messages back to the child. This plan adds bidirectional communication to enable interactive prompts from subagents to be tunneled to the orchestrator for rendering.

### Key Discoveries

1. **Tunnel Architecture**: The tunnel uses Unix domain sockets with JSONL framing. The `TunnelAdapter` (client-side) implements `LoggerAdapter` and sends messages via `socket.write()`. The `TunnelServer` (parent-side) receives messages via the `'data'` event on each connection socket, parses JSONL lines, validates them, and dispatches to the logging system.

2. **The server already has access to the client socket**: In `tunnel_server.ts:414`, the server's connection handler receives the `socket` parameter for each client connection. This socket is bidirectional — the server can write back to it. Currently, only `socket.on('data', ...)` is used (reading from client), but `socket.write()` is available for sending data back.

3. **Existing `input_required` message**: Currently defined as `{ type: 'input_required', prompt?: string }` in `structured_messages.ts:204-207`. It's sent as a notification before calling inquirer directly. It has no request ID, no prompt type info, and no response mechanism. It's used in `workspace_auto_selector.ts`, `permissions_mcp_setup.ts`, `claude_code.ts`, `review.ts` (x2), `agent.ts`, and `batch_mode.ts`.

4. **Inquirer prompt types used across the codebase**: The following `@inquirer/prompts` types are used:
   - `input` — text entry (task_operations.ts, init.ts, description.ts, generate.ts, rmpr/main.ts)
   - `confirm` — yes/no (agent.ts, batch_mode.ts, workspace_auto_selector.ts, init.ts, assignments.ts, apply.ts, retry.ts, rmpr/main.ts)
   - `select` — single choice from list (task_operations.ts, review.ts, init.ts, description.ts, interactive.ts, permissions_mcp_setup.ts, claude_code.ts, rmpr/main.ts)
   - `checkbox` — multi-choice (review.ts, split.ts, description.ts, issue_utils.ts)
   - `editor` — opens text editor (task_operations.ts)
   - `search` — searchable list (model_factory.ts)

5. **No existing prompt abstraction**: Every file imports directly from `@inquirer/prompts`. There is no centralized wrapper. The `task_operations.ts` file centralizes some task-specific prompt helpers but still uses inquirer directly.

6. **Current `sendStructured` call pattern**: Before calling inquirer, code sends `sendStructured({ type: 'input_required', timestamp: timestamp(), prompt: '...' })`. This is purely informational — it doesn't await a response.

7. **LoggerAdapter interface** (`adapter.ts`): Defined as `{ log, error, warn, writeStdout, writeStderr, debugLog, sendStructured }`. All methods are void. To support request/response, we'll need a separate communication channel rather than changing the interface.

8. **AsyncLocalStorage for adapters**: The current adapter is stored per async context via `AsyncLocalStorage<LoggerAdapter>`. The `sendStructured()` global function looks up the adapter via `getLoggerAdapter()`. This means the wrapper can determine whether tunneling is active by checking if the current adapter is a `TunnelAdapter` (instanceof check).

### Relevant Files

**Core tunnel files to modify:**
- `src/logging/tunnel_protocol.ts` — Add new message types for prompt request/response
- `src/logging/tunnel_client.ts` — Add response listening capability to `TunnelAdapter`
- `src/logging/tunnel_server.ts` — Add prompt request dispatch with socket reference, integrate with handler
- `src/logging/structured_messages.ts` — Add new `PromptRequestMessage` type

**New files to create:**
- `src/common/prompt.ts` — Wrapper functions around `@inquirer/prompts` that transparently tunnel when active
- `src/logging/tunnel_prompt_handler.ts` — Server-side prompt rendering (translates prompt_request to inquirer calls)

**Existing test files to extend:**
- `src/logging/tunnel_client.test.ts` — Thorough socket-level tests
- `src/logging/tunnel_server.test.ts` — Validation and dispatch tests
- `src/logging/tunnel_integration.test.ts` — End-to-end tunnel flow tests

**Call sites to migrate in this plan:**
- `src/tim/workspace/workspace_auto_selector.ts` — confirm() for stale locks
- `src/tim/executors/claude_code/permissions_mcp_setup.ts` — select() for tool permissions
- `src/tim/commands/agent/batch_mode.ts` — confirm() for post-review continuation
- `src/tim/commands/agent/agent.ts` — confirm() for post-review continuation

### Architectural Considerations

1. **Message ID correlation**: Each prompt request needs a unique ID so the client can match the response to the pending request. Use `crypto.randomUUID()`.

2. **Socket bidirectionality**: The Unix domain socket is already bidirectional. The server has the client `socket` reference in the connection handler. The challenge is that `dispatchMessage` currently doesn't have access to the socket — it only receives the parsed message. We need to pass the socket reference through so that when a `prompt_request` message is received, the server can handle it and write the response back to the originating socket.

3. **Multiple clients**: The server supports multiple concurrent connections. Each prompt response must be written back to the specific client socket that sent the request. This is naturally handled by passing the socket reference alongside the message.

4. **JSONL for reverse direction**: The same JSONL framing should be used for server→client messages. The client needs a line splitter and message handler for incoming data.

5. **`editor` and `search` prompts**: These require real-time interactive TTY access that can't be meaningfully proxied over a message-passing protocol. They're also not used in any subagent-reachable code paths currently. Deferred.

6. **Timeout handling**: No default timeout — prompts wait indefinitely unless the caller specifies `timeoutMs`. If a timeout is set, the subagent rejects the pending promise.

7. **Graceful degradation**: If the tunnel connection is lost while waiting for a prompt response, the waiting promise should reject with a clear error rather than hanging forever.

8. **Separate message types**: Use a new `prompt_request` structured message type (not extending `input_required`). Use a separate `ServerTunnelMessage` union for server→client messages to maintain clear protocol directionality.

### Prompt Type Design

The wrapper supports the most commonly used inquirer prompt types. Based on usage analysis:

**Supported:**
- `confirm` — message, default
- `select` — message, choices (with name/value/description), default, pageSize
- `input` — message, default, validation hint (human-readable, since validation runs on the receiving end)
- `checkbox` — message, choices (with name/value/description/checked), pageSize

**Deferred:**
- `editor` — requires TTY for `$EDITOR`, impractical to tunnel
- `search` — requires keystroke-by-keystroke interaction, impractical to tunnel

**Value constraint**: All choice values must be JSON-serializable primitives (string, number, boolean). The wrapper enforces this at the type level.

## Implementation Guide

### Phase 1: Protocol Extension

**Step 1: Define prompt request/response message types**

In `src/logging/structured_messages.ts`, add a new `PromptRequestMessage` type:

```typescript
interface PromptRequestMessage extends StructuredMessageBase {
  type: 'prompt_request';
  requestId: string;
  promptType: 'input' | 'confirm' | 'select' | 'checkbox';
  promptConfig: {
    message: string;
    default?: unknown;
    choices?: Array<{ name: string; value: unknown; description?: string; checked?: boolean }>;
    pageSize?: number;
    validationHint?: string; // Human-readable validation description
  };
  timeoutMs?: number;
}
```

Add this to the `StructuredMessage` union and `structuredMessageTypeList`.

In `src/logging/tunnel_protocol.ts`, add a new `ServerTunnelMessage` union type for server→client messages:

```typescript
interface TunnelPromptResponseMessage {
  type: 'prompt_response';
  requestId: string;
  value?: unknown;  // The prompt result (present on success)
  error?: string;   // Error message (present on failure)
}

type ServerTunnelMessage = TunnelPromptResponseMessage;
```

This is separate from `TunnelMessage` (client→server) to maintain clear directionality.

**Step 2: Update tunnel server validation**

In `tunnel_server.ts`, add a `prompt_request` case in `isValidStructuredMessagePayload` that validates:
- `requestId` is a string
- `promptType` is one of the valid types
- `promptConfig` is a valid object with `message` string
- `choices` array (if present) has valid entries with JSON-serializable values
- `timeoutMs` (if present) is a number

### Phase 2: Bidirectional Transport

**Step 3: Add response listening to TunnelAdapter (client)**

In `src/logging/tunnel_client.ts`, extend `TunnelAdapter` to:
- Add a `createLineSplitter()` for incoming data on the socket
- Register a `'data'` event handler on the socket in the constructor to parse server→client messages
- Maintain a `Map<string, { resolve: (value: unknown) => void, reject: (error: Error) => void, timer?: Timer }>` for pending prompt requests
- Add a public method `sendPromptRequest(message: PromptRequestMessage, timeoutMs?: number): Promise<unknown>` that:
  1. Sends the structured message over the tunnel via the existing `send()` method
  2. Creates a promise and stores it in the pending map keyed by `requestId`
  3. If `timeoutMs` is provided, starts a timer that rejects the promise on expiry
  4. Returns the promise
- On socket `close`/`error` events, reject all pending prompt requests with a connection error
- In `destroy()`/`destroySync()`, reject all pending prompt requests

**Step 4: Add prompt handling to TunnelServer (server)**

Modify `createTunnelServer` to accept an optional `onPromptRequest` callback:

```typescript
type PromptRequestHandler = (message: PromptRequestMessage, respond: (response: TunnelPromptResponseMessage) => void) => void;

function createTunnelServer(socketPath: string, options?: { onPromptRequest?: PromptRequestHandler }): Promise<TunnelServer>
```

In the server's connection handler, when a `prompt_request` structured message is received:
1. Still dispatch it via `sendStructured()` for logging/visibility
2. If `onPromptRequest` callback is provided, call it with the message and a `respond` function that writes the response JSONL back to the originating socket

The `respond` function captures the socket reference from the connection handler closure.

### Phase 3: Server-side Prompt Rendering

**Step 5: Create the prompt handler module**

Create `src/logging/tunnel_prompt_handler.ts` with:

```typescript
function createPromptRequestHandler(): PromptRequestHandler
```

This returns a function that, when called with a `PromptRequestMessage`:
1. Maps `promptType` to the corresponding `@inquirer/prompts` function
2. Translates `promptConfig` to inquirer options
3. If `timeoutMs` is set, creates an `AbortController` with a `setTimeout` to cancel the prompt
4. Calls the inquirer function and awaits the result
5. Calls `respond()` with either `{ value }` on success or `{ error }` on failure

### Phase 4: Prompt Wrapper

**Step 6: Create the prompt wrapper module**

Create `src/common/prompt.ts` with wrapper functions:

```typescript
export async function promptConfirm(options: { message: string; default?: boolean; timeoutMs?: number }): Promise<boolean>
export async function promptSelect<Value>(options: { message: string; choices: Array<{name: string; value: Value; description?: string}>; default?: Value; pageSize?: number; timeoutMs?: number }): Promise<Value>
export async function promptInput(options: { message: string; default?: string; validationHint?: string; timeoutMs?: number }): Promise<string>
export async function promptCheckbox<Value>(options: { message: string; choices: Array<{name: string; value: Value; description?: string; checked?: boolean}>; pageSize?: number; timeoutMs?: number }): Promise<Value[]>
```

When `timeoutMs` is set:
- In tunneled mode: included in the `PromptRequestMessage.timeoutMs` field, and the client also starts a local timer
- In non-tunneled mode: creates an `AbortController` with `setTimeout` and passes the signal to inquirer

Each wrapper:
1. Builds a `PromptRequestMessage` with a generated `requestId` and `promptConfig`
2. Checks if the current adapter (via `getLoggerAdapter()`) is an instance of `TunnelAdapter`
3. If tunneled: calls the adapter's `sendPromptRequest()` which sends the message over the tunnel and returns a promise that resolves when the response arrives
4. If not tunneled: sends the message via `sendStructured()` for visibility/logging, then calls the corresponding `@inquirer/prompts` function directly and returns the result

Note: In the tunneled path, `sendPromptRequest()` sends the message as a structured tunnel message. The server receives it, dispatches it via `sendStructured()` for logging on the server side, and then calls the prompt handler. So visibility is preserved in both paths.

Also update `src/logging/console_formatter.ts` to handle the `prompt_request` message type — format it similarly to `input_required` (display the prompt message text).

### Phase 5: Call Site Migration

**Step 7: Migrate key call sites**

Migrate these 4 call sites to use the wrapper functions:

1. **`src/tim/workspace/workspace_auto_selector.ts`**: Replace `confirm()` call at line ~147 with `promptConfirm()`. Remove the preceding `sendStructured({ type: 'input_required' })` call since the wrapper handles notification internally.

2. **`src/tim/executors/claude_code/permissions_mcp_setup.ts`**: Replace `select()` call at line ~292 with `promptSelect()`. Remove the preceding `sendStructured({ type: 'input_required' })` call.

3. **`src/tim/commands/agent/batch_mode.ts`**: Replace `confirm()` call at line ~328 with `promptConfirm()`. Remove the preceding `sendStructured({ type: 'input_required' })` call.

4. **`src/tim/commands/agent/agent.ts`**: Replace `confirm()` call at line ~856 with `promptConfirm()`. Remove the preceding `sendStructured({ type: 'input_required' })` call.

### Phase 6: Testing

**Step 8: Protocol and validation tests**

- Add `prompt_request` validation tests to `tunnel_server.test.ts`
- Test validation of all fields (requestId, promptType, promptConfig, choices, timeoutMs)
- Test that invalid prompt_request messages are rejected

**Step 9: Bidirectional transport tests**

Add tests to `tunnel_client.test.ts` and `tunnel_integration.test.ts`:
- Client sends prompt_request, server writes prompt_response, client resolves
- Timeout behavior (no response within timeout → promise rejects)
- Connection loss during pending request → promise rejects
- Multiple concurrent prompt requests from the same client
- Unknown requestId responses are silently ignored

**Step 10: Prompt wrapper and handler tests**

Create test files for the new modules:
- `src/common/prompt.test.ts` — Test wrapper with real tunnel (server + client), mock the actual inquirer calls to avoid TTY requirements. Test fallback path (no tunnel → direct inquirer call, also mocked). Test error propagation.
- `src/logging/tunnel_prompt_handler.test.ts` — Test prompt type mapping, timeout via AbortController, error handling for unsupported types

### Phase 7: Integration with TunnelServer Creation Sites

**Step 11: Wire up the prompt handler in subagent.ts and other tunnel server creation sites**

Update `src/tim/commands/subagent.ts` (and other files that call `createTunnelServer`) to pass the `onPromptRequest` handler:

```typescript
const promptHandler = createPromptRequestHandler();
tunnelServer = await createTunnelServer(tunnelSocketPath, { onPromptRequest: promptHandler });
```

Similarly update `src/tim/executors/claude_code.ts` and `src/tim/executors/codex_cli/codex_runner.ts` if they create tunnel servers.

### Manual Testing Steps

1. Run `tim subagent` with a plan that triggers an interactive prompt (e.g., review with issues)
2. Verify the orchestrator receives the prompt request and displays the inquirer prompt
3. Select an option and verify the response flows back to the subagent
4. Test timeout behavior by not responding within the timeout period
5. Test the non-tunneled path by running the same command directly (not as a subagent)

### Rationale for Key Decisions

**Why a new `prompt_request` type instead of extending `input_required`?** Clean separation of concerns. `input_required` remains a simple notification ("the system needs input now"). `prompt_request` is a new interactive message with request/response semantics, correlation IDs, and structured config. Avoids muddying the existing type with optional fields that change its semantics.

**Why a separate `ServerTunnelMessage` union?** Maintains clear protocol directionality in the type system. `TunnelMessage` is client→server, `ServerTunnelMessage` is server→client. Prevents accidentally sending a response type where a request type is expected.

**Why use the same Unix socket for bidirectional communication?** The socket is already bidirectional at the OS level. Adding a second socket would double the setup/teardown complexity. The existing JSONL framing works in both directions. Message types are easily distinguished.

**Why not change the LoggerAdapter interface?** Adding a new method to LoggerAdapter would require updating all implementations (ConsoleAdapter, SilentAdapter, TunnelAdapter, RecordingAdapter in tests). Instead, the prompt wrapper checks if the adapter is specifically a TunnelAdapter and uses its `sendPromptRequest` method directly.

**Why no default timeout?** Prompts wait indefinitely by default. Users may need time to read context, consult documentation, or think about their response. Callers can opt in to timeouts where appropriate.

**Why defer `editor` and `search` prompt types?** These require real-time interactive TTY access that can't be meaningfully proxied over a message-passing protocol. They're also not used in any subagent-reachable code paths currently.

**Why JSON-serializable values only for choices?** Simplicity and reliability. Arbitrary objects would require custom serialization/deserialization and the receiving side would need to reconstruct types. Primitives round-trip cleanly through JSON.

## Current Progress
### Current State
- All 8 tasks are complete. The full bidirectional tunnel prompt system is implemented end-to-end.
### Completed (So Far)
- Task 1: `PromptRequestMessage` type added to `structured_messages.ts` with requestId, promptType, promptConfig, timeoutMs. `TunnelPromptResponseMessage` and `ServerTunnelMessage` added to `tunnel_protocol.ts`.
- Task 2: `prompt_request` validation added to `isValidStructuredMessagePayload` in `tunnel_server.ts` with comprehensive field validation. 17 validation tests added.
- Task 3: `TunnelAdapter` extended with bidirectional transport — `createLineSplitter()`, data handler, `pendingPrompts` map, `sendPromptRequest()`, and rejection on close/error/destroy. 13 client tests added.
- Task 4: `createTunnelServer` accepts `onPromptRequest` callback with socket-bound `writeResponse` function. Handler exceptions are isolated and sent as error responses. 10 integration tests added.
- Console formatter updated to display `prompt_request` messages.
- Review fixes (tasks 1-4): send failure detection in `sendPromptRequest()`, handler exception isolation in server, tautological validation removed, JSDoc added to protocol types.
- Task 5: `createPromptRequestHandler()` in `src/logging/tunnel_prompt_handler.ts` maps promptType to @inquirer/prompts functions, translates promptConfig, handles timeoutMs via AbortController. 12 tests added.
- Task 6: Prompt wrappers (`promptConfirm`, `promptSelect`, `promptInput`, `promptCheckbox`) in `src/common/prompt.ts`. Auto-detect tunnel via `getLoggerAdapter() instanceof TunnelAdapter`. Tunneled path uses `sendPromptRequest()`, non-tunneled path calls inquirer directly with `sendStructured()` for visibility. 15 tests added.
- Review fixes (tasks 5-6): Checkbox description field preserved in handler mapping, `PromptRequestHandler` return type updated to `void | Promise<void>`, async handler rejection now caught in tunnel server, integration test for async handler rejection added.
- Task 7: Migrated 4 call sites to prompt wrappers: `workspace_auto_selector.ts` (promptConfirm), `permissions_mcp_setup.ts` (promptSelect with timeoutMs), `batch_mode.ts` (promptConfirm), `agent.ts` (promptConfirm). Removed preceding `sendStructured({ type: 'input_required' })` calls and unused `@inquirer/prompts` imports.
- Task 8: Wired `createPromptRequestHandler()` into all `createTunnelServer` call sites: `subagent.ts`, `claude_code.ts` (both execute and executeReviewMode), `codex_runner.ts`. Tests added to verify `onPromptRequest` is passed.
- Review fixes (tasks 7-8): Added `isPromptTimeoutError()` helper to `src/common/prompt.ts` — `permissions_mcp_setup.ts` now only applies `defaultResponse` fallback on timeout/abort errors, denying on other errors (tunnel disconnect, transport failures). Removed unused `confirm`/`editor` imports from `claude_code.ts`. Removed unnecessary type assertion in `tunnel_server.ts`.
### Remaining
- None — all tasks complete.
### Next Iteration Guidance
- Plan is complete. Manual testing recommended: run `tim subagent` with a plan that triggers interactive prompts to verify end-to-end tunnel flow.
### Decisions / Changes
- `send()` method on `TunnelAdapter` now returns `boolean` (was void). This was needed for the `sendPromptRequest()` send-failure detection fix.
- Server handler exceptions are isolated from JSON parse errors and result in explicit `prompt_response` error messages sent back to the client.
- `PromptRequestHandler` return type is `void | Promise<void>` — the server handles async rejections via `.catch()` on the returned promise.
- `isPromptTimeoutError()` exported from `src/common/prompt.ts` distinguishes timeout/abort errors from transport failures, used in `permissions_mcp_setup.ts` to avoid auto-approving on non-timeout errors.
### Risks / Blockers
- None
