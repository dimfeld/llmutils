# Subagent Launch Service

`src/tim/subagents/` holds the provider-neutral service that prepares and starts
one-shot implementer, tester, and TDD-test runs. In-process callers use it
directly. The `tim subagent` command is a thin adapter on top of it.

## Module layout

| File                           | Contents                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `src/tim/subagents/types.ts`   | Request, prepared-execution, result, and launch-handle contracts                  |
| `src/tim/subagents/service.ts` | Role table, preparation, and the Codex and Claude one-shot launch adapters        |
| `src/tim/subagents/index.ts`   | Public exports for in-process callers                                             |
| `src/tim/commands/subagent.ts` | CLI adapter: option translation, output file, final stdout, tunnel byte-count log |

Reusable code must stay outside `src/tim/commands/`. Callers depend on the
domain service, not on a Commander handler.

## Contracts

- `SubagentPreparationRequest` — plan ID, role, optional executor and model,
  optional task indexes, config path, optional repository root, and an input
  policy.
- `PreparedSubagentExecution` — everything needed to start exactly one provider
  run: resolved executor, model, plan and plan path, git root, `useJj`, final
  prompt, effective config, and the tim environment options. Treat it as
  immutable after preparation.
- `SubagentExecutionResult` — final message plus executor identity.
- `SubagentLaunchHandle` — executor identity and one `completion` promise.

The launch handle is **not** an agent session. It has no send, idle-turn, or
stop operation, and it does not keep a persistent provider session. Do not add
no-op lifecycle methods to make the type look complete; real lifecycle work
belongs to the agent-manager layer (see
[agent-messaging.md](agent-messaging.md)). The separate Claude persistent
handle, with its input adapter and lifecycle controls, is documented in
[persistent-claude-agent.md](persistent-claude-agent.md); it comes from
`runClaudeSubprocess()` in `persistent-agent` mode, not from this service.

## Input policy

`SubagentInputPolicy` is a discriminated union, so a caller can never read root
stdin by accident:

- `{ type: 'resolved', initialMessage }` — in-process callers. No file reads and
  no stdin reads.
- `{ type: 'orchestrator', input, inputFile, fallbackToStdin }` — the legacy CLI
  path. It keeps `resolveOrchestratorInput()` ordering, repeated `--input-file`
  handling, `-` stdin, and the stdin fallback.

Custom role instructions are joined before the resolved input with one blank
line between them.

## Preparation order

`prepareSubagentExecution()` performs no console output, no output-file writes,
and no provider launch. Its order is behavior, not style:

1. Load the effective config and resolve the repository root and plan.
2. Build the task context with `buildSubagentTaskContext()`. Invalid,
   out-of-range, and already-complete `--task-index` values throw here, **before**
   plan materialization, reference artifacts, or any provider work.
3. Materialize the plan, resolve the git root from the plan file, and detect jj.
4. Resolve the executor and model.
5. Materialize reference artifacts.
6. Build the context prompt with `buildExecutionPromptWithoutSteps()` in batch
   mode, using a private minimal executor object whose `execute()` throws.
7. Load custom instructions, resolve input, build the tim environment, and call
   the role prompt builder in report mode.

## Role table

`ROLE_DEFINITIONS` in `service.ts` is the single source for each role's
instruction key, config key, legacy Claude model key, and prompt builder. The
`tdd-tests` CLI role maps to the `tddTests` instruction and config keys. Add new
roles there rather than in scattered switch statements.

## Executor and model precedence

- Executor: the requested value, else `config.defaultExecutor` when it is
  `codex-cli` or `claude-code`, else `claude-code`. Any other value throws.
- Model: nonblank requested model, then
  `config.subagents.<roleConfigKey>.model.<claude|codex>`, then for Claude the
  legacy `executors['claude-code'].agents.<role>.model`, then the provider
  default.

## Launch adapters

`launchPreparedSubagent()` starts the selected adapter and returns the handle
immediately.

- **Codex** — `parseCodexModel()` splits model and reasoning level, then
  `executeCodexStep()` runs with `appServerMode: 'single-turn-with-steering'` and
  the prepared tim environment.
- **Claude** — `runClaudeSubprocess()` with the `subagent` label, a 30-minute
  inactivity timeout, `TIM_NONINTERACTIVE` handling, and the external
  repository-config access directory when external storage is in use. Timeout or
  a nonzero exit is tolerated only when an accepted final result exists. The
  final message is the last result text, else the last raw assistant message,
  else an error.

Both adapters wrap the existing runners. Do not add a second provider runner.

## CLI adapter responsibilities

`handleSubagentCommand()` keeps its signature and Commander registration. It
translates options into a request with orchestrator input and stdin fallback,
awaits the handle, writes `--output-file` (creating parent directories), prints
the final message exactly once with `console.log()`, and logs the byte count when
a tunnel is active. Output policy stays in the CLI; the service never writes to
stdout.

`tim subagent reviewer` is unrelated. It still delegates to `handleReviewCommand()`.

## Claude output formatting is execution-scoped

Concurrent in-process runs made module-global formatter state unsafe, so
`src/tim/executors/claude_code/format.ts` no longer keeps shared caches.

- `createClaudeMessageFormatter()` returns an instance that owns tool-use
  correlation, session task lists, pending task creates, and applied task
  updates. There is no production reset call.
- `createClaudeOutputStreamFormatter(model?)`
  (`claude_code/output_stream_formatter.ts`) pairs one line splitter with one
  message formatter for the lifetime of one output stream. Production Claude
  streams use it: `runClaudeSubprocess()`, `ClaudeCodeExecutor.execute()`
  (including continuation output), and the Claude branch of
  `commands/run_prompt.ts`.
- `applyTaskUpdateToList()` and `extractStructuredMessages()` stay pure.
  `extractStructuredMessagesFromLines()` uses a fresh formatter valid for that
  whole batch — never a shared singleton.

Rules when touching this code:

- Create the formatter **before** installing output callbacks and reuse it for
  every chunk. One formatter per chunk breaks tool-use/result correlation.
- Keep formatter scope identical to line-splitter scope: one per execution.
- Do not reintroduce a module-level convenience formatter for tests. Two local
  executions can legitimately see the same Claude `session_id` and tool-use ID;
  isolation must start at the local execution object. Tests prove this by
  interleaving two formatters that share those IDs.
