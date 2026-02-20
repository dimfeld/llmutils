---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Enable app server mode for codex
goal: ""
id: 179
uuid: c3cc196c-52f8-4e4a-a640-0b973d23a5bd
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-02-20T10:08:40.304Z
promptsGeneratedAt: 2026-02-20T10:08:40.304Z
createdAt: 2026-02-13T06:45:35.045Z
updatedAt: 2026-02-20T21:20:46.839Z
tasks:
  - title: Create JSON-RPC connection manager (app_server_connection.ts)
    done: true
    description: >-
      Create `src/tim/executors/codex_cli/app_server_connection.ts` with a
      `CodexAppServerConnection` class.


      Responsibilities:

      - Start `codex app-server` subprocess via `Bun.spawn` with `stdio:
      ['pipe', 'pipe', 'pipe']`

      - Manage JSON-RPC 2.0 protocol: auto-incrementing `id` counter, pending
      request Map<number, {resolve, reject}> for response correlation

      - Read stdout line-by-line using `createLineSplitter()` from
      `src/common/process.ts`

      - Classify incoming messages into three types:
        1. Responses (have `id` + `result`/`error`, no `method`): resolve/reject pending request promises
        2. Notifications (have `method`, no `id`): dispatch to `onNotification` callback
        3. Server requests (have both `method` and `id`): dispatch to `onServerRequest` callback, send response back via stdin
      - Handle `initialize` handshake: send initialize request with
      clientInfo={name:"tim", title:"tim", version:"1.0.0"}, await response,
      send `initialized` notification

      - Provide typed methods: `threadStart()`, `turnStart()`, `turnSteer()`,
      `turnInterrupt()`

      - Handle process lifecycle: graceful `close()`, unexpected exit detection,
      `isAlive` getter

      - Set environment variables: `TIM_EXECUTOR: 'codex'`, `AGENT: '1'`,
      `TIM_NOTIFY_SUPPRESS: '1'`, plus tunnel socket path

      - Log stderr as-is (not JSON)


      Public API:

      ```typescript

      class CodexAppServerConnection {
        static async create(options: ConnectionOptions): Promise<CodexAppServerConnection>
        async threadStart(params: ThreadStartParams): Promise<ThreadResult>
        async turnStart(params: TurnStartParams): Promise<TurnResult>
        async turnSteer(params: TurnSteerParams): Promise<{turnId: string}>
        async turnInterrupt(params: {threadId: string, turnId: string}): Promise<void>
        async close(): Promise<void>
        get isAlive(): boolean
      }

      ```


      ConnectionOptions should include: cwd, env (for tunnel socket etc.),
      onNotification callback, onServerRequest callback.


      Write tests in `app_server_connection.test.ts` covering:

      - JSON-RPC message serialization (request format with method, params, id)

      - Response correlation (matching response id to pending request)

      - Notification vs response vs server-request classification

      - Initialize handshake sequence

      - Error response handling (reject pending promise)

      - Unexpected process exit handling
  - title: Create approval handler (app_server_approval.ts)
    done: true
    description: >-
      Create `src/tim/executors/codex_cli/app_server_approval.ts` with approval
      handling for app-server command/file change requests.


      This follows the same pattern as `permissions_mcp_setup.ts` but adapted
      for the app-server JSON-RPC protocol.


      The handler receives server requests dispatched by the connection manager
      and returns response objects.


      Key implementation:

      - Export a `createApprovalHandler()` factory that takes config options and
      returns an async handler function matching the `onServerRequest` callback
      signature: `(method: string, id: number, params: any) => Promise<any>`

      - Maintain an in-memory allowed tools map using `parseAllowedToolsList()`
      from `permissions_mcp_setup.ts` (export it if not already exported)

      - When `ALLOW_ALL_TOOLS` env var is set, auto-approve everything

      - For `item/commandExecution/requestApproval`:
        - Extract command from params
        - Check against allowed prefixes in the tools map
        - If not allowed, prompt user interactively using `promptSelect()` from `src/common/input.ts`
        - Support Allow / Allow for Session / Always Allow / Decline choices
        - For Always Allow, persist via `addPermissionToFile()` pattern from permissions_mcp_setup.ts
        - Return `{decision: 'accept'}` or `{decision: 'decline'}`
      - For `item/fileChange/requestApproval`:
        - Auto-approve when sandbox policy allows writes
        - Otherwise prompt user
        - Return `{decision: 'accept'}` or `{decision: 'decline'}`
      - For unrecognized server request methods, return a JSON-RPC error
      response


      Write tests in `app_server_approval.test.ts` covering:

      - Auto-approve when ALLOW_ALL_TOOLS is set

      - Auto-approve commands matching allowed prefixes

      - Decline for unknown commands (mock the prompt to return decline)

      - File change approval logic
  - title: Create app-server notification formatter (app_server_format.ts)
    done: true
    description: >-
      Create `src/tim/executors/codex_cli/app_server_format.ts` with a fresh
      formatter for app-server JSON-RPC notifications.


      This is NOT a translation layer over the old format.ts -- it handles
      app-server notification payloads natively. The old codex exec format code
      will eventually be removed.


      Export `createAppServerFormatter()` that returns:

      - `handleNotification(method: string, params: any): FormattedCodexMessage`
      -- processes a single notification

      - `getFinalAgentMessage(): string | undefined`

      - `getFailedAgentMessage(): string | undefined`

      - `getThreadId(): string | undefined`

      - `getSessionId(): string | undefined`


      Use `FormattedCodexMessage` type from `format.ts` (just the type, not the
      formatting functions).


      Notification method handling:

      - `thread/started` -- extract threadId from params, return structured
      `buildSessionStart()` message

      - `turn/started` -- return `agent_step_start` structured message

      - `turn/completed` -- extract token usage from params.turn, build
      token_usage structured message. Extract status
      (completed/interrupted/failed) for error handling.

      - `item/started` and `item/completed` -- route by `params.item.type`:
        - `agentMessage` -- extract text, detect failure via `FAILED:` prefix check, capture as agentMessage
        - `reasoning` -- build `llm_thinking` structured message
        - `commandExecution` -- use `buildCommandResult()` from shared builders. Extract command, exitCode, aggregatedOutput, status
        - `fileChange` -- build `file_change_summary` structured message from params.item.changes array (each has path, kind: create/modify/delete, diff)
        - `plan` -- build `llm_status` structured message with plan text
        - `mcpToolCall` -- build `llm_status` with tool name and status
        - `webSearch` -- build `llm_status` with query
        - Other types -- build generic `llm_status`
      - `item/agentMessage/delta` -- skip (noisy streaming deltas)

      - `item/commandExecution/outputDelta` -- skip

      - Other delta methods -- skip

      - `turn/diff/updated` -- handle similar to old diff formatting, build
      `file_change_summary`

      - `turn/plan/updated` -- build `llm_status` with plan steps

      - Unknown methods -- build generic `llm_status` with serialized params


      Reuse shared structured message builders from
      `src/tim/executors/shared/structured_message_builders.ts`.


      The failure detection pattern: check if agentMessage text starts with
      `FAILED:` on the first non-empty line (same logic as `detectFailure()` in
      format.ts but reimplemented cleanly).


      Write tests in `app_server_format.test.ts` covering:

      - Each item type notification producing correct FormattedCodexMessage

      - Agent message capture and final message extraction

      - Failure detection in agent messages

      - Thread/session ID extraction

      - Turn completed with token usage

      - Unknown notification methods handled gracefully
  - title: Update CodexStepOptions to support inline outputSchema
    done: true
    description: >-
      Update `CodexStepOptions` in `src/tim/executors/codex_cli/codex_runner.ts`
      to add an `outputSchema` field alongside the existing `outputSchemaPath`.


      Changes to `codex_runner.ts`:

      - Add `outputSchema?: Record<string, unknown>` to `CodexStepOptions`
      interface

      - The existing `executeCodexStep()` function continues to use
      `outputSchemaPath` for the `codex exec` path (write to temp file if
      `outputSchema` is provided but `outputSchemaPath` is not -- but only for
      the old runner)

      - Document that `outputSchema` is preferred and `outputSchemaPath` is for
      backward compatibility with `codex exec`


      Changes to `review_mode.ts`:

      - In `executeCodexReviewWithSchema()`, pass the schema object directly via
      `outputSchema` instead of writing to a temp file

      - The temp file writing is still needed when the old runner is used, so
      keep both paths: if app-server mode, pass inline; otherwise write temp
      file as before

      - Simplest approach: always pass both `outputSchema` (the object) and
      `outputSchemaPath` (the temp file). The old runner uses the path, the new
      runner uses the object. The temp file creation can be skipped entirely
      when using app-server mode by checking the env var.


      This is a small, focused change that enables the app-server runner to use
      inline schemas.
  - title: Create app-server runner (app_server_runner.ts)
    done: true
    description: >-
      Create `src/tim/executors/codex_cli/app_server_runner.ts` with the
      `executeCodexStepViaAppServer()` function.


      Signature:

      ```typescript

      export async function executeCodexStepViaAppServer(
        prompt: string,
        cwd: string,
        timConfig: TimConfig,
        options?: CodexStepOptions
      ): Promise<string>

      ```


      Flow:

      1. Compute sandbox and approval config:
         - If `ALLOW_ALL_TOOLS` env var is set: `approvalPolicy: 'never'`, sandbox: `{type: 'dangerFullAccess'}`
         - Otherwise: approval policy from config or default to `'unlessTrusted'`, sandbox: `{type: 'workspaceWrite', writableRoots: [...]}`
         - Include `timConfig.externalRepositoryConfigDir` in writableRoots when `timConfig.isUsingExternalStorage`

      2. Set up tunnel server (same pattern as current codex_runner.ts):
         - If not already in tunnel context (`!isTunnelActive()`), create tunnel server with temp dir
         - Create prompt request handler
         - Build tunnel env vars

      3. Create approval handler via `createApprovalHandler()` from
      app_server_approval.ts


      4. Create formatter via `createAppServerFormatter()` from
      app_server_format.ts


      5. Create connection via `CodexAppServerConnection.create()` with:
         - cwd
         - env: `{...process.env, TIM_EXECUTOR: 'codex', AGENT: '1', TIM_NOTIFY_SUPPRESS: '1', ...tunnelEnv}`
         - onNotification: feed through formatter.handleNotification(), dispatch structured messages via sendStructured()
         - onServerRequest: delegate to approval handler

      6. Create thread via `connection.threadStart()` with sandbox config,
      approval policy, cwd


      7. Compute reasoning effort: map `options.reasoningLevel` directly (pass
      `xhigh` through as-is)


      8. Retry loop (max 3 attempts):
         a. Start turn via `connection.turnStart()` with:
            - threadId from step 6
            - input: `[{type: 'text', text: prompt}]`
            - effort: reasoning level
            - outputSchema: `options.outputSchema` if provided
         b. Set up inactivity timeout: reset timer on each notification, kill via `connection.turnInterrupt()` if no activity
            - Initial timeout: 1 minute before first notification
            - Sustained timeout: `options.inactivityTimeoutMs` or `CODEX_OUTPUT_TIMEOUT_MS` env var or 10 minutes default
         c. Wait for `turn/completed` notification (use a Promise that resolves when formatter sees turn/completed)
         d. Check turn status from turn/completed params:
            - If completed successfully: extract final agent message, break
            - If failed/interrupted: log warning, continue retry loop
         e. On retry, start a new turn in the same thread with prompt 'continue'

      9. Close connection (kills the app-server process)


      10. Clean up tunnel server and temp directory


      11. Extract and return final agent message from formatter. Check for
      failed message first (same as current runner). Throw if no final message
      found.


      Write tests in `app_server_runner.test.ts` covering:

      - Happy path: connection -> thread -> turn -> completed -> agent message
      returned

      - Inactivity timeout triggers turn interrupt and retry

      - Turn failure triggers retry

      - Max retries exhausted throws error

      - Output schema passed through to turnStart

      - Tunnel server setup and cleanup

      - Approval handler wired correctly
  - title: Integrate app-server runner with environment variable switch
    done: true
    description: >-
      Modify `src/tim/executors/codex_cli/codex_runner.ts` to route to the
      app-server runner when `CODEX_USE_APP_SERVER` env var is set.


      At the top of `executeCodexStep()`, before any existing logic, add:

      ```typescript

      if (process.env.CODEX_USE_APP_SERVER === '1' ||
      process.env.CODEX_USE_APP_SERVER === 'true') {
        return executeCodexStepViaAppServer(prompt, cwd, timConfig, options);
      }

      ```


      Use a regular import at the top of the file for
      `executeCodexStepViaAppServer`.


      No other changes to the existing runner logic -- the old path remains
      completely untouched.


      Write a simple test verifying the routing: when env var is set, the
      app-server function is called; when unset, the old path runs.
  - title: Update README with CODEX_USE_APP_SERVER documentation
    done: true
    description: >-
      Add a brief section to the README documenting the `CODEX_USE_APP_SERVER`
      environment variable.


      Note that:

      - Setting `CODEX_USE_APP_SERVER=1` enables the experimental app-server
      mode for the Codex executor

      - This uses the Codex app-server JSON-RPC protocol instead of `codex exec`

      - It enables richer interaction including the ability to send input during
      execution

      - This is experimental and the old runner remains the default

      - Set `CODEX_USE_APP_SERVER=` (empty) or unset to revert to the old runner
  - title: "Address Review Feedback: Resource leak in
      `CodexAppServerConnection.create()` if `initialize()` fails."
    done: true
    description: >-
      Resource leak in `CodexAppServerConnection.create()` if `initialize()`
      fails. The `create()` static method spawns a child process in the
      constructor (line 111), then calls `await connection.initialize()`. If the
      initialize handshake fails (e.g., the codex binary produces unexpected
      output, crashes during init, or responds with a JSON-RPC error), the
      exception propagates to the caller, but the spawned process is never
      cleaned up. The caller doesn't receive the connection object, so it has no
      way to call `close()`. This could happen in practice if the codex binary
      version doesn't support the app-server mode, or if there's an incompatible
      protocol change.


      Suggestion: Wrap `initialize()` in a try-catch within `create()` that
      calls `connection.close()` on failure before re-throwing:

      ```typescript

      static async create(options: ConnectionOptions):
      Promise<CodexAppServerConnection> {
        const connection = new CodexAppServerConnection(options);
        try {
          await connection.initialize();
        } catch (err) {
          await connection.close();
          throw err;
        }
        return connection;
      }

      ```


      Related file: src/tim/executors/codex_cli/app_server_connection.ts:122-126
  - title: 'Address Review Feedback: Env var cleanup bug in
      `codex_cli.review_mode.test.ts` will set `CODEX_USE_APP_SERVER` to the
      string `"undefined"` instead of deleting it.'
    done: true
    description: >-
      Env var cleanup bug in `codex_cli.review_mode.test.ts` will set
      `CODEX_USE_APP_SERVER` to the string `"undefined"` instead of deleting it.
      The test captures `originalUseAppServer` and restores it in `afterEach`
      via direct assignment: `process.env.CODEX_USE_APP_SERVER =
      originalUseAppServer`. Per the project's own lessons learned: "In
      Node/Bun, `process.env.X = undefined` sets the value to the string
      `'undefined'`, not to `undefined`. Use `delete process.env.X` for cleanup
      when the original value was undefined." Other test files in this PR handle
      this correctly (e.g., `app_server_runner.test.ts:159-169`,
      `codex_runner.app_server_switch.test.ts:14-19`).


      Suggestion: Use the same conditional cleanup pattern as other test files:

      ```typescript

      afterEach(() => {
        moduleMocker.clear();
        if (originalUseAppServer === undefined) {
          delete process.env.CODEX_USE_APP_SERVER;
        } else {
          process.env.CODEX_USE_APP_SERVER = originalUseAppServer;
        }
      });

      ```


      Related file: src/tim/executors/codex_cli.review_mode.test.ts:115-124
changedFiles:
  - CLAUDE.md
  - README.md
  - src/tim/commands/agent/agent.ts
  - src/tim/executors/claude_code/permissions_mcp_setup.ts
  - src/tim/executors/codex_cli/app_server_approval.test.ts
  - src/tim/executors/codex_cli/app_server_approval.ts
  - src/tim/executors/codex_cli/app_server_connection.test.ts
  - src/tim/executors/codex_cli/app_server_connection.ts
  - src/tim/executors/codex_cli/app_server_format.test.ts
  - src/tim/executors/codex_cli/app_server_format.ts
  - src/tim/executors/codex_cli/app_server_runner.test.ts
  - src/tim/executors/codex_cli/app_server_runner.ts
  - src/tim/executors/codex_cli/codex_runner.app_server_switch.test.ts
  - src/tim/executors/codex_cli/codex_runner.ts
  - src/tim/executors/codex_cli/review_mode.ts
  - src/tim/executors/codex_cli.review_mode.test.ts
  - tim-gui/TimGUI/PromptViews.swift
  - tim-gui/TimGUI/SessionModels.swift
  - tim-gui/TimGUITests/SessionModelTests.swift
tags: []
---

Codex has an app server mode described at https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md. We
should replace our existing codex runner with this because it allows sending input into the process.

To start, implement this in a new file and allow switching back to the old one via environment variable while we work
out all the kinks.

## Research

### Overview

The Codex CLI currently uses a fire-and-forget execution model via `codex exec`. Each orchestration step (implementer, tester, fixer) spawns a fresh subprocess with `stdio: ['ignore', 'pipe', 'pipe']` — stdin is ignored. This means we cannot send follow-up input or steer the agent mid-turn. The Codex app-server mode provides a persistent JSON-RPC 2.0 interface over stdio that supports sending input during execution, thread management, and richer event streaming.

### Current Architecture

#### `executeCodexStep()` — The Core Runner (`src/tim/executors/codex_cli/codex_runner.ts`)

This is the single entry point all mode handlers call. Key characteristics:

- **Command construction**: Builds `codex --enable web_search_request exec -c model_reasoning_effort={level} --sandbox workspace-write --json {prompt}`
- **Subprocess spawning**: Uses `spawnAndLogOutput()` from `src/common/process.ts` with `stdio: ['ignore', 'pipe', 'pipe']` — no stdin
- **Output parsing**: Uses `createCodexStdoutFormatter()` from `format.ts` to parse newline-delimited JSON events
- **Retry logic**: Up to 3 attempts. On retry, uses `resume {threadId} continue` instead of a fresh prompt
- **Inactivity timeout**: 1 minute initial, 10 minutes sustained (configurable via `CODEX_OUTPUT_TIMEOUT_MS`)
- **Tunnel server**: Creates a Unix socket tunnel for output forwarding from child processes when not already in tunnel context
- **Environment variables set**: `TIM_EXECUTOR=codex`, `AGENT=1`, `TIM_NOTIFY_SUPPRESS=1`, plus tunnel socket path

#### Mode Handlers

All mode handlers in `src/tim/executors/codex_cli/` call `executeCodexStep()` with different prompts:

- **`normal_mode.ts`**: Implementer (up to 4 attempts with planning-without-implementation detection) → Tester → External review → Fix-and-review loop (up to 7 iterations)
- **`simple_mode.ts`**: Implementer → External review → Fix-and-review loop (up to 5 iterations)
- **`bare_mode.ts`**: Single prompt, no orchestration
- **`review_mode.ts`**: Single prompt with `--output-schema` for structured JSON output, 30-minute timeout

Each mode handler constructs prompts, calls `executeCodexStep()`, parses the output for failures/task completions, and may loop for retries.

#### Output Formatter (`src/tim/executors/codex_cli/format.ts`)

The formatter handles the Codex `exec` JSON streaming output format:

- **Event types parsed**: `thread.started`, `turn.started`, `turn.completed`, `item.started`, `item.updated`, `item.completed`, `item.delta`, `session.created`
- **Item types**: `reasoning`, `agent_message`, `todo_list`, `command_execution`, `diff`/`turn_diff`, `patch_apply`/`patch_application`, `file_change`
- **Key outputs**: `FormattedCodexMessage` with `structured` (StructuredMessage for display), `agentMessage` (captured text), `threadId`, `sessionId`, `failed` flag
- **`createCodexStdoutFormatter()`**: Returns a stateful object with `formatChunk()`, `getFinalAgentMessage()`, `getFailedAgentMessage()`, `getThreadId()`, `getSessionId()`

#### Executor Class (`src/tim/executors/codex_cli.ts`)

- Implements the `Executor` interface
- Routes execution modes to the appropriate handler
- Static properties: `name = 'codex-cli'`, options schema in `schemas.ts`
- Config: `codexCliOptionsSchema` with `simpleMode` and `reasoning` levels

#### Executor Registration (`src/tim/executors/build.ts`)

- Registry map: `executors = new Map(...)` with all executor classes
- `createExecutor()`: Validates options, merges config, instantiates executor
- Adding a new executor requires: adding to the map, creating a name constant, creating an options schema

### Codex App-Server Protocol

The app-server uses JSON-RPC 2.0 over stdio (newline-delimited JSON). Key aspects:

#### Lifecycle

1. **Start process**: `codex app-server` (stdio transport by default)
2. **Initialize**: Send `initialize` request with `clientInfo` → receive capabilities → send `initialized` notification
3. **Create thread**: `thread/start` with `model`, `cwd`, `approvalPolicy`, `sandbox` config
4. **Start turn**: `turn/start` with `threadId`, `input` (array of content items), config overrides
5. **Stream notifications**: `item/started`, deltas, `item/completed`, `turn/completed`
6. **Send input**: `turn/steer` to inject input into active turn, or `turn/start` for new turn
7. **Interrupt**: `turn/interrupt` to cancel in-progress turn

#### Key Methods

- **`initialize`**: Required handshake. Params: `clientInfo: {name, title, version}`, `capabilities: {experimentalApi?, optOutNotificationMethods?}`
- **`thread/start`**: Creates thread. Params: `model`, `cwd`, `approvalPolicy` (never/unlessTrusted/always), `sandbox` ({type: 'workspaceWrite', writableRoots?}), `personality`
- **`turn/start`**: Starts a turn. Params: `threadId`, `input: [{type: 'text', text: '...'}]`, `model`, `effort` (low/medium/high), `outputSchema`, `approvalPolicy`, `sandboxPolicy`
- **`turn/steer`**: Adds input to active turn. Params: `threadId`, `input`, `expectedTurnId`
- **`turn/interrupt`**: Cancels turn. Params: `threadId`, `turnId`
- **`thread/resume`**: Reopens existing thread by ID

#### Notification Events

Item lifecycle: `item/started` → optional deltas → `item/completed`

Item types: `userMessage`, `agentMessage`, `plan`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`, `enteredReviewMode`, `exitedReviewMode`, `contextCompaction`

Turn lifecycle: `turn/started` → item events → `turn/completed` (with status: completed/interrupted/failed, token usage)

#### Approval Flow

Commands and file changes can trigger approval requests:
- `item/commandExecution/requestApproval`: Server sends request, client responds with accept/decline
- `item/fileChange/requestApproval`: Same pattern

For our use case, we'll likely use `approvalPolicy: 'never'` (equivalent to `--dangerously-bypass-approvals-and-sandbox`) or `approvalPolicy: 'unlessTrusted'` with `sandbox: {type: 'workspaceWrite'}`.

#### Differences from Current `codex exec`

| Aspect | Current (`codex exec`) | App Server |
|--------|----------------------|------------|
| Process lifecycle | One process per step | Persistent process |
| Input | None (stdin ignored) | `turn/steer`, new turns |
| Protocol | Newline-delimited JSON events | JSON-RPC 2.0 |
| Thread management | Thread ID from events, `resume` command | Explicit thread/start, thread/resume |
| Approval | CLI flags (`--sandbox`, `--dangerously-bypass`) | Per-thread/per-turn `approvalPolicy` and `sandboxPolicy` |
| Output schema | `--output-schema` flag | `outputSchema` in turn/start params |
| Reasoning | `-c model_reasoning_effort=X` | `effort` param in turn/start |

### Key Considerations

1. **The app-server is a long-running process** that needs lifecycle management (start, health check, graceful shutdown). The current model spawns a fresh process per step.

2. **JSON-RPC 2.0 requires request/response correlation** via `id` fields. Notifications (server→client) have no `id`. The client needs to match responses to requests and handle notifications asynchronously.

3. **The formatter needs adaptation**. The app-server emits JSON-RPC notification messages (`{method: "item/started", params: {...}}`), not the flat events the current formatter expects. The notification item payloads are similar in structure but wrapped differently.

4. **Thread management is explicit**. Instead of capturing a thread_id from output and doing `resume threadId continue`, we call `thread/start` once and then use `turn/start` for each step. For retries, we can start a new turn in the same thread rather than resuming the entire CLI.

5. **Approval flow needs handling**. The app-server sends JSON-RPC *requests* (not notifications) for command/file change approval. Unlike the Claude Code executor which uses a separate Unix socket permissions MCP server, the app-server sends these directly over the same stdio pipe. The connection manager must handle both outgoing requests (our calls) and incoming requests (approval prompts from the server). We'll implement approval handling from the start using a similar pattern to the permissions MCP: auto-approve based on allowed tools/sandbox config, prompt the user interactively for unknown tools.

6. **Environment variable switching**: The plan specifies switching via env var. We can use `CODEX_USE_APP_SERVER=1` to opt into the new runner while keeping the old one as default.

### Relevant Files to Create/Modify

**New files:**
- `src/tim/executors/codex_cli/app_server_runner.ts` — The new runner replacing `executeCodexStep()` for app-server mode
- `src/tim/executors/codex_cli/app_server_connection.ts` — JSON-RPC connection management (process lifecycle, message send/receive, request correlation, incoming approval request dispatching)
- `src/tim/executors/codex_cli/app_server_format.ts` — Formatter for app-server JSON-RPC notifications to `FormattedCodexMessage`/`StructuredMessage`
- `src/tim/executors/codex_cli/app_server_approval.ts` — Approval handler for command/file change requests from app-server (reuses patterns from `permissions_mcp_setup.ts`)

**Modified files:**
- `src/tim/executors/codex_cli/codex_runner.ts` — Add env var check to route to app-server runner; update `CodexStepOptions` to support inline `outputSchema` object
- `src/tim/executors/codex_cli/review_mode.ts` — Pass inline schema object instead of writing to temp file when using app-server

## Implementation Guide

### Architecture Approach

The core idea is to create a **drop-in replacement** for `executeCodexStep()` that uses the app-server protocol internally while producing the same output. The mode handlers (normal_mode, simple_mode, bare_mode, review_mode) won't need changes — they'll continue to call `executeCodexStep()`, which will route to the app-server implementation when `CODEX_USE_APP_SERVER=1` is set.

Each `executeCodexStep()` call will spawn a fresh `codex app-server` process, matching the current one-process-per-step isolation model. No persistent server or connection reuse across steps.

### Step 1: Create the JSON-RPC Connection Manager (`app_server_connection.ts`)

Create `src/tim/executors/codex_cli/app_server_connection.ts` with a `CodexAppServerConnection` class:

**Responsibilities:**
- Start the `codex app-server` subprocess using `Bun.spawn` with `stdio: ['pipe', 'pipe', 'pipe']`
- Manage the JSON-RPC 2.0 protocol: request/response correlation, notification dispatching
- Handle the `initialize` handshake
- Provide typed methods for each JSON-RPC call: `threadStart()`, `turnStart()`, `turnSteer()`, `turnInterrupt()`
- Handle process lifecycle: graceful shutdown, unexpected exit detection

**Key implementation details:**
- Use an auto-incrementing `id` counter for JSON-RPC requests
- Store pending requests in a `Map<number, {resolve, reject}>` for promise-based correlation
- Read stdout line-by-line using `createLineSplitter()` from `src/common/process.ts` (the existing line splitter handles partial chunks)
- **Three kinds of messages from stdout:**
  1. **Responses** (have `id` + `result`/`error`, no `method`): Resolve/reject the matching pending request promise
  2. **Notifications** (have `method`, no `id`): Dispatch to the notification callback (formatter)
  3. **Server requests** (have both `method` and `id`): Approval requests from the server. Dispatch to the approval handler, which sends a response back via stdin with the matching `id`
- Set environment variables matching current pattern: `TIM_EXECUTOR: 'codex'`, `AGENT: '1'`, `TIM_NOTIFY_SUPPRESS: '1'`, plus tunnel socket path

**Constructor params:**
- `cwd: string` — working directory
- `timConfig: TimConfig` — for sandbox/writable roots config
- `onNotification: (method: string, params: any) => void` — callback for server notifications
- `onServerRequest: (method: string, id: number, params: any) => Promise<any>` — callback for server-initiated requests (approval flow)

**Public API:**
```typescript
class CodexAppServerConnection {
  static async create(options: ConnectionOptions): Promise<CodexAppServerConnection>
  async threadStart(params: ThreadStartParams): Promise<ThreadResult>
  async turnStart(params: TurnStartParams): Promise<TurnResult>
  async turnSteer(params: TurnSteerParams): Promise<{turnId: string}>
  async turnInterrupt(params: {threadId: string, turnId: string}): Promise<void>
  async close(): Promise<void>
  get isAlive(): boolean
}
```

**Approval handling (server requests):**

The app-server sends `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` as JSON-RPC requests with an `id`. The connection manager dispatches these to an `onServerRequest` callback, which returns a result object that gets sent back as the JSON-RPC response.

The approval handler follows the same pattern as `permissions_mcp_setup.ts`:
- Maintain an allowed tools map (parsed from config, same `parseAllowedToolsList()` helper)
- Auto-approve commands matching allowed prefixes
- Auto-approve file changes when sandbox policy permits
- When `ALLOW_ALL_TOOLS` is set, auto-approve everything
- Otherwise, prompt the user interactively using `promptSelect()` from `src/common/input.ts`
- Support "Allow for Session" (add to in-memory map) and "Always Allow" (persist to `.claude/settings.local.json` and DB via `addPermissionToFile()`)

The approval response format (from app-server docs):
```typescript
// For command approval:
{ decision: 'accept' | 'decline', acceptSettings?: { forSession: boolean } }
// For file change approval:
{ decision: 'accept' | 'decline' }
```

**Sandbox configuration mapping:**
- Current `--sandbox workspace-write` → `{type: 'workspaceWrite', writableRoots: [...]}`
- Current `--dangerously-bypass-approvals-and-sandbox` → `approvalPolicy: 'never'` + appropriate sandbox policy
- Writable roots from `timConfig.externalRepositoryConfigDir` included when `timConfig.isUsingExternalStorage`

### Step 2: Create the App-Server Notification Formatter (`app_server_format.ts`)

Create `src/tim/executors/codex_cli/app_server_format.ts`:

**Purpose:** Format app-server JSON-RPC notifications into `StructuredMessage` objects for display and capture the final agent message. This is a fresh formatter written against the app-server protocol directly, not a translation layer over the old `format.ts`. The old `codex exec` format code will eventually be removed, so this should be clean and idiomatic for the app-server message shapes.

**Approach:** Write a new formatter that handles the app-server notification methods directly:
- `item/started`, `item/completed` — route by item `type` field (`agentMessage`, `commandExecution`, `fileChange`, `reasoning`, `plan`, etc.)
- `turn/started`, `turn/completed` — turn lifecycle and token usage
- `thread/started` — thread creation
- `item/agentMessage/delta`, `item/commandExecution/outputDelta`, etc. — streaming deltas

The formatter produces `FormattedCodexMessage` (same type as `format.ts` uses) so the runner can consume it identically. Reuse the shared structured message builders from `src/tim/executors/shared/structured_message_builders.ts` (e.g. `buildCommandResult`, `buildSessionStart`, `buildTodoUpdate`, etc.) which are already used by both Claude Code and Codex formatters.

**Key difference from old formatter:** JSON-RPC *responses* (messages with `id` and `result`/`error`) are handled by the connection manager, not the formatter. The formatter only processes notifications (messages with `method` but no `id`). Also, the connection manager should be the one that dispatches notifications to the formatter, so the formatter doesn't need to do line splitting or JSON parsing — it receives pre-parsed notification objects.

Create a `createAppServerFormatter()` that tracks state and returns `getFinalAgentMessage()`, `getFailedAgentMessage()`, `getThreadId()`, `getSessionId()`, plus a `handleNotification(method: string, params: any): FormattedCodexMessage` method.

### Step 3: Create the App-Server Runner (`app_server_runner.ts`)

Create `src/tim/executors/codex_cli/app_server_runner.ts` with an `executeCodexStepViaAppServer()` function:

**Signature matches `executeCodexStep()`:**
```typescript
async function executeCodexStepViaAppServer(
  prompt: string,
  cwd: string,
  timConfig: TimConfig,
  options?: CodexStepOptions
): Promise<string>
```

**Flow:**
1. Create a `CodexAppServerConnection` (spawn `codex app-server`, run `initialize` handshake)
2. Wire up notification handler → formatter, and server request handler → approval handler
3. Create a thread via `threadStart()` with sandbox config, approval policy, model reasoning level
4. Start a turn via `turnStart()` with the prompt as text input, reasoning effort
5. Listen for notifications, feeding them through the formatter. Approval requests are handled concurrently by the approval handler.
6. Wait for `turn/completed` notification
7. Extract final agent message from formatter
8. Handle retries: if turn fails, start a new turn in the same thread (instead of spawning a new process)
9. Close the connection (kill the app-server process)
10. Return the final agent message string

**Inactivity timeout:** Implement the same timeout pattern — if no notifications arrive within the timeout period, interrupt the turn and retry.

**Output schema support:** `CodexStepOptions` will be updated to accept either a file path (`outputSchemaPath`) or an inline schema object (`outputSchema`). The app-server runner uses the inline object directly in the `turnStart()` params. The old runner continues to use the file path. Review mode (`review_mode.ts`) will be updated to pass the schema object inline instead of writing to a temp file, since the temp file was only needed for the `codex exec --output-schema <file>` CLI flag.

**Tunnel server:** Set up the same tunnel server pattern as current runner for output forwarding from child processes.

### Step 4: Integrate into `codex_runner.ts` with Environment Variable Switch

Modify `src/tim/executors/codex_cli/codex_runner.ts`:

Add a regular import for `executeCodexStepViaAppServer` at the top, then at the top of `executeCodexStep()`, add:
```typescript
if (process.env.CODEX_USE_APP_SERVER === '1' || process.env.CODEX_USE_APP_SERVER === 'true') {
  return executeCodexStepViaAppServer(prompt, cwd, timConfig, options);
}
```

This keeps the old runner as the default and allows opting in to the new one.

### Step 5: Tests

Write tests for:
1. **`app_server_connection.ts`**: JSON-RPC message serialization/deserialization, request correlation, notification dispatching, initialize handshake
2. **`app_server_format.ts`**: Mapping app-server notification formats to `FormattedCodexMessage`, handling all item types, edge cases
3. **`app_server_runner.ts`**: Integration test with mocked connection, timeout handling, retry logic
4. **Environment variable switching**: Verify the right runner is called based on `CODEX_USE_APP_SERVER`

Use the existing test patterns (Bun test runner, temporary directories, avoid heavy mocking where possible).

### Step 6: Update README

Add documentation about the `CODEX_USE_APP_SERVER` environment variable, noting it enables the experimental app-server mode for the Codex executor.

### Rationale for this Approach

**Why a drop-in replacement for `executeCodexStep()` rather than a new executor class?**
- The mode handlers (normal, simple, bare, review) contain significant orchestration logic that doesn't need to change
- The app-server is an implementation detail of *how* we talk to Codex, not a different orchestration strategy
- A drop-in replacement minimizes the blast radius and allows easy rollback via env var

**Why a fresh formatter instead of translating to the old format?**
- The old `codex exec` format will eventually be removed — no point building a translation layer to a dead format
- The app-server protocol has its own conventions (camelCase item types, JSON-RPC envelope) that are cleaner to handle natively
- Shared structured message builders (`buildCommandResult`, etc.) are already abstracted and reusable without depending on the old format

**Why separate connection, formatter, and runner files?**
- Separation of concerns: protocol handling, output formatting, and orchestration are distinct
- Testability: each component can be unit tested independently
- The connection manager can be reused if we later add interactive input support beyond the step-based model

**Why one process per step (no persistent server)?**
- Matches current isolation model — each step gets a fresh context
- Avoids complex connection lifecycle management across steps
- Simplifies error handling — process crash = step failure, clean retry
- Can be evolved later to persistent server for richer multi-step conversations

### Manual Testing Steps

1. Set `CODEX_USE_APP_SERVER=1` in environment
2. Run `tim generate` or `tim agent` with the codex-cli executor
3. Verify structured output in terminal matches previous behavior
4. Verify task completion detection still works
5. Verify failure detection still works
6. Verify review mode with JSON schema output works
7. Compare execution time and token usage between old and new runner
8. Verify fallback: unset env var and confirm old runner is used
9. Test with `ALLOW_ALL_TOOLS=true` to verify sandbox bypass mapping

## Current Progress
### Current State
- All 9 tasks are complete, including review feedback fixes. The Codex app-server mode is fully implemented behind `CODEX_USE_APP_SERVER=1` env var.
### Completed (So Far)
- `app_server_connection.ts`: JSON-RPC 2.0 connection manager with Bun.spawn, message classification (responses/notifications/server requests), initialize handshake, typed methods, shutdown guards, AppServerRequestError, try-catch around notification dispatch. `create()` now cleans up spawned process if `initialize()` fails.
- `app_server_approval.ts`: Approval handler factory with ALLOW_ALL_TOOLS bypass, prefix-based auto-approval, interactive prompt flows (Allow/Session/Always/Decline), prefix selection via promptPrefixSelect, addPermissionToFile persistence
- `app_server_format.ts`: Notification formatter handling all item types (agentMessage, reasoning, commandExecution, fileChange, plan, mcpToolCall, webSearch), thread/session extraction, token usage, failure detection, delta skipping
- `permissions_mcp_setup.ts`: Exported `parseAllowedToolsList()` and `addPermissionToFile()` for reuse
- `app_server_runner.ts`: Full runner with CodexAppServerConnection lifecycle, tunnel server setup, approval handler wiring, formatter + sendStructured dispatch, retry loop (3 attempts), inactivity timeout (initial 1 min + sustained configurable), turn interrupt on timeout
- `codex_runner.ts`: `CODEX_USE_APP_SERVER` env var routing, `outputSchema` field on CodexStepOptions (app-server mode only)
- `review_mode.ts`: Passes inline `outputSchema` alongside `outputSchemaPath`, skips temp file when using app-server mode
- `codex_cli.review_mode.test.ts`: Fixed env var cleanup to use conditional delete pattern
- README updated with `CODEX_USE_APP_SERVER` documentation
- 58+ tests across 5 test files all passing
### Remaining
- None — all tasks complete including review feedback. Ready for manual testing.
### Next Iteration Guidance
- Manual testing needed: set `CODEX_USE_APP_SERVER=1` and run `tim generate`/`tim agent` with codex-cli executor
- Future: wire configured allowed tools from timConfig into the approval handler (currently uses empty allowed tools map, but `approvalPolicy: 'unlessTrusted'` means the server handles most approvals)
### Decisions / Changes
- Connection class takes an `env` record directly; env var setup (TIM_EXECUTOR, AGENT, etc.) is the runner's responsibility
- AppServerRequestError is used for both client→server and server→client errors for programmatic error code access
- Line splitter is always flushed unconditionally after stdout stream ends
- handleServerRequest and writeMessage are guarded against writes to closed stdin during shutdown
- onNotification dispatch is wrapped in try-catch to prevent callback errors from killing stdout processing
- `outputSchema` field on CodexStepOptions is documented as app-server-mode-only
- review_mode.ts skips temp file creation when CODEX_USE_APP_SERVER is set
- Inactivity timer is reset after turnStart resolves to prevent dead-timer if initial timer fires during turnStart
### Lessons Learned
- When a class manages both readable streams and writable sinks, shutdown ordering matters: closing the writable side while still consuming the readable side can cause writes-to-closed-sink errors. Guard write paths with a closing flag.
- Always flush line splitters unconditionally at stream end, not just when there's remaining decoder content — the line splitter has its own separate internal buffer.
- External callback invocations in stream processing loops must be wrapped in try-catch — an unhandled throw kills the entire loop permanently, causing downstream promises to never resolve.
- When an inactivity timer fires during a long async operation (like turnStart), re-arm the timer after the operation completes to ensure coverage during the subsequent wait phase.
- In Node/Bun, `process.env.X = undefined` sets the value to the string "undefined", not to undefined. Use `delete process.env.X` for cleanup when the original value was undefined.
### Risks / Blockers
- None
