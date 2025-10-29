---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: simple run mode
goal: Implement a --simple flag for the rmplan agent command that runs executors
  in a streamlined 2-phase "implement and verify" mode instead of the current
  3-phase "implement-test-review" orchestration loop.
id: 126
uuid: 227a05fa-5ada-4a86-ace2-941d7ee68265
generatedBy: agent
status: done
priority: medium
container: false
dependencies: []
issue: []
pullRequest: []
docs: []
planGeneratedAt: 2025-10-16T08:11:33.994Z
createdAt: 2025-10-16T08:04:19.031Z
updatedAt: 2025-10-27T08:39:04.228Z
progressNotes:
  - timestamp: 2025-10-16T08:16:22.416Z
    text: Added CLI --simple flag plumbing. Updated executor shared options/types
      and option schemas for simple mode. buildExecutorAndLog now accepts CLI
      overrides and agent command passes simple flag when requested.
    source: "implementer: tasks 1-4"
  - timestamp: 2025-10-16T08:20:58.372Z
    text: Reviewed current agent/executor specs; no coverage yet for --simple
      plumbing. Need new unit tests for CLI flag pass-through and schema
      acceptance.
    source: "tester: Task1"
  - timestamp: 2025-10-16T08:25:07.216Z
    text: "Added new unit coverage: agent simple-mode flow now asserts executor
      args, schemas accept simpleMode, and createExecutor respects CLI
      override."
    source: "tester: Task1"
  - timestamp: 2025-10-16T08:25:28.544Z
    text: Typecheck and focused suites (agent/executor schema/build) all green after
      new coverage.
    source: "tester: Task1"
  - timestamp: 2025-10-16T08:44:32.609Z
    text: "Prompted Claude simple-mode flow now shares implement \\u2192 verify
      guidance, added verifier agent prompt, wired executionMode 'simple' into
      claude_code executor with two-agent generation, and extended failure
      detection so FAILED: verifier reports bubble up."
    source: "implementer: Tasks5-9"
  - timestamp: 2025-10-16T08:49:22.187Z
    text: Added coverage for new simple-mode prompts and executor plumbing. Added
      verifier prompt assertions, two-phase orchestration expectations, and a
      simple-mode executor model test to confirm we only generate
      implementer/verifier agents.
    source: "tester: Task15"
  - timestamp: 2025-10-16T09:10:00.304Z
    text: Codex executor now branches into a simple implement→verify workflow. Added
      executeSimpleMode with the existing implementer retry logic, reused the
      verifier prompt, and feed the verifier combined tester/reviewer guidance.
      Planning-only detection continues to work and auto task completion still
      runs after successful verification.
    source: "implementer: Tasks10-14"
  - timestamp: 2025-10-16T09:20:24.742Z
    text: "Added bun-based coverage for Codex simple mode: validated
      implementer→verifier aggregation, planning-only retry logging, and
      verifier failure handling. All Codex executor suites pass with the new
      tests."
    source: "tester: Tasks10-14"
  - timestamp: 2025-10-16T09:39:53.106Z
    text: Updated Claude agent generator to prune stale plan files before writing
      new definitions, supporting the implementer/verifier file set for simple
      mode.
    source: "implementer: Task8"
  - timestamp: 2025-10-16T09:39:57.384Z
    text: Wrote Claude simple mode integration tests that exercise two-phase
      execution, assert agent file generation, and verify verifier failure
      attribution.
    source: "tester: Task16"
  - timestamp: 2025-10-16T09:42:50.223Z
    text: Ran bun run check and targeted Claude agent/executor suites; all pass with
      new simple-mode coverage confirmed.
    source: "tester: Tasks8-16"
  - timestamp: 2025-10-16T09:43:00.900Z
    text: Spot-checked codex_cli simple-mode suite; bun test
      src/rmplan/executors/codex_cli.simple_mode.test.ts passes, no regressions
      observed.
    source: "tester: Task17"
  - timestamp: 2025-10-16T10:06:12.632Z
    text: Added agent CLI unit tests covering --simple with --dry-run and
      --serial-tasks, ensuring executionMode 'simple' propagates to batch and
      serial paths.
    source: "implementer: Task18"
  - timestamp: 2025-10-16T10:07:38.189Z
    text: Documented the --simple mode in README with usage guidance and added
      CLAUDE.md architecture notes covering implementer/verifier prompts,
      executor wiring, and verifier failure handling.
    source: "implementer: Tasks19-20"
  - timestamp: 2025-10-16T10:07:59.259Z
    text: bun run check and bun test src/rmplan/commands/agent/agent.test.ts
      succeeded with the new simple-mode interaction coverage.
    source: "tester: Task18"
  - timestamp: 2025-10-16T10:10:06.257Z
    text: Ran bun run check plus agent tests to confirm --simple interactions with
      dry-run/serial paths remain passing.
    source: "tester: Tasks18-20"
  - timestamp: 2025-10-16T10:14:50.543Z
    text: Expanded simple-mode prompt tests to cover custom instructions and
      progress-note guidance.
    source: "implementer: Task15"
  - timestamp: 2025-10-16T10:15:46.769Z
    text: Ran bun test for agent_prompts and orchestrator_prompt suites; new
      assertions guarding custom instructions and progress-note guidance pass.
    source: "tester: Task15"
  - timestamp: 2025-10-16T10:17:18.853Z
    text: Executed bun test src/rmplan/executors/codex_cli.simple_mode.test.ts; all
      simple-mode Codex executor scenarios pass.
    source: "tester: Task17"
  - timestamp: 2025-10-16T10:20:35.734Z
    text: Reviewed existing Codex CLI simple mode tests; coverage already exercises
      executionMode flag but not sharedOptions/options toggles. Plan to add
      integration-style tests verifying execute() respects those entry points
      while still handling planning-only retry logging.
    source: "implementer: Task17"
  - timestamp: 2025-10-16T10:22:16.129Z
    text: Added integration-style Codex CLI simple mode tests covering
      shared/options simpleMode toggles plus planning-only retry logging. Bun
      test for codex_cli.simple_mode.test.ts passes.
    source: "tester: Task17"
  - timestamp: 2025-10-16T10:24:39.067Z
    text: Verified codex_cli.simple_mode.test.ts against current implementation; bun
      test src/rmplan/executors/codex_cli.simple_mode.test.ts passes without
      modifications.
    source: "tester: Task17"
tasks:
  - title: Add --simple flag to rmplan agent CLI command
    done: true
    description: Update `/src/rmplan/rmplan.ts` to add the --simple option after
      line 349 in the `createAgentCommand()` function. Follow the pattern of
      existing flags like --serial-tasks.
  - title: Update executor type definitions for simple mode
    done: true
    description: Modify `/src/rmplan/executors/types.ts` to support simple mode in
      ExecutorCommonOptions or ExecutePlanInfo. Consider adding an executionMode
      variant or a separate simpleMode boolean field.
  - title: Update executor schemas to include simpleMode option
    done: true
    description: Add simpleMode field to both claudeCodeOptionsSchema and
      codexCliOptionsSchema in `/src/rmplan/executors/schemas.ts`. Include
      proper zod validation and descriptions.
  - title: Modify executor build process to pass simple mode flag
    done: true
    description: Update `/src/rmplan/executors/build.ts` buildExecutorAndLog
      function to accept and pass executor-specific options. Modify the call
      site in `/src/rmplan/commands/agent/agent.ts` to pass the simple flag when
      present.
  - title: Create simple mode orchestrator prompt
    done: true
    description: Add new `wrapWithOrchestrationSimple()` function in
      `/src/rmplan/executors/claude_code/orchestrator_prompt.ts` that provides
      2-phase orchestration instructions (implement → verify) instead of the
      current 3-phase flow.
  - title: Create verifier agent prompt
    done: true
    description: Add `getVerifierAgentPrompt()` function in
      `/src/rmplan/executors/claude_code/agent_prompts.ts` that combines testing
      and validation responsibilities. The verifier should run type checking,
      linting, tests, and add tests if needed.
  - title: Update Claude Code executor to branch on simple mode
    done: true
    description: Modify `/src/rmplan/executors/claude_code.ts` execute() method
      around line 789 to check for simple mode and use
      wrapWithOrchestrationSimple() instead of wrapWithOrchestration() when
      appropriate.
  - title: Modify agent file generation for simple mode
    done: true
    description: Update `/src/rmplan/executors/claude_code/agent_generator.ts` to
      conditionally generate implementer and verifier agents in simple mode
      instead of implementer, tester, and reviewer agents.
  - title: Add failure detection for verifier agent
    done: true
    description: "Extend failure detection in
      `/src/rmplan/executors/failure_detection.ts` to recognize failures from
      the new verifier agent using the existing FAILED: protocol."
  - title: Create simple mode execution loop
    done: true
    description: Add new method in `/src/rmplan/executors/codex_cli.ts` for simple
      mode execution that implements the 2-phase loop (implement → verify)
      without the review and fix iteration phases.
  - title: Create verifier prompts for Codex
    done: true
    description: Add verifier prompt generation functions in Codex executor that
      instruct the agent to run verification commands and ensure all checks
      pass.
  - title: Update main execute method to use simple loop
    done: true
    description: Modify the execute() method in Codex CLI executor to check for
      simple mode and call the new simple execution loop instead of the full
      orchestration loop.
  - title: Adapt planning-only detection for simple mode
    done: true
    description: Ensure the planning-only detection and retry mechanism works
      correctly in simple mode, with appropriate retry messages for the
      simplified workflow.
  - title: Handle task completion in simple mode
    done: true
    description: Adapt the auto task completion logic to work with the simplified
      output from the 2-phase execution.
  - title: Write unit tests for simple mode prompts
    done: true
    description: Create tests for wrapWithOrchestrationSimple() and
      getVerifierAgentPrompt() functions to ensure correct prompt generation.
  - title: Write integration tests for Claude Code simple mode
    done: true
    description: Add tests in the Claude Code executor test file that verify the
      complete 2-phase flow works correctly, including agent file generation and
      failure handling.
  - title: Write integration tests for Codex CLI simple mode
    done: true
    description: Add tests for the Codex CLI executor's simple mode loop, including
      planning-only detection and retry behavior in the simplified context.
  - title: Test interaction with other flags
    done: true
    description: Verify that --simple flag works correctly with other options like
      --batch, --serial-tasks, and --dry-run, ensuring no conflicts or
      unexpected behavior.
  - title: Update README and documentation
    done: true
    description: Update the main README.md to document the new --simple flag,
      explaining when to use it and how it differs from the standard execution
      mode. Include examples of usage.
  - title: Add CLAUDE.md notes about simple mode
    done: true
    description: Update the CLAUDE.md file with implementation details about the
      simple mode architecture for future development reference.
changedFiles:
  - CLAUDE.md
  - README.md
  - src/rmplan/commands/agent/agent.test.ts
  - src/rmplan/commands/agent/agent.ts
  - src/rmplan/commands/agent/batch_mode.capture_output.test.ts
  - src/rmplan/commands/agent/batch_mode.soft_failure.test.ts
  - src/rmplan/commands/agent/batch_mode.ts
  - src/rmplan/commands/agent/stub_plan.ts
  - src/rmplan/executors/build.test.ts
  - src/rmplan/executors/build.ts
  - src/rmplan/executors/claude_code/agent_generator.test.ts
  - src/rmplan/executors/claude_code/agent_generator.ts
  - src/rmplan/executors/claude_code/agent_prompts.test.ts
  - src/rmplan/executors/claude_code/agent_prompts.ts
  - src/rmplan/executors/claude_code/orchestrator_prompt.test.ts
  - src/rmplan/executors/claude_code/orchestrator_prompt.ts
  - src/rmplan/executors/claude_code.test.ts
  - src/rmplan/executors/claude_code.ts
  - src/rmplan/executors/claude_code_model_test.ts
  - src/rmplan/executors/codex_cli.simple_mode.test.ts
  - src/rmplan/executors/codex_cli.test.ts
  - src/rmplan/executors/codex_cli.ts
  - src/rmplan/executors/failure_detection.test.ts
  - src/rmplan/executors/failure_detection.ts
  - src/rmplan/executors/schemas.test.ts
  - src/rmplan/executors/schemas.ts
  - src/rmplan/executors/types.ts
  - src/rmplan/rmplan.ts
rmfilter: []
---

# Original Plan Details

Add a `--simple` flag to @src/rmplan/commands/agent/agent.ts that runs the executor with a "simple" flag. When in simple
mode, we want to not run the implemnent-test-review loop like we do now, and instead do a 2-stage "implement and
verify" setup in which it implements the change and then does a verify step that includes things like adding tests if
needed, and making sure typechecking, lints and tests all pass.

Do this for the Claude Code executor with a new orchestrator prompt and new verify agent.
Do this for the Codex executor as well with a new loop function.

# Processed Plan Details

## Add --simple flag for streamlined 2-phase execution mode to rmplan agent command

This feature adds a simplified execution mode to the rmplan agent system that reduces complexity while maintaining quality assurance. Instead of the current sophisticated 3-phase orchestration (implement → test → review with potential fix iterations), the simple mode will use a 2-phase approach (implement → verify) where the verify phase combines testing, linting, type checking, and validation into a single step.

### Expected Behavior/Outcome
- Users can add `--simple` flag to `rmplan agent` command to enable streamlined execution
- Claude Code executor uses 2 agents (implementer, verifier) instead of 3 (implementer, tester, reviewer)
- Codex CLI executor uses simplified loop without separate review phase
- Verify phase ensures code quality through automated checks (tests, linting, type checking)
- Faster execution for straightforward tasks while maintaining code quality standards

### Key Findings

**Product & User Story**
- Users want a faster execution mode for simple tasks that don't require full review cycles
- The verify phase should catch common issues without the overhead of separate test/review agents
- Maintains quality through automated verification rather than multi-agent review

**Design & UX Approach**
- Flag follows existing CLI patterns (similar to --serial-tasks, --dry-run)
- Transparent to users - same command with additional flag
- Output clearly indicates which mode is being used
- Failure reporting remains consistent with existing patterns

**Technical Plan & Risks**
- Leverage existing executor architecture with minimal changes to core interfaces
- Reuse post-apply command infrastructure for verification steps
- Risk: Simpler mode might miss edge cases caught by full review cycle
- Mitigation: Verify phase includes comprehensive automated checks

**Pragmatic Effort Estimate**
- 2-3 days for full implementation including both executors
- Additional 1 day for comprehensive testing
- Low risk due to additive nature (doesn't modify existing flows)

### Acceptance Criteria
- `rmplan agent --simple` flag is recognized and processed correctly
- Claude Code executor generates only implementer and verifier agents in simple mode
- Codex CLI executor uses 2-phase loop instead of 3-phase orchestration
- Verify phase runs: type checking (`bun run check`), linting (`bun run lint`), tests (`bun test`)
- Verify phase adds tests if coverage gaps are detected
- Failure in verify phase stops execution with clear error reporting
- Normal mode (without --simple) continues to work unchanged
- Both executors produce consistent output structure in simple mode
- All new code paths are covered by tests

### Dependencies & Constraints
- **Dependencies**: Existing executor infrastructure, post-apply command system, agent prompt generation
- **Technical Constraints**: Must maintain backward compatibility with existing orchestration mode
- **Configuration Constraints**: Simple mode options must integrate with existing rmplan config schema

### Implementation Notes

**Recommended Approach**
- Add flag at CLI level and pass through existing options parameter
- Branch executor behavior based on simple mode flag
- Create new orchestrator prompts rather than modifying existing ones
- Reuse as much existing infrastructure as possible (failure detection, output capture, etc.)

**Potential Gotchas**
- Ensure simple mode flag doesn't interfere with other execution modes (review, planning)
- Verify phase must handle both missing tests and failing tests appropriately
- Planning-only detection in Codex executor needs to work in simple mode
- Agent file generation in Claude Code must conditionally create correct agents

**Testing Strategy**
- Unit tests for new orchestrator prompt functions
- Integration tests for both executors in simple mode
- Verify backward compatibility with existing mode
- Test failure scenarios in verify phase

---

## Area 1: CLI and Core Infrastructure

Tasks:
- Add --simple flag to rmplan agent CLI command
- Update executor type definitions for simple mode
- Update executor schemas to include simpleMode option
- Modify executor build process to pass simple mode flag

This phase establishes the foundation by adding the CLI flag and ensuring it flows correctly through the command handling chain to the executors. This includes updating type definitions, schemas, and the executor build process to support the new execution mode.

---

## Area 2: Claude Code Executor Simple Mode

Tasks:
- Create simple mode orchestrator prompt
- Create verifier agent prompt
- Update Claude Code executor to branch on simple mode
- Modify agent file generation for simple mode
- Add failure detection for verifier agent

This phase implements the simple mode for the Claude Code executor, including new orchestrator prompts, verifier agent creation, and conditional agent file generation. The implementation will create a streamlined 2-phase workflow while maintaining the quality assurance provided by the verify phase.

---

## Area 3: Codex CLI Executor Simple Mode

Tasks:
- Create simple mode execution loop
- Create verifier prompts for Codex
- Update main execute method to use simple loop
- Adapt planning-only detection for simple mode
- Handle task completion in simple mode

This phase implements the simple mode for the Codex CLI executor, creating a new execution loop that bypasses the full review cycle in favor of a streamlined implement-verify workflow. This includes handling planning-only detection and auto-retry mechanisms in the simplified context.

---

## Area 4: Testing and Documentation

Tasks:
- Write unit tests for simple mode prompts
- Write integration tests for Claude Code simple mode
- Write integration tests for Codex CLI simple mode
- Test interaction with other flags
- Update README and documentation
- Add CLAUDE.md notes about simple mode

This phase ensures the simple mode implementation is robust through comprehensive testing and that users can easily discover and use the new feature through updated documentation. All edge cases should be tested including failure scenarios, retry mechanisms, and interaction with other flags.

# Implemented Functionality Notes

Implemented support groundwork for tasks "Add --simple flag to rmplan agent CLI command", "Update executor type definitions for simple mode", "Update executor schemas to include simpleMode option", and "Modify executor build process to pass simple mode flag". Added the new `--simple` option to the agent CLI in `src/rmplan/rmplan.ts` so users can request the streamlined flow. Extended `ExecutorCommonOptions` in `src/rmplan/executors/types.ts` with an optional `simpleMode` flag that executors can check when orchestrating their phases. Updated both executor option schemas in `src/rmplan/executors/schemas.ts` to accept a `simpleMode` boolean so configuration files can enable the simplified mode without CLI flags. Adjusted `buildExecutorAndLog` in `src/rmplan/executors/build.ts` to accept executor-specific overrides and propagate them into `createExecutor`, and changed `src/rmplan/commands/agent/agent.ts` to populate the shared options and pass the override when the CLI flag is present (falling back to the existing signature otherwise). This establishes a consistent data path for the simple-mode signal from CLI/config into executor constructors while preserving backwards compatibility for other call sites.

Implemented tasks "Create simple mode orchestrator prompt", "Create verifier agent prompt", "Update Claude Code executor to branch on simple mode", "Modify agent file generation for simple mode", and "Add failure detection for verifier agent". Added `wrapWithOrchestrationSimple()` in `src/rmplan/executors/claude_code/orchestrator_prompt.ts` to provide implement → verify guidance, reusing plan updates/progress note directions while reshaping the workflow to two phases and adjusting the failure protocol to recognize the verifier role. Introduced `getVerifierAgentPrompt()` in `src/rmplan/executors/claude_code/agent_prompts.ts` so Claude receives a dedicated verifier agent brief that mandates running `bun run check`, `bun run lint`, `bun test`, and adding tests when gaps remain. Updated `ExecutePlanInfo` in `src/rmplan/executors/types.ts` and the agent command in `src/rmplan/commands/agent/agent.ts` to propagate a new `executionMode: 'simple'`, then taught `src/rmplan/executors/claude_code.ts` to select the simple orchestration wrapper, generate implementer/verifier agent files (reusing tester custom instructions/models for the verifier), and clean them up after execution. Centralized FAILED source parsing in `inferFailedAgent()` inside `src/rmplan/executors/failure_detection.ts`, expanding detection to include the verifier and sharing the helper with the Claude executor for consistent error reporting; added coverage in `src/rmplan/executors/failure_detection.test.ts`. Verified typings with `bun run check` and exercised the failure-detection suite with `bun test src/rmplan/executors/failure_detection.test.ts` to confirm the new logic behaves as expected.

Follow-up on tasks "Create simple mode orchestrator prompt" and "Modify agent file generation for simple mode": refined the shared progress note helper in `src/rmplan/executors/claude_code/orchestrator_prompt.ts` so every prompt explicitly recognizes the verifier role while steering agents away from retired tester/reviewer slots in simple runs, preserving accurate audit metadata. Also updated `src/rmplan/executors/claude_code.ts` to merge tester and reviewer custom instruction files before constructing the verifier prompt, ensuring policy-sensitive reviewer overrides continue to flow into simple mode verification. Added regression coverage in `src/rmplan/executors/claude_code/orchestrator_prompt.test.ts` to assert the new guidance text and extended `src/rmplan/executors/claude_code_model_test.ts` with a mocked simple-mode execution that confirms the combined instruction payload is passed through. Validated the changes with `bun run check` and `bun test src/rmplan/executors/claude_code/orchestrator_prompt.test.ts src/rmplan/executors/claude_code_model_test.ts`.

Implemented tasks "Modify agent file generation for simple mode" and "Write integration tests for Claude Code simple mode". Enhanced `src/rmplan/executors/claude_code/agent_generator.ts` so simple-mode runs prune any existing plan-scoped tester/reviewer files before emitting the implementer/verifier pair, ensuring stale agents from previous executions never linger in `.claude/agents`. Expanded `src/rmplan/executors/claude_code/agent_generator.test.ts` with regression coverage for the pruning logic and for the `[]` agent-set case so future refactors keep clearing residual files. Added a higher-level Bun test in `src/rmplan/executors/claude_code.test.ts` that exercises the executor against a temporary git root: it verifies we wrap the prompt with `wrapWithOrchestrationSimple`, only emit implementer/verifier agent markdown, and preserve the verifier frontmatter, even when pre-populated with stale testers/reviewers. The same suite now asserts that a `FAILED:` report tagged to the verifier returns structured failures with `sourceAgent: 'verifier'`, guaranteeing the orchestrator surfaces verify-phase issues correctly going forward.

Implemented tasks "Create simple mode execution loop", "Create verifier prompts for Codex", "Update main execute method to use simple loop", "Adapt planning-only detection for simple mode", and "Handle task completion in simple mode". Refactored `src/rmplan/executors/codex_cli.ts` so `execute()` routes to a new `executeSimpleMode()` that reuses the implementer retry logic but stops after a verifier pass. The simple path collects implementer/verifier events for captured output, reuses the existing planning-only detection, and shares the automatic task completion hook while skipping it on failure. Added `composeVerifierContext()` to shape verifier inputs with plan status deltas, imported `getVerifierAgentPrompt()` so the verifier instructions include combined tester/reviewer guidance, and adjusted logging to mention the verifier branch. Updated `src/rmplan/executors/codex_cli.test.ts` to assert the sandbox CLI arguments under the new branching model. Verified the changes with `bun run check`, `bun test src/rmplan/executors/codex_cli.test.ts`, `bun test src/rmplan/executors/codex_cli.retry.test.ts`, and `bun test src/rmplan/executors/codex_cli.capture_output.test.ts` to ensure the new flow coexists with the legacy implement-test-review path.

Addressed the reviewer follow-up for tasks "Modify executor build process to pass simple mode flag" and "Create simple mode execution loop" by fixing the config-driven toggle in `src/rmplan/executors/codex_cli.ts`. The executor now treats `planInfo.executionMode`, `ExecutorCommonOptions.simpleMode`, and the new `CodexCliExecutorOptions.simpleMode` as equivalent entry points, so setting `executors.codex-cli.simpleMode: true` in `rmplan.yaml` reliably activates `executeSimpleMode()`. This keeps the CLI flag (`--simple`) as the highest-precedence override while ensuring configuration defaults are honored, preserving the shared implementer retry/plan-delta logic without duplicating state. Re-ran `bun test src/rmplan/executors/codex_cli.simple_mode.test.ts` to confirm the two-phase Codex path still passes its end-to-end assertions after the guard change.

Implemented reviewer-noted fixes for tasks "Add --simple flag to rmplan agent CLI command" and "Create simple mode execution loop" by ensuring the streamlined mode actually reaches the executors in every command path. Updated `src/rmplan/commands/agent/agent.ts` to derive a single `executionMode` flag from both the CLI switch and `executors.<name>.simpleMode` config, plumb that value through `ExecutorCommonOptions`, and reuse it for the batch runner, step loop, and stub-plan shortcut. Extended `src/rmplan/commands/agent/batch_mode.ts` and `src/rmplan/commands/agent/stub_plan.ts` so their `executor.execute` calls now honor the computed `executionMode`, guaranteeing Claude and Codex receive `'simple'` when requested instead of the hard-coded `'normal'`. Strengthened regression coverage in `src/rmplan/commands/agent/agent.test.ts`, `src/rmplan/commands/agent/batch_mode.capture_output.test.ts`, and `src/rmplan/commands/agent/batch_mode.soft_failure.test.ts` to assert the new plumbing, and reran `bun run check` plus the updated Bun test subset to verify type safety and behavior.

Completed tasks "Test interaction with other flags", "Update README and documentation", and "Add CLAUDE.md notes about simple mode". Expanded `src/rmplan/commands/agent/agent.test.ts` with new spies around `findNextActionableItem`, `prepareNextStep`, and `markStepDone` so we can drive the serial execution loop under `--simple`. Added coverage that asserts the batch path still forwards `executionMode: 'simple'` alongside `dryRun: true`, and that the serial loop executes exactly once with `executor.execute` receiving the simple execution mode while post-step plumbing remains intact. Updated `README.md` with a `Simple Mode (--simple)` subsection that highlights the implement → verify flow, the verifier’s responsibility to run `bun run check`, `bun run lint`, and `bun test`, and how the flag composes with batch/serial/dry-run workflows or config defaults. Documented the architecture in `CLAUDE.md`, noting how `ExecutorCommonOptions.simpleMode` selects the streamlined orchestrators, how Claude’s implementer/verifier agent files are generated, how Codex CLI’s `executeSimpleMode()` builds verifier context, and how `inferFailedAgent()` tags verifier failures. Retained ASCII-oriented formatting while matching existing README arrow notation for consistency, and confirmed the new tests with `bun run check` plus `bun test src/rmplan/commands/agent/agent.test.ts`.

Extended unit coverage for task "Write unit tests for simple mode prompts" by enriching the prompt test suites in `src/rmplan/executors/claude_code/agent_prompts.test.ts` and `src/rmplan/executors/claude_code/orchestrator_prompt.test.ts`. Added a verifier-specific assertion that confirms custom instructions are preserved and surfaced under the `## Custom Instructions` heading (ensuring reviewers’ policy overrides survive the simple-mode pipeline), and verified progress-note guidance is embedded in the two-phase orchestration helper so orchestrators always instruct agents to log updates with `rmplan add-progress-note <planId>`. These tests guard against future regressions where the simple-mode prompts might drop mandatory guidance or lose plan-scoped customization, providing fast feedback when prompt templates change.

Implemented task "Task 17: Write integration tests for Codex CLI simple mode" by expanding `src/rmplan/executors/codex_cli.simple_mode.test.ts` with two integration-focused scenarios that exercise the new implement → verify loop through the primary entry points. The first test forces `ExecutorCommonOptions.simpleMode` to drive the workflow while `ExecutePlanInfo.executionMode` remains `'normal'`, then simulates a planning-only first attempt followed by a successful retry to ensure warning and retry logs fire and that captured steps include both implementer attempts plus the verifier output. The second test enables `CodexCliExecutorOptions.simpleMode` to confirm configuration defaults hit the same path, verifying aggregated output when capture mode is `'all'` and that automatic task completion still runs on success. Both tests stub `captureRepositoryState`, `spawnAndLogOutput`, and prompt factories to focus on orchestration behavior while using real `execute()` plumbing, and they assert that planning-only detection, aggregated step titles, and final verifier messaging behave exactly as expected. Validated the additions with `bun test src/rmplan/executors/codex_cli.simple_mode.test.ts` to guard against regressions in the simplified Codex loop.

Addressed follow-up work for tasks "Create simple mode execution loop" and "Test interaction with other flags" by tightening the Codex executor's mode switching. Updated `CodexCliExecutor.execute` in `src/rmplan/executors/codex_cli.ts` so configuration- or CLI-supplied `simpleMode` flags only activate the implement→verify path when `planInfo.executionMode` is `'normal'`, preserving review (`'review'`) and planning (`'planning'`) workflows that depend on the traditional orchestration. Added the regression test `simple mode flags do not force review or planning executions into simple loop` to `src/rmplan/executors/codex_cli.simple_mode.test.ts`, stubbing the executor methods to assert that both configuration (`options.simpleMode`) and shared (`ExecutorCommonOptions.simpleMode`) flags still dispatch to `executeNormalMode`. Verified the guard and coverage with `bun test src/rmplan/executors/codex_cli.simple_mode.test.ts` to prevent this regression from resurfacing.
