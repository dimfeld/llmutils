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
process then coordinates the actual work by invoking `tim subagent ...` and
`tim subagent reviewer ...` as shell commands.

Both executors set `supportsSubagents = true`. Codex has native subagent support,
but the orchestration prompts still delegate through `tim subagent` so each role
gets tim-provided plan context, repository instructions, custom subagent
instructions, model selection, and output routing that the top-level orchestrator
could not reliably reconstruct on its own.

## Shared orchestration prompt

The reusable prompt builders live in a provider-neutral module:

```
src/tim/executors/shared/orchestrator_prompt.ts
```

It exports three wrappers, all consumed by both executors:

- `wrapWithOrchestration()` — normal mode: implementer → tester → reviewer.
- `wrapWithOrchestrationSimple()` — simple mode: implementer → verifier.
- `wrapWithOrchestrationTdd()` — TDD mode: `tim subagent tdd-tests` before
  implementation, then the tester/reviewer path, or the verifier path when simple
  TDD is enabled.

The prompt wording is provider-neutral (e.g. "shell command tool" rather than
"Bash tool") while preserving the literal `tim subagent ...`
command examples. The wrappers support `batchMode`, `planFilePath`,
`reviewExecutor`, `simpleMode`, a fixed `subagentExecutor` (`-x codex-cli` or
`-x claude-code`), dynamic executor-selection guidance, `useJj` guidance,
progress-section guidance, the failure protocol, and batch task selection /
marking guidance.

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
matching the Codex subagent path in `src/tim/commands/subagent.ts`. The runner
behaves like a regular single-turn call when no interactive input source is
available.

The Codex orchestrator mirrors Claude's orchestration semantics — it does not
reimplement the old Codex implement/test/review loop, and it does not reimplement
Claude's `retryFastNoopOrchestratorTurn` continuation workaround.

### Prompt contents by mode

- **Normal** — `tim subagent implementer`, `tim subagent tester`, and `tim subagent reviewer`.
- **Simple** — `tim subagent implementer` and `tim subagent verifier`.
- **TDD** — `tim subagent tdd-tests` before implementation, then tester/reviewer or
  verifier depending on simple mode.

### Option pass-through

`--executor` / `defaultSubagentExecutor` and dynamic subagent instructions are
reflected in the orchestration prompt the same way as for Claude.
`--review-executor` is reflected in normal/TDD prompts that invoke
`tim subagent reviewer`, which delegates to the `tim review` handler.
A final Codex orchestrator message containing `FAILED:` returns structured
failure output, matching the orchestrator-level failure contract used by the
agent loop.

## Related

- `docs/executor-stdin-conventions.md` — how interactive stdin reaches executor
  subprocesses.
- `docs/implementer-instructions.md`, `docs/reviewer-instructions.md` — the
  role-specific instructions assembled for subagents.
