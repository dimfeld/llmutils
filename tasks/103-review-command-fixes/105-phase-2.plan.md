---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: review command fixes - Introduce Autofix Functionality
goal: To build upon the review-only functionality by adding an `--autofix`
  option and an interactive prompt, allowing users to explicitly trigger an
  automated code-fixing process based on the review results.
id: 105
status: pending
priority: high
dependencies:
  - 104
parent: 103
planGeneratedAt: 2025-08-13T23:59:15.240Z
createdAt: 2025-08-13T23:54:11.755Z
updatedAt: 2025-08-13T23:59:15.240Z
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
  - title: Add --autofix Flag to Review Command
    description: Update the CLI definition in `rmplan.ts` to add a new `--autofix`
      boolean option to the `review` command.
    steps: []
  - title: Implement Autofix and Interactive Prompt Logic
    description: In the `handleReviewCommand` function, after the initial review is
      complete, check the review output for any identified issues. If issues are
      found and the `--autofix` flag was not provided, use `@inquirer/prompts`
      to ask the user if they wish to attempt an automatic fix.
    steps: []
  - title: Create and Execute Autofix Prompt
    description: If the user confirms the autofix or if the `--autofix` flag was
      passed, construct a new prompt that includes the original review feedback
      and instructs the agent to fix the identified problems. This new prompt
      will then be passed to the executor, ensuring the `executionMode` is set
      to 'normal' (or omitted) to trigger the full implement/test/review cycle.
    steps: []
  - title: Add Tests for Autofix Feature
    description: Update the tests for the `review` command to cover the new
      `--autofix` functionality. This includes testing the command with the
      flag, verifying the interactive prompt flow, and ensuring the subsequent
      autofix execution is triggered in the correct (normal) mode.
    steps: []
rmfilter:
  - src/rmplan/rmplan.ts
  - src/rmplan/commands/review.ts
  - src/rmplan/executors
---

This phase introduces the autofix feature. We will add an `--autofix` flag to the `review` command. If this flag is passed, or if the user agrees via an interactive prompt, the results of the initial review will be used to create a new prompt to fix the identified issues. This new prompt will then be executed using the standard, full-featured mode of the executor.

### Acceptance Criteria
- A new `--autofix` flag is available for the `review` command.
- When `--autofix` is used, the review results are used to generate and execute a new task to fix the code.
- If `--autofix` is not present and the review identifies issues, the user is prompted to start the autofix process.
- The autofix process uses the executor's standard, full-featured execution mode.
