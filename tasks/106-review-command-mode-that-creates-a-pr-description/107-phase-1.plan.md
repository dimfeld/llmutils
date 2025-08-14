---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Change description command - Core Functionality and Context Refactoring
goal: To implement the foundational `description` command that generates a PR
  description and refactor the shared context-gathering logic from the `review`
  command.
id: 107
status: done
priority: high
dependencies: []
parent: 106
planGeneratedAt: 2025-08-14T01:21:36.414Z
promptsGeneratedAt: 2025-08-14T01:47:03.856Z
createdAt: 2025-08-14T00:55:08.903Z
updatedAt: 2025-08-14T02:46:58.475Z
project:
  title: Implement a `description` command to generate PR descriptions from plan
    context
  goal: To create a new `rmplan description` command that, similar to the `review`
    command, gathers context from a plan and code changes, but uses it to
    generate a comprehensive pull request description.
  details: >
    This project introduces a new `description` command to streamline the
    process of writing pull request descriptions. The command will leverage the
    existing context-gathering mechanisms of the `review` command by refactoring
    this logic into a shared utility.


    The new command will:

    1.  Accept a plan file path or ID as input.

    2.  Gather context including the plan's details, tasks, hierarchy
    (parent/child plans), and a diff of code changes.

    3.  Use a specialized prompt to instruct an LLM to generate a detailed PR
    description.

    4.  The generated description will cover what was implemented, what changed,
    what was intentionally not changed, how the changes integrate, optional
    Mermaid diagrams, and potential future work.

    5.  Provide interactive options to the user for handling the output, such as
    copying to the clipboard, saving to a file, or creating a PR directly using
    the GitHub CLI.


    Unlike the `review` command, this new command will not support incremental
    reviews, issue detection, or autofixing, as its sole purpose is text
    generation.


    **Acceptance Criteria:**

    - A new `rmplan description <plan>` command is available in the CLI.

    - The context-gathering logic from the `review` command is successfully
    refactored into a shared function without breaking existing `review`
    functionality.

    - The `description` command generates a PR description and prints it to the
    console.

    - The user is prompted with options to copy the description, save it to a
    file, or create a PR.

    - The command is documented and has corresponding tests.


    **Technical Considerations:**

    - The refactoring of context-gathering logic from
    `src/rmplan/commands/review.ts` is a critical first step. This shared
    utility will be used by both `review` and the new `description` command.

    - A new prompt will be created, likely in
    `src/rmplan/executors/claude_code/agent_prompts.ts`, specifically for
    generating PR descriptions.

    - The `@inquirer/prompts` library will be used for interactive output
    handling.

    - The GitHub CLI (`gh`) will be invoked as a subprocess for the "Create PR"
    option.
tasks:
  - title: Refactor Context Gathering Logic
    done: true
    description: >
      Create a new shared function that encapsulates the context-gathering logic
      currently within the `handleReviewCommand`. This includes resolving the
      plan file, reading plan data, traversing the plan hierarchy (parents and
      children), and generating a diff of code changes. Update the `review`
      command to use this new utility, ensuring no regressions.


      The new function should be created in
      `src/rmplan/utils/context_gathering.ts` and should return a structured
      object containing all gathered context. This follows the existing pattern
      of utility modules in the utils directory.


      Key requirements:

      - Extract lines 168-303 (approximately) from handleReviewCommand

      - Return an object with planData, parentChain, completedChildren, and
      diffResult

      - Handle incremental review options properly

      - Maintain all existing error handling and logging

      - Use dependency injection for better testability
    files:
      - src/rmplan/utils/context_gathering.ts
      - src/rmplan/utils/context_gathering.test.ts
      - src/rmplan/commands/review.ts
    steps:
      - prompt: >
          Create a test file at src/rmplan/utils/context_gathering.test.ts that
          tests the new gatherPlanContext function.

          Include tests for: basic context gathering, parent chain loading,
          completed children loading, diff generation, and incremental review
          scenarios.

          Use temporary directories and real filesystem operations rather than
          mocks where possible.
        done: false
      - prompt: >
          Create src/rmplan/utils/context_gathering.ts with a gatherPlanContext
          function that takes plan file path, options, and dependencies as
          parameters.

          The function should return an object with planData, parentChain,
          completedChildren, and diffResult properties.

          Include proper TypeScript types for the return value and parameters.
        done: false
      - prompt: >
          Extract the context gathering logic from handleReviewCommand (lines
          168-303 approximately) into the new gatherPlanContext function.

          This includes plan resolution, validation, hierarchy traversal,
          incremental review handling, and diff generation.

          Ensure all error handling and logging is preserved.
        done: false
      - prompt: >
          Update handleReviewCommand in src/rmplan/commands/review.ts to use the
          new gatherPlanContext function.

          Replace the extracted code with a call to gatherPlanContext and
          destructure its return value.

          Ensure the review command continues to work exactly as before.
        done: false
      - prompt: >
          Run all tests for both the new context_gathering module and the
          existing review command to ensure no regressions.

          Fix any issues that arise and verify that the refactoring maintains
          identical functionality.
        done: false
  - title: Create the PR Description Prompt
    done: true
    description: >
      Develop a new prompt function, `getPrDescriptionPrompt`, that takes the
      gathered context and constructs a detailed prompt for an LLM. The prompt
      should instruct the model to generate a PR description covering
      implementation details, changes, integration, and potential future
      improvements, including optional Mermaid diagrams.


      This follows the existing pattern in
      src/rmplan/executors/claude_code/agent_prompts.ts where each agent has its
      own prompt function returning an AgentDefinition.


      The prompt should instruct the LLM to generate:

      - Summary of what was implemented

      - List of changes made to existing functionality

      - Explanation of what could have been changed but was intentionally left
      unchanged

      - Description of how the changes integrate with the existing system

      - Optional Mermaid diagrams if they help explain the architecture or flow

      - Potential future improvements or follow-up work
    files:
      - src/rmplan/executors/claude_code/agent_prompts.ts
      - src/rmplan/executors/claude_code/agent_prompts.test.ts
    steps:
      - prompt: >
          Add a test in agent_prompts.test.ts (create if it doesn't exist) for
          the new getPrDescriptionPrompt function.

          Test that it returns a properly structured AgentDefinition with name,
          description, and prompt fields.

          Verify the prompt includes all required sections for PR description
          generation.
        done: false
      - prompt: >
          Implement getPrDescriptionPrompt in agent_prompts.ts following the
          existing pattern of other prompt functions.

          The function should accept contextContent and optional
          customInstructions parameters.

          Return an AgentDefinition with name 'pr-description' and appropriate
          description.
        done: false
      - prompt: >
          Write the detailed prompt content that instructs the LLM to generate
          comprehensive PR descriptions.

          Include sections for implementation summary, changes made, integration
          details, optional diagrams, and future work.

          Ensure the prompt is clear and structured to produce well-formatted
          markdown output.
        done: false
  - title: Implement the `description` Command Handler
    done: true
    description: >
      Create a new `description.ts` file and implement the
      `handleDescriptionCommand` function. This function will orchestrate the
      command's flow: call the shared context-gathering function, build the
      prompt, execute it via an LLM executor, and print the resulting
      description to the console.


      The handler should follow the existing pattern of command handlers in
      src/rmplan/commands/, using similar error handling, configuration loading,
      and executor setup as seen in the review command.


      Key implementation details:

      - Use the gatherPlanContext function from Task 1 to get all necessary
      context

      - Build the prompt using getPrDescriptionPrompt from Task 2

      - Execute using the existing executor system with appropriate options

      - Print the generated description to stdout

      - Support dry-run mode to show the prompt without execution

      - Handle errors gracefully with informative messages
    files:
      - src/rmplan/commands/description.ts
      - src/rmplan/commands/description.test.ts
    steps:
      - prompt: >
          Create a test file at src/rmplan/commands/description.test.ts with
          tests for the handleDescriptionCommand function.

          Include tests for: successful description generation, dry-run mode,
          error handling, and different executor configurations.

          Use temporary plan files and mock executors where necessary.
        done: false
      - prompt: >
          Create src/rmplan/commands/description.ts with the
          handleDescriptionCommand export.

          Import necessary dependencies including the context gathering utility,
          prompt function, and executor system.

          Add proper TypeScript types for the function parameters.
        done: false
      - prompt: >
          Implement the main flow of handleDescriptionCommand: load
          configuration, gather context using gatherPlanContext, and validate
          the plan has changes.

          Handle the case where no changes are detected by showing an
          appropriate message and returning early.
        done: false
      - prompt: >
          Build the PR description prompt using getPrDescriptionPrompt with the
          gathered context.

          Set up the executor using buildExecutorAndLog with appropriate
          options.

          Handle dry-run mode by printing the prompt and returning without
          execution.
        done: false
      - prompt: |
          Execute the prompt using the executor and capture the output.
          Print the generated PR description to stdout using the log function.
          Add proper error handling with contextual error messages.
        done: false
      - prompt: >
          Run the tests for the description command and fix any issues.

          Ensure all edge cases are handled properly and the command provides
          helpful output.
        done: false
  - title: Register the New `description` Command
    done: true
    description: >
      Add the `description` command to the main CLI entry point in `rmplan.ts`.
      The command should accept a plan file/ID and support relevant options like
      `--executor`, `--model`, and `--dry-run`.


      The registration should follow the existing pattern of other commands in
      the file, placed near the review command for logical grouping since they
      share similar functionality.


      Command syntax: `rmplan description <plan>`


      Options to support:

      - --executor <name>: Choose the executor for LLM execution

      - --model <model>: Override the default model

      - --dry-run: Show the prompt without executing

      - --instructions <text>: Custom instructions for the PR description

      - --instructions-file <path>: Path to file with custom instructions
    files:
      - src/rmplan/rmplan.ts
    steps:
      - prompt: >
          Add the description command registration in rmplan.ts after the review
          command (around line 540).

          Use the same pattern as other commands with proper description and
          command syntax.

          Include options for executor, model, dry-run, instructions, and
          instructions-file.
        done: false
      - prompt: >
          Add the dynamic import and action handler for the description command.

          Import handleDescriptionCommand from './commands/description.js' and
          call it with proper error handling using handleCommandError.
        done: false
      - prompt: >
          Test the command registration by running the CLI with --help to verify
          the description command appears.

          Test running the actual command with a sample plan file to ensure
          end-to-end functionality works.
        done: false
rmfilter:
  - src/rmplan/commands/review.ts
  - --with-imports
  - --
  - src/rmplan/rmplan.ts
---

This phase focuses on establishing the core logic. We will first refactor the context-gathering code out of the `review` command into a reusable function. This ensures that both the existing `review` command and the new `description` command use the same, consistent method for understanding the state of a plan and its associated code changes. Then, we will build the new `description` command on top of this refactored logic, implementing the prompt and basic execution flow to generate and display a PR description.

**Acceptance Criteria:**
- A new shared function exists that gathers plan data, hierarchy, and diff context.
- The `review` command is updated to use this shared function and continues to work as expected.
- A new `rmplan description` command is registered in the CLI.
- The `description` command can successfully generate a PR description and print it to the console.
- The new command and refactored function are covered by unit tests.
