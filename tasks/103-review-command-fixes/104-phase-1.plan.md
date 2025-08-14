---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: review command fixes - Implement "Simple" Execution Mode for Review-Only
  Operations
goal: To create a "simple" execution mode that allows the `review` command to
  perform a review without triggering unintended code modifications, fixing the
  core issue with the current implementation.
id: 104
status: in_progress
priority: high
dependencies: []
parent: 103
planGeneratedAt: 2025-08-13T23:59:15.240Z
promptsGeneratedAt: 2025-08-14T00:03:28.561Z
createdAt: 2025-08-13T23:54:11.755Z
updatedAt: 2025-08-14T00:03:28.921Z
project:
  title: Refactor the review command to separate review and autofix functionality
  goal: The goal of this project is to modify the `review` command to perform a
    review-only action by default and introduce an explicit `--autofix` option
    to trigger a subsequent fix-up process, providing a more predictable and
    user-controlled workflow.
  details: The current implementation of the `rmplan review` command uses the
    standard executor, which for `claude-code` initiates a full
    implement/test/review cycle. This means it not only reviews the code but
    also attempts to fix any identified issues, which is not the intended
    default behavior. This project will introduce a "simple" execution mode for
    executors. For the `claude-code` executor, this mode will run a prompt
    directly without the multi-agent orchestration, effectively performing a
    review-only task. The `review` command will use this simple mode by default.
    Additionally, an `--autofix` flag will be added to the `review` command.
    When this flag is used, or when the user interactively consents, the system
    will take the output from the initial review and feed it back into the
    executor using the standard (non-simple) execution mode to automatically fix
    the identified problems.
tasks:
  - title: Add Execution Mode to Executor Interface
    description: >
      Modify the `ExecutePlanInfo` interface in the executor type definitions to
      include a new optional `executionMode` property. This property will accept
      values 'simple' or 'normal' (defaulting to 'normal' when not specified),
      allowing commands to specify the desired execution behavior. The simple
      mode will be used by the review command to bypass orchestration, while
      normal mode maintains the current behavior with full multi-agent
      orchestration.
    files:
      - src/rmplan/executors/types.ts
    steps:
      - prompt: >
          Add an optional `executionMode` property to the `ExecutePlanInfo`
          interface with type `'simple' | 'normal'`.

          Document the property to explain that 'simple' mode bypasses
          orchestration and runs prompts directly,

          while 'normal' mode uses the full multi-agent orchestration workflow.
        done: true
  - title: Implement Simple Execution Logic in ClaudeCodeExecutor
    description: >
      Update the `ClaudeCodeExecutor`'s `execute` method to check for
      `executionMode: 'simple'`. When this mode is active, the executor should
      bypass the multi-agent orchestration (i.e., skip `wrapWithOrchestration`
      and agent file generation) and run the provided prompt directly through
      the `claude` command. This ensures no sub-agents are invoked and the
      review runs as a single direct prompt. The implementation should preserve
      the existing behavior for normal mode and other features like output
      capture.
    files:
      - src/rmplan/executors/claude_code.ts
    steps:
      - prompt: >
          In the `execute` method, add a check for `planInfo?.executionMode ===
          'simple'` before the orchestration wrapping logic.

          When in simple mode, skip the `wrapWithOrchestration` call and keep
          the original contextContent unchanged.
        done: true
      - prompt: >
          Ensure that agent file generation (the `generateAgentFiles` and
          cleanup logic) is only executed when NOT in simple mode.

          Move the agent file generation block inside a conditional that checks
          for normal mode or undefined executionMode.
        done: true
      - prompt: >
          Verify that all other features like output capture, permissions MCP,
          and interactive mode continue to work correctly

          in both simple and normal execution modes.
        done: true
  - title: Set Review Command to Use Simple Execution Mode
    description: >
      Modify the `handleReviewCommand` function to call the executor with
      `executionMode: 'simple'` in the `ExecutePlanInfo` object. This change
      ensures that when a user runs `rmplan review`, it performs a review-only
      operation by default without invoking the multi-agent orchestration. The
      review will run as a single direct prompt to Claude, providing the review
      analysis without attempting to fix any issues.
    files:
      - src/rmplan/commands/review.ts
    steps:
      - prompt: >
          In the `handleReviewCommand` function, locate where the executor's
          `execute` method is called with the ExecutePlanInfo object.

          Add `executionMode: 'simple'` to the ExecutePlanInfo object to enable
          simple execution mode for reviews.
        done: true
  - title: Add Tests for Simple Execution Mode
    description: >
      Create comprehensive unit tests for the `ClaudeCodeExecutor` to validate
      the behavior of the simple execution mode, ensuring it does not invoke the
      orchestration logic or generate agent files. Update the tests for the
      `review` command to verify it correctly calls the executor in simple mode.
      The tests should use the existing testing patterns with ModuleMocker and
      verify behavior through spies and mocks on the key functions that should
      be skipped in simple mode.
    files:
      - src/rmplan/executors/claude_code.test.ts
      - src/rmplan/commands/review.test.ts
    steps:
      - prompt: >
          In claude_code.test.ts, add a test case that verifies when
          executionMode is 'simple', the orchestration wrapper

          is not applied to the context content. Mock the wrapWithOrchestration
          function and verify it's not called in simple mode.
        done: false
      - prompt: >
          Add another test in claude_code.test.ts to verify that agent files are
          not generated when in simple execution mode.

          Mock the generateAgentFiles and removeAgentFiles functions and ensure
          they're not called when executionMode is 'simple'.
        done: false
      - prompt: >
          In review.test.ts, add or update a test to verify that
          handleReviewCommand passes executionMode: 'simple' to the executor.

          Mock the executor's execute method and verify it receives the correct
          ExecutePlanInfo with executionMode set to 'simple'.
        done: false
      - prompt: >
          Add a test to verify that normal mode (or undefined executionMode)
          continues to work as before, with orchestration

          and agent file generation happening as expected.
        done: false
rmfilter:
  - src/rmplan/rmplan.ts
  - src/rmplan/commands/review.ts
  - src/rmplan/executors
---

This phase focuses on creating the foundational "simple" execution mode and integrating it into the `review` command. We will modify the executor interface to support different execution modes and update the `ClaudeCodeExecutor` to handle this new mode by bypassing its complex orchestration logic. This will ensure that `rmplan review` behaves as expected, only providing a review analysis.

### Acceptance Criteria
- The `rmplan review <plan>` command, by default, only executes a review and does not modify any code.
- The `claude-code` executor has a "simple" execution mode that bypasses the multi-agent orchestration.
