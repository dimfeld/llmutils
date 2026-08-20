# Codex CLI Integration

How the Codex CLI executor (`-x codex-cli` / `--orchestrator codex-cli`) runs
plan-backed agent execution, and how it shares the orchestration prompt with the
Claude executor.

## Overview

`tim agent` sends a plan's implementation prompt to a top-level executor. Both
the Claude (`src/tim/executors/claude_code.ts`) and Codex
(`src/tim/executors/codex_cli.ts`) executors use the same broad model: rather
than driving an implement/test/review loop in TypeScript, they wrap the prompt
in a single large **orchestration prompt** and launch one top-level process. That
process then coordinates the actual work by invoking `tim subagent ...` as shell
commands. In batch mode, the orchestrator reviews each selected task batch
itself and may use its native subagent mechanism for help. It invokes
`tim subagent reviewer ...` only for the final full-plan review after every task
is complete.

Both executors set `supportsSubagents = true`. When `experimental.agentMessaging`
is absent or `false`, the orchestration prompts delegate through `tim subagent`
shell commands so each role gets tim-provided plan context, repository
instructions, custom subagent instructions, model selection, and output routing.
When the flag is `true` for a new session, the prompts use collaborative agent
tools (`StartAgent`, `ListAgents`, `SendAgentMessage`, `StopAgent`) instead.
Subagent launches are persistent and messageable rather than synchronous. See
[agent-messaging.md](agent-messaging.md) for the full collaborative mode
reference.

## Codex dynamic tools

The low-level Codex runner (`executeCodexStep()`) does not read
`experimental.agentMessaging` and does not enable the app-server dynamic-tool
protocol on its own. A trusted caller must pass one cohesive
`dynamicToolProvider` to `CodexStepOptions`. The provider contains the trusted
caller identity, the role-scoped definitions, and the handler. Definitions and a
handler cannot be supplied as separate options.

The provider is not installed unless the caller supplies it. This keeps formal
reviews, planning, chat, and bare execution unchanged. When
`experimental.agentMessaging` is `true` for a new root `tim agent` session,
`CollaborativeAgentSession` (`src/tim/commands/agent/collaborative_session.ts`)
builds one `codexDynamicToolProvider` for the session and passes it through
`ExecutorCommonOptions.codexDynamicToolProvider`. The Codex root orchestrator
(`orchestrator_mode.ts`) installs it for the root process, and the same session
launches it for every StartAgent-created persistent Codex subagent. When the
flag is absent or `false`, no `CollaborativeAgentSession` is created and no
provider reaches `CodexStepOptions`, so ordinary Codex runs keep no agent
tools.

Relevant code:

- `src/tim/executors/codex_cli/app_server_dynamic_tools.ts` — tolerant wire
  types, envelope and provider validation, result helpers, and the request
  composer. It is generic: the provider context is opaque here, and this module
  does not import the agent manager.
- `src/tim/executors/codex_cli/codex_agent_tools.ts` — the agent adapter that
  binds trusted identity, builds the role definitions, authorizes each call, and
  invokes the shared manager operations.
- `src/tim/executors/codex_cli/app_server_dynamic_tool_format.ts` —
  `dynamicToolCall` display formatting, called from `app_server_format.ts`.

Tool names, role allowlists, descriptions, and argument schemas are not defined
here. They come from `AGENT_TOOL_NAMES`, `getAgentToolNames()`,
`AGENT_TOOL_DESCRIPTIONS`, and `AGENT_ARGUMENT_SCHEMAS` in
`src/tim/agent_messaging/contracts.ts`, so Codex and the Claude MCP bridge
advertise identical tool metadata ([agent-messaging.md](agent-messaging.md)).

### Disabled wire behavior

When no provider is supplied, `initialize.params` contains exactly the existing
`clientInfo` object. It has no `capabilities` field. The first `thread/start`
request has no `dynamicTools` field. Tim does not send an empty capabilities
object, `experimentalApi: false`, or an empty tool list.

Codex app-server selection also stays unchanged. Without a provider, an explicit
`CODEX_USE_APP_SERVER=false` value still selects the existing `codex exec`
fallback. With a provider, app-server mode is required. Tim rejects the request
before reading an output-schema file or allocating tunnel, process, or other
execution resources; it never falls back to `codex exec` for a dynamic-tool run.
The app-server-required error is:

> Codex dynamic tools require Codex app-server mode; enable CODEX_USE_APP_SERVER or disable experimental agent tools.

### Negotiation and role tool sets

When a provider is present, Tim sends
`initialize.params.capabilities.experimentalApi: true`. It sends the provider's
top-level function definitions in `thread/start.params.dynamicTools`. If output
schema conversion starts a replacement thread in the same execution, that thread
receives the same definitions. The app-server wire responses, not a Codex version
string, decide whether the installed server supports the protocol.

The built-in provider uses the following definitions:

| Trusted caller role | Installed tools                                             |
| ------------------- | ----------------------------------------------------------- |
| `orchestrator`      | `StartAgent`, `ListAgents`, `SendAgentMessage`, `StopAgent` |
| `subagent`          | `ListAgents`, `SendAgentMessage`, `FinishAgent`             |

Each definition is a top-level function. Its input schema is generated from the
same strict Zod schema that validates the call at runtime. The handler keeps an
independent role allowlist, so hiding a definition is not the authorization
boundary. Trusted identity and role are bound when the provider is created and
cannot be supplied in model arguments. `FinishAgent` has no target, and
`SendAgentMessage` does not accept a model-supplied source.

If the server rejects the experimental capability or the `dynamicTools` field,
Tim fails before the first turn with a compatibility error:

> Codex app-server does not support experimental dynamic tools. Update Codex CLI or disable experimental.agentMessaging.

Tim does not retry the unsupported thread without tools. Existing connection and
resource cleanup still runs.

The compatibility message covers only the two wire points that establish
support: `initialize` and the first `thread/start`. Process spawn, socket,
transport, and later replacement-thread failures keep their real errors, so a
crashed or unreachable app-server is not misreported as an out-of-date Codex
CLI. The original error is preserved as the `cause` for diagnostics.

### Dynamic call dispatch and results

The app-server sends a dynamic call as an `item/tool/call` server request. Tim
routes this method to the dynamic-tool handler before the approval handler. This
priority is required even when `ALLOW_ALL_TOOLS` is enabled. Other server
requests keep the existing approval behavior. A dynamic call without a provider
is an unsupported-method JSON-RPC error; it is never treated as an approval.

The request envelope accepts the documented optional or null top-level namespace
and tolerates future fields. Tim requires non-empty thread, turn, call, and tool
IDs, JSON arguments, and a top-level Tim tool name. The selected strict agent
schema then validates the arguments. Validation, role, authorization, and normal
manager failures return a bounded `inputText` result with `success: false`, so the
model can correct the call. Successful manager results return JSON text in an
`inputText` item with `success: true`. Unexpected failures are logged for
diagnostics and return a generic bounded message without stack traces, paths, or
trusted identity values. An unknown or future manager error code also returns
the generic message rather than the raw manager text.

Every value that leaves the handler passes a shared JSON-safety boundary before
it reaches JSON-RPC encoding or the formatter. The sanitizer keeps `__proto__`
and similar keys as ordinary data, drops functions and other unsupported
values, breaks cycles, and bounds nesting depth. It cannot throw, so a hostile
or deeply nested model result cannot turn into a transport-level failure.

The formatter treats app-server `dynamicToolCall` items as ordinary structured
tool activity. `item/started` becomes `llm_tool_use` with the tool name, a readable
argument summary, and JSON-safe input. `item/completed` becomes
`llm_tool_result` with status, success, readable text content, and JSON-safe
content items. Namespaces appear only when the server sends a non-empty
namespace. Image and audio data are retained as structured data but are not
expanded into the display summary. Unknown status and future content shapes use
stable fallback text.

Persistent Codex agent turns, idle mailbox delivery, stop/finalization lifetime,
and other provider lifetime changes are provided by the AgentManager Codex
launcher described below. When `experimental.agentMessaging` is `true`, the
collaborative orchestration prompts use `StartAgent` with the `executor` field
instead of `tim subagent` shell commands. The dynamic-tool provider is installed
for both root orchestrators and StartAgent-created persistent subagents.
Ordinary one-shot Codex execution still has no agent tools and keeps its
existing lifetime.

## Persistent Codex agent sessions

`AgentManager` uses a separate persistent launch path for Codex subagents. It
does not change `executeCodexStep()` or the existing single-turn, steering, and
chat modes. In short:

- Each persistent agent owns one private `codex app-server` process and one
  Codex thread, and ignores an inherited `TIM_CODEX_APP_SERVER_SOCKET`.
- The process tree shows `Codex app-server (<agent-name>)` and
  `Codex thread (<agent-name>)` as sibling nodes.
- The AgentManager mailbox is the only pending-message queue. Active turns take
  input through `turn/steer`; an idle thread starts another `turn/start`.
- A completed turn leaves the process and thread alive and idle. FinishAgent,
  graceful stop, and forced stop close through provider-neutral controls.

Persistent sessions require app-server experimental dynamic-tool support; the
`codex exec` fallback cannot host one. The full contract, state machine, and
cleanup order are in [persistent-codex-agent.md](persistent-codex-agent.md).

## Shared orchestration prompt

The reusable prompt builders live in a provider-neutral module:

```
src/tim/executors/shared/orchestrator_prompt.ts
```

It exports three wrappers:

- `wrapWithOrchestration()` — normal mode: implementer → tester → reviewer.
- `wrapWithOrchestrationSimple()` — simple mode: implementer → reviewer.
- `wrapWithOrchestrationTdd()` — TDD mode: flag off runs
  `tim subagent tdd-tests` before implementation, then the tester/reviewer
  path, or the reviewer path when simple TDD is enabled. Flag on starts a
  `StartAgent` `tdd-tests` agent per scope before that scope's implementer,
  then `implementer`/`tester`/advisory `reviewer` agents; independent scopes
  can run their red phases concurrently.

Neither executor calls those wrappers directly. Both build one
`OrchestrationOptions` object — the interface lives in
`src/tim/executors/shared/orchestration_options.ts` — and pass it with the
execution mode to `wrapForExecutionMode()` in
`src/tim/executors/shared/orchestration_wrapper.ts`, which selects the wrapper
and drops the options a given wrapper must not receive (simple mode gets no
`reviewExecutor`; only TDD mode gets `simpleMode`). Adding an orchestration
option therefore means one field in `orchestration_options.ts` plus its value at
each executor's single construction site, not an edit to six wrapper calls.

The prompt wording is provider-neutral (e.g. "shell command tool" rather than
"Bash tool") while preserving the literal `tim subagent ...`
command examples. The wrappers support `batchMode`, `planFilePath`,
`reviewExecutor`, `reviewerInstructionsPath`, `simpleMode`, a fixed
`subagentExecutor` (`-x codex-cli` or `-x claude-code`), dynamic
executor-selection guidance, `useJj` guidance, progress-section guidance, the
failure protocol, and batch task selection / marking guidance.

All three wrappers also teach the review-fix scope rule: a fix-round
implementer / tester / `tdd-tests` run passes `--task-index` for the tasks that
own the findings, while the first run of a batch passes no `--task-index`. See
`docs/review-iteration-policy.md`.

> **Gotcha — wording ≠ runtime config.** When "generalizing wording" in this
> prompt, only change human-readable prose (e.g. "Bash tool" → "shell command
> tool"). Do **not** touch strings the executor environment actually depends on
> at runtime — temp dir paths, command examples, file/output routing markers,
> etc. Those are configuration, not wording, and rephrasing them silently breaks
> execution even though the prompt still reads correctly.

## Codex execution modes

`CodexCliExecutor.execute()` routes on `executionMode` (defaulting to `normal`):

| Mode       | Path                                                |
| ---------- | --------------------------------------------------- |
| `normal`   | `wrapWithOrchestration()` → one Codex process       |
| `simple`   | `wrapWithOrchestrationSimple()` → one Codex process |
| `tdd`      | `wrapWithOrchestrationTdd()` → one Codex process    |
| `review`   | dedicated structured review path (unchanged)        |
| `planning` | bare single-turn pass-through path (unchanged)      |
| `bare`     | bare single-turn pass-through path (unchanged)      |

For the orchestration modes, the wrapped prompt is sent to Codex once via
`executeCodexStep(...)` with `appServerMode: 'single-turn-with-steering'`,
matching the Codex subagent path in `src/tim/subagents/service.ts`. The runner
behaves like a regular single-turn call when no interactive input source is
available.

The Codex orchestrator mirrors Claude's orchestration semantics — it does not
reimplement the old Codex implement/test/review loop, and it does not reimplement
Claude's `retryFastNoopOrchestratorTurn` continuation workaround.

### Prompt contents by mode

#### Flag off (disabled, default)

- **Normal** — `tim subagent implementer`, `tim subagent tester`, and review.
- **Simple** — `tim subagent implementer` and review.
- **TDD** — `tim subagent tdd-tests` before implementation, then tester/reviewer or
  reviewer depending on simple mode.

For non-batch execution, review uses `tim subagent reviewer`. For batch
execution, selected-task reviews are performed directly by the orchestrator; it
may start a native review subagent if useful. `tim subagent reviewer` is reserved
for the ordinary and structural full-plan review sequence after the last tasks
are finished. When `agents.reviewer.instructions` is configured, the batch
review prompt references that configured path verbatim and directs the
orchestrator to read and apply the file.

#### Flag on (collaborative mode)

- **Normal** — `StartAgent` for `implementer`, `tester`, and advisory `reviewer`
  agents. Concurrent same-type agents are allowed for safely separable scopes.
- **Simple** — `StartAgent` for `implementer` and optional advisory `reviewer`.
  Smaller team, same safety rules.
- **TDD** — `StartAgent` for `tdd-tests` before implementation per scope, then
  `implementer`, optional `tester`, and advisory `reviewer`. Independent scopes
  can run parallel red-green pipelines.

Formal review uses `tim review` (not `tim subagent reviewer`) for all modes.
The review iteration policy is unchanged. StartAgent reviewers are advisory and
read-only. `SendAgentMessage` replaces shell `--input` for follow-up context to
persistent agents.

### Option pass-through

`--executor` / `defaultSubagentExecutor` and dynamic subagent instructions are
reflected in the orchestration prompt the same way as for Claude.
`--review-executor` is reflected in prompts that invoke `tim subagent reviewer`,
which delegates to the `tim review` handler. It applies to ordinary reviewer-
subagent passes. The final full-plan review intentionally omits `--executor` so
the review can run all configured agents for full coverage. In batch mode this
applies after the orchestrator-owned selected-task reviews. Ordinary
reviewer-subagent passes are stateless, so the orchestration
prompt picks the scope of each pass: the first review of a batch and the review
that ends the loop cover the complete declared task or plan scope, while
intermediate fix-verification reviews use `--since <commit>` over the same task
scope. The loop stops when a complete review produces no new blocking
(`critical`/`major`) findings, or when the four-review bound is reached.
Non-blocking findings are rejected with a reason or filed as follow-up tasks and
never trigger another round. A completed batch uses this same loop, under its own
separate budget, for its final full-plan review. See
`docs/review-iteration-policy.md` for the full policy.

The orchestrator itself compares successive findings and decides whether they
represent the same underlying defect, a newly exposed issue, or a regression
introduced by the latest fix. Recurrence is not inferred by the review command.
When one review reports the same defect class at several locations, the
orchestrator writes a single consolidation proposal instead of patching each
instance across rounds; this is unrelated to the structural pass below.
After ordinary full-plan findings converge, the orchestrator runs one separate
`--structural-only` Codex simplification review for code-layout and structural
smells. Accepted structural findings are fixed and checked with targeted tests;
the structural pass is not automatically repeated. A successful plan-backed
structural pass records `structuralReviewAt` on the plan, so that "run it once"
rule is durable state rather than prompt text alone; see
`docs/review-iteration-policy.md` ("Structural-review marker"). Plan-backed
`tim autoreview` uses the same ordinary-loop-then-structural sequence.
A final Codex orchestrator message containing `FAILED:` returns structured
failure output, matching the orchestrator-level failure contract used by the
agent loop.

## Related

- `docs/executor-stdin-conventions.md` — how interactive stdin reaches executor
  subprocesses.
- `docs/implementer-instructions.md`, `docs/reviewer-instructions.md` — the
  role-specific instructions assembled for subagents.
- `docs/review-iteration-policy.md` — severity rubric, severity gate, review
  scope tiers, and the loop termination rule.
