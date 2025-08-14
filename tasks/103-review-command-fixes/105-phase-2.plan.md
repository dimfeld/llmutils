---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: review command fixes - Introduce Autofix Functionality
goal: To build upon the review-only functionality by adding an `--autofix`
  option and an interactive prompt, allowing users to explicitly trigger an
  automated code-fixing process based on the review results.
id: 105
status: in_progress
priority: high
dependencies:
  - 104
parent: 103
planGeneratedAt: 2025-08-13T23:59:15.240Z
promptsGeneratedAt: 2025-08-14T00:19:30.410Z
createdAt: 2025-08-13T23:54:11.755Z
updatedAt: 2025-08-14T00:19:30.786Z
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
    description: >
      Update the CLI definition in rmplan.ts to add a new --autofix boolean
      option to the review command. This flag will allow users to automatically
      trigger code fixes based on review findings without being prompted. The
      option should be placed after the existing review command options,
      following the same pattern as other boolean flags in the codebase.
      Reference the existing options like --dry-run and --save for consistency
      in naming and placement.
    files:
      - src/rmplan/rmplan.ts
    steps:
      - prompt: >
          Add a new --autofix option to the review command definition in
          rmplan.ts after the existing options.

          The option should be a boolean flag with a description explaining that
          it automatically fixes issues found during review.
        done: true
      - prompt: >
          Also add a --no-autofix option to explicitly disable autofix even if
          it might be configured elsewhere,

          following the pattern used for other boolean options like
          --save/--no-save.
        done: true
  - title: Implement Autofix and Interactive Prompt Logic
    description: >
      In the handleReviewCommand function, after the initial review is complete
      and the reviewResult is created, add logic to check if any issues were
      identified. Use the reviewResult.summary.totalIssues property to determine
      if issues exist. If issues are found and the --autofix flag was not
      provided, use the confirm function from @inquirer/prompts to ask the user
      if they want to automatically fix the identified issues. The prompt should
      follow the existing pattern in the codebase, with a clear message and
      appropriate default value. Store the user's decision in a variable that
      will be used to determine whether to proceed with the autofix execution.
    files:
      - src/rmplan/commands/review.ts
    steps:
      - prompt: >
          Import the confirm function from @inquirer/prompts at the top of
          review.ts,

          following the existing import patterns in the file.
        done: true
      - prompt: >
          After the reviewResult is created (around line 428), add logic to
          check if reviewResult.summary.totalIssues > 0.

          If there are issues and options.autofix is not set, create an
          interactive confirmation prompt.
        done: true
      - prompt: >
          Create the confirm prompt with a message like "Issues were found
          during review. Would you like to automatically fix them?"

          Set the default to false for safety. Store the result in a
          shouldAutofix variable.
        done: true
      - prompt: >
          Combine the autofix flag and prompt result to determine if autofix
          should proceed:

          const performAutofix = options.autofix || (shouldAutofix &&
          !options.noAutofix).
        done: true
  - title: Create and Execute Autofix Prompt
    description: >
      If the user confirms the autofix or if the --autofix flag was passed,
      construct a new prompt that includes the original review feedback and
      instructs the agent to fix the identified problems. The prompt should
      include the full review output or at least the issues section, along with
      clear instructions to address each identified issue. This new prompt will
      then be passed to the executor again, but this time ensuring the
      executionMode is set to 'normal' (or omitted entirely) to trigger the full
      implement/test/review cycle. The autofix execution should use the same
      executor configuration as the initial review but with the different
      execution mode. Log appropriate messages to inform the user that autofix
      is being executed.
    files:
      - src/rmplan/commands/review.ts
    steps:
      - prompt: >
          Create a helper function buildAutofixPrompt that takes the planData,
          reviewResult, and diffResult as parameters.

          The function should construct a prompt that includes the review
          findings and instructions to fix all identified issues.
        done: true
      - prompt: >
          In the autofix prompt, include the plan context, the list of issues
          from reviewResult.issues,

          and clear instructions to fix each issue while maintaining the plan
          requirements.
        done: true
      - prompt: >
          If performAutofix is true, log a message indicating that autofix is
          being executed,

          then call executor.execute with the autofix prompt and executionMode
          set to 'normal' or undefined.
        done: true
      - prompt: >
          After the autofix execution completes, log a success message.

          Handle any errors that might occur during autofix execution with
          appropriate error messages.
        done: true
  - title: Add Tests for Autofix Feature
    description: >
      Update the tests for the review command to cover the new --autofix
      functionality. This includes testing the command with the flag set (should
      execute autofix without prompting), testing the interactive prompt flow
      when issues are found but no flag is provided, and ensuring that no
      autofix occurs when no issues are found or when the user declines the
      prompt. The tests should mock the @inquirer/prompts confirm function to
      simulate user input and verify that the executor is called with the
      correct executionMode in each scenario. Follow the existing test patterns
      in review.test.ts, using the ModuleMocker class for mocking dependencies.
    files:
      - src/rmplan/commands/review.test.ts
    steps:
      - prompt: >
          Add a test case that verifies when --autofix flag is provided and
          issues are found,

          the executor is called twice: once with executionMode 'simple' for
          review, then with 'normal' for autofix.
        done: false
      - prompt: >
          Add a test case for the interactive prompt scenario: when issues are
          found without --autofix flag,

          mock the confirm function to return true and verify the autofix
          execution occurs.
        done: false
      - prompt: >
          Add a test case where the user declines the autofix prompt (confirm
          returns false),

          and verify that the executor is only called once for the review, not
          for autofix.
        done: false
      - prompt: >
          Add a test case where no issues are found (totalIssues = 0),

          and verify that no prompt appears and no autofix execution occurs
          regardless of the --autofix flag.
        done: false
      - prompt: >
          Add a test to verify that --no-autofix flag prevents autofix even when
          issues are found,

          ensuring no prompt appears and no second execution occurs.
        done: false
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
