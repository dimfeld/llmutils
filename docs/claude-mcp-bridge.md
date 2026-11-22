# Claude `tim` MCP Bridge

The Claude executor installs one internal MCP server, named `tim`, into each
Claude process it launches. That server carries three independent capabilities:

- **Interactive permission approval** (`approval_prompt`), the legacy behavior
  described in [tutorials/claude-permissions-mcp.md](tutorials/claude-permissions-mcp.md).
- **Role-scoped agent-management tools** (`StartTimAgent`, `ListTimAgents`,
  `SendTimAgentMessage`, `StopTimAgent`, `FinishTimAgent`), which route to the
  `AgentManager` documented in [agent-manager.md](agent-manager.md).
- **Session control** (`EndTimSession`), which lets the agent of an interactive
  top-level session end its own session after its current turn. The contract
  (name, description, argument schema, result text) is in
  `src/tim/executors/shared/end_session_tool.ts` and is shared with Codex.

The bridge is transport only. It does not define naming, capacity, delivery, or
lifecycle policy; those belong to [agent-messaging.md](agent-messaging.md) and
[agent-manager.md](agent-manager.md).

Relevant code:

- `src/tim/executors/claude_code/tim_mcp.ts` — standalone FastMCP child process.
  Built to `dist/claude_code/tim_mcp.js` by `build.ts`, and listed as a `knip`
  entrypoint.
- `src/tim/executors/claude_code/claude_mcp_protocol.ts` — request/response
  schemas and the trusted context interfaces. Its tool names, role tool sets,
  and argument schemas are re-exports of the canonical values in
  `agent_messaging/contracts.ts`; the installed tool descriptions come from
  `AGENT_TOOL_DESCRIPTIONS` in that same module, so Claude and Codex advertise
  identical tool metadata.
- `src/tim/executors/claude_code/claude_mcp_parent_server.ts` — parent Unix
  socket server, bounded JSONL framing, and the request router.
- `src/tim/executors/claude_code/claude_mcp_config.ts` — user MCP config reading
  and merging.
- `src/tim/executors/claude_code/setup_claude_mcp_bridge.ts` — temp directory,
  socket, generated config, child argv, path resolution, and cleanup.
- `src/tim/executors/claude_code/permissions_mcp_setup.ts` — permission policy
  (allowlists, Bash prefixes, tracked-file deletion, AskUserQuestion) plus
  `setupPermissionsMcp()`, the entry point that binds policy to the bridge.
- `src/tim/executors/claude_code/claude_mcp_launch.ts` — capability resolution,
  allowed-tool expansion, and Claude argument construction.
- `src/tim/executors/claude_code/claude_permission_prompt_coordinator.ts` —
  FIFO coordinator for interactive prompts.

## Installation states

Approval, agent tools, and session control are separate switches. `prepareClaudeMcpLaunch()`
resolves them with `resolveClaudeMcpCapabilities()`:

- `interactiveApprovalEnabled` = approval requested (config `permissionsMcp.enabled`
  or the `CLAUDE_CODE_MCP` env override) **and not** `allowAllTools` **and not**
  noninteractive.
- `agentToolsEnabled` = an explicit trusted `agentToolContext` was supplied.
- `endSessionToolEnabled` = a trusted `endSessionHandler` was supplied. The main
  executor supplies it only when `ExecutorCommonOptions.endSessionTool` is true.
- `internalMcpNeeded` = any capability.

That gives these states (session control can be added to any of them):

| State           | Registered tools                       | Claude arguments                                        |
| --------------- | -------------------------------------- | ------------------------------------------------------- |
| Not installed   | none                                   | the user's `--mcp-config` path, unchanged, if it exists |
| Permission-only | `approval_prompt`                      | `--mcp-config <generated>` + `--permission-prompt-tool` |
| Tools-only      | role-scoped agent tools                | `--mcp-config <generated>` only                         |
| Combined        | `approval_prompt` + role-scoped agents | `--mcp-config <generated>` + `--permission-prompt-tool` |
| Session-only    | `EndTimSession`                        | `--mcp-config <generated>` only                         |
| + session       | the tools above + `EndTimSession`      | as for the state without session control                |

`--permission-prompt-tool mcp__tim__approval_prompt` is emitted **only** when
interactive approval is enabled, so a tools-only run never points Claude at an
unregistered approval tool. Agent tools therefore stay available in
noninteractive and allow-all runs, which is where the collaborative runtime
needs them most.

Review, planning, proof, bare, and legacy one-shot subagent runs get no agent
tools, because they pass no `agentToolContext`.

The child learns about session control from the manifest field
`endSessionToolEnabled: true`. The manifest is pushed when agent tools exist,
approval is disabled, or session control is enabled. Like agent tools,
`EndTimSession` stays available in noninteractive and allow-all runs.

### Session control (`EndTimSession`)

The main Claude executor (`claude_code.ts`) passes an `endSessionHandler` when
`endSessionTool` is set. Interactive top-level sessions such as `tim pr fix`,
`tim pr fix-ci`, and `tim pr rebase` use it. The handler logs the reason and
calls `requestEndAfterCurrentTurn()` on the terminal-input lifecycle. It does
**not** close stdin. The MCP call happens inside the turn, so the turn must
continue: Claude receives the tool result, writes its final message, and emits
its `result`. The session then closes through the normal result path (see
[executor-stdin-conventions.md](executor-stdin-conventions.md)). The effect is
the same as the web UI "End session" button, but it waits for the turn to end.
`runClaudeSubprocess()` and persistent agents never install this tool.

## Trusted context and role scoping

`ClaudeAgentToolContext` is parent-only state, bound once when the bridge is
installed:

```ts
interface ClaudeAgentToolContext {
  readonly caller: AgentIdentity; // trusted id, name, role
  readonly allowedTools: ReadonlySet<ClaudeAgentToolName>;
  readonly dispatcher: ClaudeAgentToolDispatcher;
}
```

Callers pass it through `ExecutorCommonOptions.claudeAgentToolContext` (main
executor) or `ClaudeCodeOptions.agentToolContext` (`runClaudeSubprocess()`).
`setupPermissionsMcp()` validates it with `validateClaudeAgentToolContext()`,
then copies and freezes the identity so later mutation cannot change authority.

Role tool sets are fixed:

- `orchestrator` → `StartTimAgent`, `ListTimAgents`, `SendTimAgentMessage`, `StopTimAgent`
- `subagent` → `ListTimAgents`, `SendTimAgentMessage`, `FinishTimAgent`

The child receives only the tool-name list, never the caller identity, ID, name,
or role. No public tool schema has a `source` or `caller` field, and
`FinishTimAgent` has no target name — the parent supplies the caller from its bound
context using `callerIdentityFromAgent()`.

**Child-side filtering is discoverability only.** The parent router repeats
authorization for every request: the tool must be in the bound role's set _and_
in `allowedTools`. A forged `StopTimAgent` frame on a subagent socket returns an
authorization error and never reaches the dispatcher. Tool arguments are
re-validated in the parent with the shared contract schemas from
`agent_messaging/contracts.ts`.

`createClaudeAgentToolDispatcher(manager)` is the only adapter between the
socket router and `AgentManager`. It forwards results verbatim, so the bridge
does not reimplement manager policy.

## Wire protocol

Requests and responses are newline-delimited JSON over a Unix socket in the
bridge temp directory. Both directions use discriminated unions
(`claudeMcpRequestSchema`, `claudeMcpResponseSchema`):

- `permission_request` / `permission_response`
- `agent_tool_request` / `agent_tool_response` (`success: true` with `result`,
  or `success: false` with `error`)
- `session_tool_request` (`tool_name: 'EndTimSession'`, `input`) /
  `session_tool_response` (`success: true` with the `result` text, or
  `success: false` with `error`)

Every frame carries a `requestId`. The child stores the **expected response
type** with each pending request, so a permission response can never resolve an
agent-tool promise or the reverse. Each pending entry owns a timer cleared on
success, failure, socket error, socket close, and test cleanup.

Framing is bounded at 1 MiB per line. An oversized frame is dropped; if the
prefix still contains a readable `requestId` and type, the parent answers with a
correlated denial or agent-tool error instead of leaving the child waiting.
Malformed JSON is logged and ignored. Responses are written only to the socket
that sent the request.

Failure isolation is deliberate:

- `approval_prompt` transport failure stays default-deny.
- Agent-tool failure returns a model-visible tool error (`isError: true`). It
  never becomes a permission decision or affects another request.
- Session-tool failure also returns `isError: true`. The parent validates the
  arguments again with `endSessionToolArgumentsSchema`. If the parent has no
  `endSessionHandler`, it returns an error and changes nothing. Oversized
  session frames get a correlated error.

## Merging the user MCP config

Claude accepts one `--mcp-config`, so the bridge merges rather than replaces:

1. `readUserMcpConfig()` reads and validates the user's file **before** any
   socket or temp directory is allocated. The file must be a JSON object, and
   `mcpServers`, if present, must be an object.
2. The reserved key `tim` is rejected with a clear collision error. The bridge
   never overwrites a user server.
3. `mergeClaudeMcpConfig()` copies every root property and every user server
   exactly, then adds the internal stdio `tim` entry.
4. The merged object is written to `mcp-config.json` in the bridge temp
   directory. The user's file is never modified.

When no capability is needed, no config is generated and the user's original
path is passed through unchanged.

## Allowed tools and disallow conflicts

`prepareClaudeMcpLaunch()` appends the installed role-scoped identifiers
(`mcp__tim__StartTimAgent`, …) to that execution's allowed tools only. They are not
added to the global default Claude allow list. If `disallowedTools` names any
required agent tool, `validateAgentToolDisallowConflict()` throws before any
resource is allocated, rather than advertising a tool the CLI would block.
When session control is enabled, `mcp__tim__EndTimSession` is appended to the
allowed tools in the same way.

Setup failure is treated differently by capability: when an `agentToolContext`
(or a user MCP config) is present, `runClaudeSubprocess()` rethrows so the
provider never starts without its tool bridge. A permission-only setup failure
still degrades to a run with approval disabled.

## FIFO permission-prompt coordinator

One `FifoClaudePermissionPromptCoordinator` per root session is passed to every
Claude bridge in that session
(`ExecutorCommonOptions.claudePermissionPromptCoordinator`). It protects the
single human input channel:

- Allowlist hits, always-allowed Bash suffixes, and tracked-file deletion
  approvals are decided **before** enqueueing, so automatic decisions never
  queue.
- Each queue item holds the trusted requester name, an opaque per-connection
  requester token, the request ID, an `AbortController`, and one callback that
  owns the **whole** interaction. A Bash prefix selection or a multi-question
  `AskUserQuestion` exchange keeps the same slot and is cancelled as a unit.
- Exactly one item runs at a time, in arrival order. Prompts are labeled with
  the trusted name, for example `Claude agent implementer-auth wants to run a
tool:`.
- `cancelRequester(token)` rejects that requester's queued items with
  `ClaudePermissionPromptCancelledError` and aborts its active prompt. The
  parent server calls it on socket `end`/`close` and during cleanup, so an
  exited agent cannot hold the terminal until a timeout fires. A late answer for
  an aborted item is discarded.
- `dispose()` aborts the active item, rejects the queue, and awaits the active
  callback for root teardown.

Timeout semantics are unchanged: `AskUserQuestion` does not use the permission
timeout, and ordinary prompts apply the configured default response only on
timeout while denying other failures.

### External prompt cancellation

Cancellation required an optional `signal` on the prompt wrappers in
`src/common/input.ts`. `runPrompt()` now owns the shared transport lifecycle and
combines the caller's signal with the existing timeout and headless-websocket
signals through `AbortSignal.any()`. A cancelled prompt emits the normal
`prompt-cancelled` structured event and rejects with `PromptCancelledError`.
`TunnelAdapter.sendPromptRequest(message, timeoutMs, signal)` accepts the same
signal and removes its pending request instead of leaving it live.

## Cleanup

`setupClaudeMcpBridge()` returns one idempotent `cleanup()` that cancels
coordinator work for every tracked socket, destroys those sockets, closes the
server, and removes the temp directory. Sockets must be destroyed explicitly —
`server.close()` alone waits for open connections and can hang. Setup failure
after allocation runs the same `cleanup()` before rethrowing.

## Testing

Server-side suites run with `bun run test`:

- `claude_mcp_protocol.test.ts` — schemas, role tool sets, dispatcher adapter.
- `permissions_mcp_agent_tools.test.ts` — role matrices, forged requests,
  correlation isolation, context validation, session-tool routing.
- `permissions_mcp_setup.test.ts` — real Unix-socket permission behavior, JSONL
  framing, config merge, cleanup.
- `claude_permission_prompt_coordinator.test.ts` — FIFO order, atomic
  multi-step interactions, queued and active cancellation.
- `subagent.claude.permissions.test.ts` and `claude_code.test.ts` — the four
  installation states and exact Claude arguments.
- `input.test.ts` and `tunnel_client.test.ts` — external abort behavior.

Renaming the child entrypoint requires `build.ts`, `knip.json`,
`resolvePermissionsMcpPath()`, and the path-resolution tests to change together.
`dist/` is ignored; verify the artifact with `bun run build`.
