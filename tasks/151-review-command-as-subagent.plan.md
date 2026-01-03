---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: review command as subagent
goal: ""
id: 151
uuid: 8a417b70-b63c-4a55-9d34-ee64aa04fead
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-01-03T00:46:46.056Z
promptsGeneratedAt: 2026-01-03T00:46:46.056Z
createdAt: 2025-12-29T01:27:15.778Z
updatedAt: 2026-01-03T03:16:45.419Z
tasks:
  - title: Add review default executor config + docs
    done: true
    description: Extend `review.defaultExecutor` in `src/rmplan/configSchema.ts` to
      accept `claude-code`, `codex-cli`, or `both` (no zod defaults). Update
      `src/rmplan/configSchema.test.ts` coverage for the new field and adjust
      README/config documentation to describe the new option and behavior.
  - title: Extend rmplan review CLI options
    done: true
    description: Add `--print/-p`, `--task-index`, and `--task-title` options to
      `rmplan review` in `src/rmplan/rmplan.ts`, supporting repeated flags and
      comma-separated values. Implement validation/error messaging for missing
      task filters and executor allowlist (`claude-code`, `codex-cli`, `both`).
      Ensure `--print` forces JSON output and suppresses interactive prompts.
  - title: Refactor review flow into reusable runner helper
    done: true
    description: Create a new helper module (e.g., `src/rmplan/review_runner.ts`)
      that executes reviews and returns a merged `ReviewResult`. The helper
      should accept task filters and optional extra context, handle executor
      selection (including `both` in parallel), parse JSON outputs, merge/sort
      issues by file/line (missing last), and surface partial failures with
      stderr warnings while still returning results. Integrate
      `handleReviewCommand` to use this helper and bypass autofix/cleanup/append
      flows when `--print` is set.
  - title: Implement task filtering + prompt scope notes
    done: true
    description: Implement exact, case-insensitive task title matching and 0-based
      index filtering against the full plan task list. Use union semantics when
      both filters provided; include all matches if titles duplicate; preserve
      original task order. If any filter value is unmatched, throw a clear error
      listing unknown indexes and titles. Add a prompt note indicating scoped
      tasks.
  - title: Update reviewer prompt requirements
    done: true
    description: Modify `getReviewerPrompt` in
      `src/rmplan/executors/claude_code/agent_prompts.ts` to include the word
      “ultrathink” and to mark “implemented but does not meet requirements” as
      CRITICAL. Update prompt-related tests accordingly.
  - title: Update Claude orchestrator review instructions
    done: true
    description: Replace reviewer-subagent guidance in
      `src/rmplan/executors/claude_code/orchestrator_prompt.ts` with
      instructions to run `rmplan review --print` (including executor selection
      guidance). The prompt must indicate that the command may take up to 15
      minutes so a long timeout is appropriate. Remove reviewer-agent references
      from available agents and guidelines as needed.
  - title: Replace Codex internal review with external review helper
    done: true
    description: "In `src/rmplan/executors/codex_cli/normal_mode.ts` (and simple
      mode if applicable), replace the internal reviewer step with an in-process
      call to the new review helper. Pass `newlyCompletedTitles` and extra
      context (implementer/tester outputs plus
      initiallyCompleted/initiallyPending titles). Always run the review even
      when no tasks are newly completed (no task filter). Derive verdicts from
      JSON: critical/major/minor => NEEDS_FIXES, info-only => ACCEPTABLE. Adjust
      fix-loop logic to use the external review result."
  - title: Add/update automated tests for review changes
    done: true
    description: "Add/adjust tests covering: `--print` behavior, task filtering and
      error messaging, executor `both` merge ordering, config
      `review.defaultExecutor`, `--review-executor` override in `rmplan agent`,
      orchestrator prompt updates, and Codex external review replacement. Ensure
      tests validate JSON parsing and verdict mapping logic."
changedFiles:
  - README.md
  - schema/rmplan-config-schema.json
  - src/rmplan/commands/review.test.ts
  - src/rmplan/commands/review.ts
  - src/rmplan/configSchema.test.ts
  - src/rmplan/configSchema.ts
  - src/rmplan/executors/claude_code/agent_prompts.test.ts
  - src/rmplan/executors/claude_code/agent_prompts.ts
  - src/rmplan/executors/claude_code/orchestrator_prompt.test.ts
  - src/rmplan/executors/claude_code/orchestrator_prompt.ts
  - src/rmplan/review_runner.test.ts
  - src/rmplan/review_runner.ts
  - src/rmplan/rmplan.ts
  - src/rmplan/utils/cleanup_plan_creator.ts
tags: []
---

- Update review prompt so that functionality that is implemented but does not meet requirements is a critical issue. 
- Use the word "ultrathink" in review mode prompt
- Add a --print or -p argument to "rmplan review" for running noninteractively that will return all the data without the prompts 
- Update review command with options for reviewing just certain tasks in the plan, and also options for running parallel reviews with both codex and Claude executors, in parallel, and combining results. 
- Add configuration option for which executor to use for review by default: claude-code, codex-cli, both.
- In Claude code orchestrator, replace review subagent with directions to run rmplan review for Claude orchestrator

## Research

### Opportunity Summary
The current `rmplan review` command produces a single-executor review using the shared reviewer prompt and JSON schema output, but it lacks: (1) a dedicated non-interactive print flag, (2) task-scoped review targeting, (3) a built-in parallel review path that merges Claude + Codex outputs, (4) a review-specific default executor in config, and (5) orchestrator guidance to drive `rmplan review` instead of a reviewer subagent. The reviewer prompt also needs specific language updates (critical severity for “implemented but wrong” behavior, and the literal word “ultrathink”).

### Parallel Subagent Reports (Focused Codebase Scans)

#### Subagent A: CLI + Command Wiring
- `src/rmplan/rmplan.ts` defines the `review` CLI with many options, but no `--print/-p`, no task targeting flags, and no executor mode for “both”. The CLI only passes `options` into `handleReviewCommand` (no preprocessing).
- `src/rmplan/commands/review.ts` is the main orchestration for `rmplan review`. It:
  - Loads config via `loadEffectiveConfig` and defaults executor to `options.executor || config.defaultExecutor || DEFAULT_EXECUTOR`.
  - Uses `gatherPlanContext` to load plan + hierarchy + diff info.
  - Builds prompt with `buildReviewPrompt` and executes a single executor in review mode.
  - Parses JSON into `ReviewResult` via `createReviewResult` (JSON is required) and formats output.
  - Uses `RMPLAN_INTERACTIVE` to decide whether to prompt for autofix/cleanup or issue selection.
- `RMPLAN_INTERACTIVE` environment gate is the only non-interactive control today; adding `--print` should map into this path (e.g., bypass prompts regardless of env).
- `rmplan agent` (`src/rmplan/commands/agent/agent.ts`) currently uses a single executor for implementation/testing/review via `options.executor || config.defaultExecutor`. There is no review-specific executor override today.
- Codex executor already derives `newlyCompletedTitles` during an iteration in both `src/rmplan/executors/codex_cli/normal_mode.ts` and `src/rmplan/executors/codex_cli/simple_mode.ts` via `parseCompletedTasksFromImplementer`. This is the right signal for scoping external reviews to the current iteration.

#### Subagent B: Prompts + Orchestrator
- `src/rmplan/executors/claude_code/agent_prompts.ts` defines the reviewer prompt used by both the review command and Codex normal-mode reviewer. This is the right place to add:
  - “ultrathink” in the review prompt.
  - Explicit instruction that “implemented but doesn’t meet requirements” is a CRITICAL issue.
- `src/rmplan/executors/claude_code/orchestrator_prompt.ts` instructs orchestrators to use the reviewer subagent in a “Review Phase”, and lists `rmplan-reviewer` as an available agent. Requirement says this must be replaced with directions to run `rmplan review` for the Claude orchestrator. That implies:
  - Update the “Available Agents” section (remove reviewer agent and/or replace with `rmplan review` guidance).
  - Update the “Review Phase” steps to call `rmplan review` (likely with `--print`, and optional task filtering).
  - Update “Important Guidelines” (remove “DO NOT review code directly, use reviewer agent”) to match the new workflow.
 - Reviews also run inside the Codex executor (`src/rmplan/executors/codex_cli/normal_mode.ts`) via an internal reviewer step that uses `getReviewerPrompt`. Prompt changes must account for this path as well.

#### Subagent C: Review Output + Executors
- Review mode requires strict JSON output conforming to `src/rmplan/formatters/review_output_schema.ts`. `createReviewResult` in `src/rmplan/formatters/review_formatter.ts` always parses JSON and throws if invalid.
- Codex review-only mode (`src/rmplan/executors/codex_cli/review_mode.ts`) already supplies the JSON schema and returns output suitable for parsing.
- `createReviewResult` uses the parsed issues to generate a summary and format output; no merging logic exists yet.
- To support “both” executors in parallel, new code must either:
  - Parse each executor’s JSON separately and combine issues, recommendations, and action items into a single `ReviewResult`, or
  - Extend formatters and types to support multi-source results.
  The former is less invasive but loses source attribution unless added explicitly.

### Relevant Files and Patterns
- Command entry point: `src/rmplan/rmplan.ts` (review CLI options).
- Review orchestration: `src/rmplan/commands/review.ts`.
- Context gathering: `src/rmplan/utils/context_gathering.ts` (no task filtering today).
- Reviewer prompt template: `src/rmplan/executors/claude_code/agent_prompts.ts`.
- Orchestrator instructions: `src/rmplan/executors/claude_code/orchestrator_prompt.ts`.
- Review formatting/schema: `src/rmplan/formatters/review_formatter.ts`, `src/rmplan/formatters/review_output_schema.ts`.
- Config schema: `src/rmplan/configSchema.ts` and tests in `src/rmplan/configSchema.test.ts`.
- Review command tests: `src/rmplan/commands/review.test.ts`.
- Task selection helpers: `src/rmplan/utils/task_operations.ts` (find by title, interactive select).

### Architectural Constraints and Hazards
- JSON review output is mandatory. Any new “combined review” path must parse valid JSON from each executor, or fail early with clear errors.
- Config schema rule: do not add defaults to zod schemas. Defaults must be applied after merging (e.g., in code or `getDefaultConfig`).
- Parallel review runs may contend for resources (network, LLM credits). Behavior when one executor fails must be defined (fail the review vs. partial output).
- Task filtering affects prompt content only; avoid mutating persisted plan tasks unless explicitly intended.
- `RMPLAN_INTERACTIVE` controls prompts globally; `--print` should override prompts in review command without affecting other commands.

### Dependencies and Prerequisites
- Existing executor infrastructure (`buildExecutorAndLog`, `Executor.execute`) should be reused.
- Review formatter APIs (`createReviewResult`, `generateReviewSummary`) should be reused to avoid output drift.
- If new CLI flags are added, update README and config documentation per project instructions.

## Implementation Guide

### Expected Behavior/Outcome
- `rmplan review` supports a `--print/-p` mode that is fully non-interactive and prints the complete review output without any selection prompts.
- Review scope can be limited to specific tasks (by index and/or title), and the review prompt clearly states the selected task subset.
- Review executor can be selected via CLI or config, including a “both” mode that runs Claude + Codex reviews in parallel and merges results.
- The reviewer prompt explicitly instructs that “implemented but doesn’t meet requirements” is CRITICAL, and includes the word “ultrathink”.
- The Claude orchestrator no longer invokes a reviewer subagent; it runs `rmplan review` instead.
- When running reviews during `rmplan agent`, `review.defaultExecutor` is used for the review phase even if `--executor` specified a different executor for implementation. `--review-executor` overrides this.
- Codex executor’s internal review step is fully replaced by `rmplan review` output (including verdict and fix-loop decisions), not additive/advisory.
- When `rmplan agent` runs review during an iteration, it should scope the review to only the tasks completed in that iteration.
- Use `newlyCompletedTitles` from the Codex executor paths to drive task scoping for external review.
- When running external reviews from Codex, pass additional context (implementer/tester outputs plus initiallyCompleted/initiallyPending task lists) into the review helper so the prompt can incorporate execution details beyond plan text.
- If no newly completed tasks are detected, still run the external review using the extra context (no task filter).

Relevant States
- Executor selection state: `claude-code` | `codex-cli` | `both` (resolved from CLI or config).
- Agent command review executor state: `review.defaultExecutor` or `--review-executor` (independent from implementation executor).
- Interaction state: interactive vs. print/non-interactive (prompts suppressed when `--print` is set).
- Task scope state: full plan tasks vs. filtered tasks.

### Key Findings
- Product & User Story: Enable review to run as a subagent-friendly command with deterministic outputs, scoped tasks, and dual-executor consensus when needed.
- Design & UX Approach: Keep CLI ergonomics consistent with existing flags; minimize prompting in automated flows; ensure outputs are JSON-friendly for tooling.
- Technical Plan & Risks: Introduce a review executor resolver and a merge pipeline that combines two JSON review outputs. Wire review executor selection into `rmplan agent` so review runs can use a different executor than implementation. Biggest risks are JSON parse failures and undefined behavior when one executor fails.
- Pragmatic Effort Estimate: Medium. Touches CLI, review command, prompt templates, config schema/tests, and possibly formatter/test updates.

### Dependencies & Constraints
- Dependencies: `buildReviewPrompt`, `getReviewerPrompt`, `createReviewResult`, `parseJsonReviewOutput`, `generateReviewSummary`, `gatherPlanContext`, commander CLI in `rmplan.ts`.
- Technical Constraints: Do not add zod defaults in `configSchema.ts`; must preserve strict JSON review output; avoid breaking existing single-executor flow.

### Implementation Notes

#### Recommended Approach
1. **Add review executor config**
   - Extend `review` config schema with `defaultExecutor` that accepts `claude-code`, `codex-cli`, `both`.
   - Map `both` to parallel runs of Claude + Codex in review command logic.
   - Treat other executors as unsupported for review unless they emit valid review JSON; without explicit capability metadata, default to an allowlist (`claude-code`, `codex-cli`) and fail fast with a clear error for others.
   - For `rmplan agent`, use `review.defaultExecutor` for the review phase regardless of `--executor` (implementation executor).
   - Add `--review-executor` to override `review.defaultExecutor` for `rmplan agent` review runs.
   - Update `configSchema.test.ts` and README/config docs.

2. **Add CLI flags for non-interactive print and task scoping**
   - Add `-p, --print` to `rmplan review` to suppress prompts and always emit full output in JSON format (override any other format settings).
   - Add task targeting flags `--task-index <n...>` and `--task-title <title...>` with exact-title matching (no substring). Keep indices 0-based to align with existing task APIs. Support multiple indices or titles via repeated flags or comma-separated lists; split any comma-delimited values during parsing.
   - Wire these options into `handleReviewCommand` to filter plan tasks only for prompt creation.
   - Add `--review-executor <name>` to `rmplan agent`/`rmplan run` to override the review executor used during the review phase.

3. **Implement task filtering for review prompt**
   - Build a filtered `PlanSchema` copy for prompt context (do not mutate the persisted plan).
   - Add a note to the prompt when tasks are filtered (e.g., “Review only the tasks listed below”).
   - Title matching should be exact and case-insensitive.
   - If multiple tasks share the same title, include all matches (do not error).
   - Preserve original task order (by index) when listing filtered tasks in the prompt.
   - When both `--task-index` and `--task-title` are provided, include the union of matched tasks.
   - If any filter values do not match a task, throw an error listing all non-matching indexes and titles (no fallback to full-plan review).
   - Validate task indices against the full plan task list, not the filtered subset.
   - Error message format should clearly separate missing indexes vs missing titles (e.g., “Unknown task indexes: 3,5; Unknown task titles: Foo,Bar”). Out-of-range indexes should be reported in the same “Unknown task indexes” bucket.

4. **Support multi-executor parallel reviews**
   - Resolve executor selection in `handleReviewCommand` with precedence:
     1) CLI `--executor` (accepts `claude-code`, `codex-cli`, `both`)
     2) Config `review.defaultExecutor`
     3) Config `defaultExecutor`
     4) `DEFAULT_EXECUTOR`
   - Validate review executor values against the allowlist (claude-code, codex-cli, both) and throw a clear error if a non-review-capable executor is provided.
   - For `both`, create two executors (Claude + Codex) and run `execute` concurrently (`Promise.all`).
   - Parse each output with `parseJsonReviewOutput` and merge:
     - Concatenate issues, recommendations, action items.
     - Do not dedupe issues; sort merged issues by file and then line so related findings are adjacent. Issues missing file/line should sort last.
     - Recompute summary via `generateReviewSummary`.
     - Ensure issue IDs are unique (e.g., prefix with executor name or re-index after merge).
     - Consider adding source attribution (prefix in `content` or new metadata) if needed for clarity.
   - Use a single formatter pass for output.

5. **Update reviewer prompt instructions**
   - Add “ultrathink” instruction in the reviewer prompt template.
   - Explicitly mark “implemented but does not meet requirements” as CRITICAL in the critical issues section.
   - Update `agent_prompts.test.ts` if needed to assert new prompt text.

6. **Update Claude orchestrator workflow**
   - Replace the reviewer subagent directions in `orchestrator_prompt.ts` with steps to run `rmplan review` (likely `--print` and the chosen executor).
   - Note that a long timeout is appropriate for the command to take up to 15 minutes.
   - Adjust “Available Agents” and “Important Guidelines” to remove reviewer-agent requirements.

7. **Testing**
   - Add/update unit tests in `src/rmplan/commands/review.test.ts` for:
     - `--print` suppressing prompts and still printing full output.
     - Task filtering (prompt includes only selected tasks; note that other tasks are excluded).
     - `--executor both` path invoking two executors and merging results.
   - Update config schema tests for the new review executor config field.
   - Update prompt tests to ensure “ultrathink” and critical guidance are present.
   - Add/update agent command tests to verify `review.defaultExecutor`/`--review-executor` override the review phase selection.

#### Potential Gotchas
- “Both” mode should emit partial results if one executor fails or returns invalid JSON. The failure should be surfaced as a warning on stderr while still returning the merged output from the successful executor, and the command should exit 0.
- JSON schema strictness means any combined output must remain valid; avoid adding new fields to JSON output unless formatters are updated accordingly.
- Task filtering should not change the persisted plan data; treat it as a prompt-only scope.
- Codex executor’s reviewer step feeds into its fix loop and verdict parsing; if review execution is redirected to `rmplan review` for agent workflows, verdict handling must be updated to interpret JSON-only outputs.
- The external review must fully satisfy Codex’s review-phase needs (verdict + fix loop), so the code must derive ACCEPTABLE/NEEDS_FIXES from the JSON review output produced by `rmplan review`.
- Verdict mapping for external review JSON: any issue at severity critical/major/minor yields NEEDS_FIXES; info-only issues can still be ACCEPTABLE.

#### Conflicting, Unclear, or Impossible Requirements
- None.

### Step-by-Step Implementation Guide
1. Extend `configSchema.ts` review section with a new executor selection field and wire it into config loading logic (no zod defaults). Update `configSchema.test.ts` and README documentation.
2. Add CLI flags for `rmplan review`: `--print/-p` and task selection flags. Add `--review-executor` to `rmplan agent`/`rmplan run`. Update help text and option parsing.
3. In `handleReviewCommand`, add an `isInteractiveEnv` override when `--print` is set, and ensure prompts are skipped. Ensure full output is printed even when `--print` is used.
   - When `--print` is set, force `outputFormat` to `json` regardless of CLI/config values.
   - When `--print` is set, bypass autofix/cleanup/append flows entirely, even if flags are provided.
4. Implement task filtering for prompt generation by cloning `planData` with a filtered `tasks` array and adding a prompt note about scope.
5. Add executor resolution logic to support `claude-code`, `codex-cli`, and `both`. Implement parallel execution and merge outputs using `parseJsonReviewOutput` + `generateReviewSummary`.
6. Update `getReviewerPrompt` in `agent_prompts.ts` to include “ultrathink” and the critical guidance for wrong-but-implemented behavior.
7. Update `orchestrator_prompt.ts` to replace reviewer subagent guidance with `rmplan review` instructions.
8. Update `rmplan agent` to honor `review.defaultExecutor` (or CLI `--review-executor`) for review-phase execution, and ensure the chosen review executor is visible to the Claude orchestrator instructions.
9. Replace Codex executor’s internal reviewer step with an in-process call to a refactored review utility (no subprocess). Implement the refactor as a new helper module that returns a merged `ReviewResult` for verdict + fix-loop decisions.
   - The helper should accept optional extra context (implementer output, tester output, initiallyCompleted/initiallyPending task titles) for internal/executor calls.
10. Add/adjust tests covering new CLI options, prompt updates, multi-executor merge logic, Codex review replacement, and agent review executor overrides. Run `bun test`.

### Manual Testing (Non-Task)
- Run `rmplan review <plan> --print --format json --verbosity detailed` and confirm no prompts appear and output is complete JSON.
- Run `rmplan review <plan> --task-index 0 --print` (or title-based) and ensure prompt and output only reference the selected tasks.
- Run `rmplan review <plan> --executor both --print` and confirm merged output includes issues from both executors.
- Run `rmplan agent <plan> --executor codex-cli --review-executor claude-code` (or config `review.defaultExecutor`) and confirm review uses the override.

### Rationale
- Task filtering reduces scope and cost for large plans while keeping output deterministic.
- “Both” executor mode provides cross-validation and increases confidence for high-stakes reviews.
- The `--print` flag enables orchestration automation without relying on environment variables.

### Acceptance Criteria
- [ ] Functional: User can run `rmplan review` with `--print` and receive non-interactive output.
- [ ] Functional: User can limit review scope to specific tasks by index or title.
- [ ] Functional: `--executor both` runs Claude + Codex reviews in parallel and emits a merged report.
- [ ] Functional: `rmplan agent` uses `review.defaultExecutor` for the review phase and `--review-executor` can override it.
- [ ] Functional: Codex executor’s internal review step is fully replaced by `rmplan review --print`, and its verdict/fix loop is driven by the external review JSON.
- [ ] UX: CLI help text documents new flags and config option, and no prompts appear in `--print` mode.
- [ ] Technical: Config schema accepts the new review executor field and CLI resolution honors precedence.
- [ ] All new code paths are covered by tests.

## Current Progress
### Current State
- Verification confirms print mode stdout stays JSON-only in incremental review fallbacks with logs routed through the logger adapter.
- Verification confirms Claude Code orchestration injects review-executor overrides into the review command guidance.
- Task completion marking remains gated on ACCEPTABLE review verdicts.
### Completed (So Far)
- Integrated external review helper into Codex normal/simple review flow with verdict mapping.
- Added review runner support for parallel reviews, task scoping, and print-mode output with tests.
- Updated reviewer prompt and Claude orchestrator guidance to use `rmplan review --print`.
- Added `both` to `review.defaultExecutor` schema/JSON and README example.
- Extended review runner tests to assert config-resolved `both` selection.
- Added coverage to ensure tasks are not marked done when reviews still need fixes.
- Added stdout-capture coverage for print-mode JSON output and review-executor pass-through tests.
- Routed incremental review fallback messaging through the logger adapter and added coverage for no-history cases.
- Added orchestration prompt coverage for review executor overrides.
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Print-mode validation now asserts stdout JSON cleanliness instead of relying on output files.
- Review executor overrides are asserted in both agent and Codex normal-mode tests.
- Incremental review fallback logging now avoids stdout to keep print mode output clean.
- Verification run confirmed previous review issues are resolved.
### Risks / Blockers
- None
