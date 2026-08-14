# Claude `tim` MCP Bridge

The Claude executor installs one internal MCP server, named `tim`, into each
Claude process it launches. That server carries two independent capabilities:

- **Interactive permission approval** (`approval_prompt`), the legacy behavior
  described in [tutorials/claude-permissions-mcp.md](tutorials/claude-permissions-mcp.md).
- **Role-scoped agent-management tools** (`StartAgent`, `ListAgents`,
  `SendAgentMessage`, `StopAgent`, `FinishAgent`), which route to the
  `AgentManager` documented in [agent-manager.md](agent-manager.md).

The bridge is transport only. It does not define naming, capacity, delivery, or
lifecycle policy; those belong to [agent-messaging.md](agent-messaging.md) and
[agent-manager.md](agent-manager.md).

Relevant code:

- `src/tim/executors/claude_code/tim_mcp.ts` — standalone FastMCP child process.
  Built to `dist/claude_code/tim_mcp.js` by `build.ts`, and listed as a `knip`
  entrypoint.
- `src/tim/executors/claude_code/claude_mcp_protocol.ts` — tool names, role tool
  sets, request/response schemas, and the trusted context interfaces.
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

Approval and agent tools are separate switches. `prepareClaudeMcpLaunch()`
resolves them with `resolveClaudeMcpCapabilities()`:

- `interactiveApprovalEnabled` = approval requested (config `permissionsMcp.enabled`
  or the `CLAUDE_CODE_MCP` env override) **and not** `allowAllTools` **and not**
  noninteractive.
- `agentToolsEnabled` = an explicit trusted `agentToolContext` was supplied.
- `internalMcpNeeded` = either capability.

That gives four states:

| State           | Registered tools                       | Claude arguments                                        |
| --------------- | -------------------------------------- | ------------------------------------------------------- |
| Not installed   | none                                   | the user's `--mcp-config` path, unchanged, if it exists |
| Permission-only | `approval_prompt`                      | `--mcp-config <generated>` + `--permission-prompt-tool` |
| Tools-only      | role-scoped agent tools                | `--mcp-config <generated>` only                         |
| Combined        | `approval_prompt` + role-scoped agents | `--mcp-config <generated>` + `--permission-prompt-tool` |

`--permission-prompt-tool mcp__tim__approval_prompt` is emitted **only** when
interactive approval is enabled, so a tools-only run never points Claude at an
unregistered approval tool. Agent tools therefore stay available in
noninteractive and allow-all runs, which is where the collaborative runtime
needs them most.

Review, planning, proof, bare, and legacy one-shot subagent runs get no agent
tools, because they pass no `agentToolContext`.

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

- `orchestrator` → `StartAgent`, `ListAgents`, `SendAgentMessage`, `StopAgent`
- `subagent` → `ListAgents`, `SendAgentMessage`, `FinishAgent`

The child receives only the tool-name list, never the caller identity, ID, name,
or role. No public tool schema has a `source` or `caller` field, and
`FinishAgent` has no target name — the parent supplies the caller from its bound
context using `callerIdentityFromAgent()`.

**Child-side filtering is discoverability only.** The parent router repeats
authorization for every request: the tool must be in the bound role's set _and_
in `allowedTools`. A forged `StopAgent` frame on a subagent socket returns an
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
(`mcp__tim__StartAgent`, …) to that execution's allowed tools only. They are not
added to the global default Claude allow list. If `disallowedTools` names any
required agent tool, `validateAgentToolDisallowConflict()` throws before any
resource is allocated, rather than advertising a tool the CLI would block.

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
  correlation isolation, context validation.
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
