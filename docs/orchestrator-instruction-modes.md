# Orchestrator Instruction Modes

`orchestratorInstructionMode` controls how prescriptive the `tim agent` orchestrator is when it
hands work to subagents. It only changes the orchestration prompt wording. It is deliberately
independent of the model, executor, and effort settings elsewhere in the config, so a project can
change the delegation posture without touching which models actually run.

```yaml
orchestratorInstructionMode: delegated # or: detailed (default)
```

## The two modes

`detailed` is the default and assumes a strong orchestrator driving weaker subagents. The
orchestrator is told that subagents may use a less capable model, and that it should name the files,
required behavior, constraints, and verification steps in every assignment. This is the historical
prompt wording; leaving the setting unset produces byte-identical prompts.

`delegated` assumes capable subagents. The orchestrator is told that subagents can read the plan,
the task details, and the codebase themselves, so it should name the tasks in scope and the outcome
it expects, then let each subagent decide which files to change, how to implement the change, and
how to verify it. It still passes along what a subagent cannot discover on its own: decisions already
made, constraints from earlier phases, and accepted review findings.

Neither mode moves responsibility off the orchestrator. Task selection, sequencing, the review gates,
the Review Iteration Policy, plan updates, marking tasks done, and the integrated result stay with the
orchestrator in both modes.

## What changes in the prompt

`delegated` adds a `## Subagent Instruction Style` section to the orchestration prompt and swaps the
assignment-related sentences for less prescriptive variants. `detailed` adds no section and keeps
every sentence as it was.

Affected wording:

- The subagent capability sentence in the Important Guidelines of every wrapper.
- The `--input` / `--input-file` guidance for `tim subagent` invocations (normal and simple wrappers).
- The collaborative initial-assignment guidance, the StartTimAgent initial-message contract, the
  Agent Autonomy section, and the per-role StartTimAgent instruction.
- The collaborative implementation, simple, and TDD phase lines that previously demanded exact files,
  constraints, and verification steps. File ownership is still stated where concurrent agents could
  collide, because that is a shared-workspace safety requirement rather than a prescriptiveness one.

## Where it lives in the code

- `src/tim/executors/shared/orchestrator_instruction_mode.ts` owns the mode type and every
  mode-dependent sentence. Each builder returns the historical `detailed` string, so adding a new
  mode-aware sentence means moving the existing literal into a builder rather than rewriting prompts.
- `src/tim/configSchema.ts` declares the `orchestratorInstructionMode` enum.
- `src/tim/commands/agent/agent.ts` resolves the config value (defaulting to `detailed`) into
  `ExecutorCommonOptions`, and both the Claude Code and Codex CLI orchestrator paths forward it into
  `OrchestrationOptions`.

Adding a mode-aware sentence: move the literal into a builder in
`orchestrator_instruction_mode.ts`, return the existing text for `detailed`, and interpolate the
builder where the literal used to be.
