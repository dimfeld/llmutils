---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Change description command - Interactive Output Handling and CLI Integration
goal: To enhance the `description` command with interactive options for handling
  the generated output, allowing users to easily copy it, save it, or create a
  pull request.
id: 108
uuid: 4355adc3-94bc-495b-85d4-fac736a356ee
status: done
priority: medium
dependencies:
  - 107
parent: 106
references:
  "106": 27e9901d-bf18-480c-8eab-ad70c6fc8e93
  "107": 2cd3bc4b-d3f3-4c94-b1c0-76754338142c
planGeneratedAt: 2025-08-14T01:21:36.414Z
promptsGeneratedAt: 2025-08-14T03:19:37.519Z
createdAt: 2025-08-14T00:55:08.903Z
updatedAt: 2025-10-27T08:39:04.325Z
project:
  title: Implement a `description` command to generate PR descriptions from plan
    context
  goal: To create a new `tim description` command that, similar to the `review`
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

    - A new `tim description <plan>` command is available in the CLI.

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
    `src/tim/commands/review.ts` is a critical first step. This shared
    utility will be used by both `review` and the new `description` command.

    - A new prompt will be created, likely in
    `src/tim/executors/claude_code/agent_prompts.ts`, specifically for
    generating PR descriptions.

    - The `@inquirer/prompts` library will be used for interactive output
    handling.

    - The GitHub CLI (`gh`) will be invoked as a subprocess for the "Create PR"
    option.
tasks:
  - title: Add Output Handling CLI Flags
    done: true
    description: >
      Extend the `description` command definition in `tim.ts` to include
      flags for non-interactive output handling: `--output-file <path>` to save
      to a file, `--copy` to copy to the clipboard, and `--create-pr` to
      initiate PR creation. Also update the DescriptionOptions interface in
      description.ts to include these new options.


      The flags should follow the existing patterns in the codebase:

      - Use `.option()` method on the command object

      - Include helpful descriptions for each flag

      - Make --output-file accept a path parameter

      - Make --copy and --create-pr boolean flags
  - title: Implement Direct Output Actions
    done: true
    description: >
      In `handleDescriptionCommand`, add logic to process the new CLI flags. If
      a flag is present, perform the corresponding action (write to file, copy
      to clipboard, or invoke `gh pr create`) immediately after the description
      is generated.


      For file output: Use writeFile from node:fs/promises and ensure the
      directory exists

      For clipboard: Use the write function from src/common/clipboard.ts

      For PR creation: Use logSpawn from src/common/process.ts to run the gh CLI
      command


      The implementation should handle these flags after the description is
      successfully generated but before the success message. Multiple flags can
      be specified together (e.g., both --copy and --output-file).
  - title: Implement Interactive Output Prompt
    done: true
    description: >
      If no output-related flags are provided, use the `@inquirer/prompts`
      library to display a checklist or series of questions to the user. The
      prompt will offer choices to copy to clipboard, write to a file, or create
      a PR, and the command will act based on the user's selection.


      Use the select prompt with multiple choices, allowing the user to choose
      one or more actions.

      The interactive prompt should only appear when none of the output flags
      (--output-file, --copy, --create-pr) are provided.


      For the file output option in interactive mode, prompt for the filename
      using the input function.

      Show clear action descriptions in the prompt choices.
  - title: Add Tests for Output Handling
    done: true
    description: >
      Create or update tests for the `description` command to verify the
      behavior of the new output flags and the interactive prompt. Mock external
      dependencies like the clipboard, filesystem, and the `gh` CLI subprocess
      to test the command's logic in isolation.


      The tests should cover:

      - Each individual flag (--output-file, --copy, --create-pr)

      - Multiple flags used together

      - Interactive mode when no flags are provided

      - Error cases (file write failures, gh command failures)


      Use the existing test structure in description.test.ts as a template,
      following the ModuleMocker pattern already established.
rmfilter:
  - src/tim/commands/review.ts
  - --with-imports
  - --
  - src/tim/tim.ts
---

Building on the core functionality from Phase 1, this phase adds the user-facing output handling features. We will add CLI flags for direct actions and implement an interactive prompt as a fallback. This will make the command significantly more useful in a real-world development workflow.

**Acceptance Criteria:**
- The `description` command supports `--output-file`, `--copy`, and `--create-pr` flags.
- If no output flags are provided, an interactive prompt is displayed with choices for handling the description.
- The "Copy to clipboard" option works correctly.
- The "Write to file" option saves the description to a user-specified path.
- The "Create PR" option successfully uses the `gh` CLI to create a pull request with the generated description.
- New functionality is covered by tests.
