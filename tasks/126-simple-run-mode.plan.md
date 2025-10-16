---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: simple run mode
goal: Implement a --simple flag for the rmplan agent command that runs executors
  in a streamlined 2-phase "implement and verify" mode instead of the current
  3-phase "implement-test-review" orchestration loop.
id: 126
generatedBy: agent
status: in_progress
priority: medium
container: false
dependencies: []
issue: []
pullRequest: []
docs: []
planGeneratedAt: 2025-10-16T08:11:33.994Z
createdAt: 2025-10-16T08:04:19.031Z
updatedAt: 2025-10-16T08:49:22.193Z
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
tasks:
  - title: Add --simple flag to rmplan agent CLI command
    done: true
    description: Update `/src/rmplan/rmplan.ts` to add the --simple option after
      line 349 in the `createAgentCommand()` function. Follow the pattern of
      existing flags like --serial-tasks.
    files: []
    docs: []
    steps: []
  - title: Update executor type definitions for simple mode
    done: true
    description: Modify `/src/rmplan/executors/types.ts` to support simple mode in
      ExecutorCommonOptions or ExecutePlanInfo. Consider adding an executionMode
      variant or a separate simpleMode boolean field.
    files: []
    docs: []
    steps: []
  - title: Update executor schemas to include simpleMode option
    done: true
    description: Add simpleMode field to both claudeCodeOptionsSchema and
      codexCliOptionsSchema in `/src/rmplan/executors/schemas.ts`. Include
      proper zod validation and descriptions.
    files: []
    docs: []
    steps: []
  - title: Modify executor build process to pass simple mode flag
    done: true
    description: Update `/src/rmplan/executors/build.ts` buildExecutorAndLog
      function to accept and pass executor-specific options. Modify the call
      site in `/src/rmplan/commands/agent/agent.ts` to pass the simple flag when
      present.
    files: []
    docs: []
    steps: []
  - title: Create simple mode orchestrator prompt
    done: false
    description: Add new `wrapWithOrchestrationSimple()` function in
      `/src/rmplan/executors/claude_code/orchestrator_prompt.ts` that provides
      2-phase orchestration instructions (implement → verify) instead of the
      current 3-phase flow.
    files: []
    docs: []
    steps: []
  - title: Create verifier agent prompt
    done: false
    description: Add `getVerifierAgentPrompt()` function in
      `/src/rmplan/executors/claude_code/agent_prompts.ts` that combines testing
      and validation responsibilities. The verifier should run type checking,
      linting, tests, and add tests if needed.
    files: []
    docs: []
    steps: []
  - title: Update Claude Code executor to branch on simple mode
    done: false
    description: Modify `/src/rmplan/executors/claude_code.ts` execute() method
      around line 789 to check for simple mode and use
      wrapWithOrchestrationSimple() instead of wrapWithOrchestration() when
      appropriate.
    files: []
    docs: []
    steps: []
  - title: Modify agent file generation for simple mode
    done: false
    description: Update `/src/rmplan/executors/claude_code/agent_generator.ts` to
      conditionally generate implementer and verifier agents in simple mode
      instead of implementer, tester, and reviewer agents.
    files: []
    docs: []
    steps: []
  - title: Add failure detection for verifier agent
    done: false
    description: "Extend failure detection in
      `/src/rmplan/executors/failure_detection.ts` to recognize failures from
      the new verifier agent using the existing FAILED: protocol."
    files: []
    docs: []
    steps: []
  - title: Create simple mode execution loop
    done: false
    description: Add new method in `/src/rmplan/executors/codex_cli.ts` for simple
      mode execution that implements the 2-phase loop (implement → verify)
      without the review and fix iteration phases.
    files: []
    docs: []
    steps: []
  - title: Create verifier prompts for Codex
    done: false
    description: Add verifier prompt generation functions in Codex executor that
      instruct the agent to run verification commands and ensure all checks
      pass.
    files: []
    docs: []
    steps: []
  - title: Update main execute method to use simple loop
    done: false
    description: Modify the execute() method in Codex CLI executor to check for
      simple mode and call the new simple execution loop instead of the full
      orchestration loop.
    files: []
    docs: []
    steps: []
  - title: Adapt planning-only detection for simple mode
    done: false
    description: Ensure the planning-only detection and retry mechanism works
      correctly in simple mode, with appropriate retry messages for the
      simplified workflow.
    files: []
    docs: []
    steps: []
  - title: Handle task completion in simple mode
    done: false
    description: Adapt the auto task completion logic to work with the simplified
      output from the 2-phase execution.
    files: []
    docs: []
    steps: []
  - title: Write unit tests for simple mode prompts
    done: false
    description: Create tests for wrapWithOrchestrationSimple() and
      getVerifierAgentPrompt() functions to ensure correct prompt generation.
    files: []
    docs: []
    steps: []
  - title: Write integration tests for Claude Code simple mode
    done: false
    description: Add tests in the Claude Code executor test file that verify the
      complete 2-phase flow works correctly, including agent file generation and
      failure handling.
    files: []
    docs: []
    steps: []
  - title: Write integration tests for Codex CLI simple mode
    done: false
    description: Add tests for the Codex CLI executor's simple mode loop, including
      planning-only detection and retry behavior in the simplified context.
    files: []
    docs: []
    steps: []
  - title: Test interaction with other flags
    done: false
    description: Verify that --simple flag works correctly with other options like
      --batch, --serial-tasks, and --dry-run, ensuring no conflicts or
      unexpected behavior.
    files: []
    docs: []
    steps: []
  - title: Update README and documentation
    done: false
    description: Update the main README.md to document the new --simple flag,
      explaining when to use it and how it differs from the standard execution
      mode. Include examples of usage.
    files: []
    docs: []
    steps: []
  - title: Add CLAUDE.md notes about simple mode
    done: false
    description: Update the CLAUDE.md file with implementation details about the
      simple mode architecture for future development reference.
    files: []
    docs: []
    steps: []
changedFiles:
  - src/rmplan/commands/agent/agent.test.ts
  - src/rmplan/commands/agent/agent.ts
  - src/rmplan/executors/build.test.ts
  - src/rmplan/executors/build.ts
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
