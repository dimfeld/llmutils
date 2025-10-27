---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
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
planGeneratedAt: 2025-08-14T01:21:36.414Z
promptsGeneratedAt: 2025-08-14T03:19:37.519Z
createdAt: 2025-08-14T00:55:08.903Z
updatedAt: 2025-10-27T08:39:04.325Z
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
  - title: Add Output Handling CLI Flags
    done: true
    description: >
      Extend the `description` command definition in `rmplan.ts` to include
      flags for non-interactive output handling: `--output-file <path>` to save
      to a file, `--copy` to copy to the clipboard, and `--create-pr` to
      initiate PR creation. Also update the DescriptionOptions interface in
      description.ts to include these new options.


      The flags should follow the existing patterns in the codebase:

      - Use `.option()` method on the command object

      - Include helpful descriptions for each flag

      - Make --output-file accept a path parameter

      - Make --copy and --create-pr boolean flags
    files:
      - src/rmplan/rmplan.ts
      - src/rmplan/commands/description.ts
    steps:
      - prompt: >
          Update the DescriptionOptions interface in description.ts to include
          three new optional properties:

          outputFile?: string, copy?: boolean, and createPr?: boolean
        done: true
      - prompt: >
          In rmplan.ts, add three new .option() calls to the description command
          definition:

          --output-file with a path parameter, --copy as a boolean flag, and
          --create-pr as a boolean flag.

          Include appropriate descriptions for each flag.
        done: true
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
    files:
      - src/rmplan/commands/description.ts
    steps:
      - prompt: >
          Import the necessary utilities at the top of the file: writeFile and
          mkdir from node:fs/promises,

          write from ../../common/clipboard.js, logSpawn from
          ../../common/process.js, and

          dirname from node:path
        done: true
      - prompt: >
          After the description is generated (after the executorOutput line),
          add a new section to handle

          output flags. Store the generated description in a variable for reuse.
        done: true
      - prompt: >
          Implement file output handling: if options.outputFile is specified,
          ensure the directory exists

          using mkdir with recursive option, then write the description to the
          file using writeFile.

          Log a success message indicating where the file was saved.
        done: true
      - prompt: >
          Implement clipboard handling: if options.copy is true, use the
          clipboard write function

          to copy the description. Log a success message that the description
          was copied to clipboard.
        done: true
      - prompt: >
          Implement PR creation: if options.createPr is true, use logSpawn to
          run

          'gh pr create --body-file -' and pipe the description to stdin. Handle
          the process

          result and log appropriate success or error messages.
        done: true
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
    files:
      - src/rmplan/commands/description.ts
    steps:
      - prompt: >
          Import select, input, and checkbox from @inquirer/prompts at the top
          of the file
        done: true
      - prompt: >
          After handling the direct output flags, add a check to see if no
          output flags were provided.

          If none were provided, show an interactive prompt using checkbox to
          allow multiple selections.
        done: true
      - prompt: >
          Create the checkbox prompt with options: "Copy to clipboard", "Save to
          file", 

          "Create GitHub PR", and "None (just display)". Process the user's
          selections.
        done: true
      - prompt: >
          For each selected action, implement the corresponding handler:

          For "Save to file", use input prompt to ask for the filename, then
          save the file.

          For "Copy to clipboard" and "Create GitHub PR", reuse the logic from
          the direct flag handlers.
        done: true
      - prompt: >
          Add appropriate error handling for the interactive flow, catching
          prompt cancellations

          and handling them gracefully with informative messages.
        done: true
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
    files:
      - src/rmplan/commands/description.test.ts
    steps:
      - prompt: >
          Add a new describe block for "output handling" tests within the
          existing test suite
        done: true
      - prompt: >
          Create a test for the --output-file flag that mocks writeFile and
          mkdir, verifies the file

          is written with the correct content, and checks that the success
          message is logged
        done: true
      - prompt: >
          Create a test for the --copy flag that mocks the clipboard write
          function and verifies

          it's called with the generated description content
        done: true
      - prompt: >
          Create a test for the --create-pr flag that mocks logSpawn, verifies
          the correct gh command

          is executed, and checks that the description is passed via stdin
        done: true
      - prompt: >
          Create a test for interactive mode that mocks the checkbox and input
          prompts,

          simulates user selections, and verifies the corresponding actions are
          taken
        done: true
      - prompt: >
          Add error handling tests: test file write failures with EACCES errors,

          test gh command failures with non-zero exit codes, and verify
          appropriate error messages
        done: true
rmfilter:
  - src/rmplan/commands/review.ts
  - --with-imports
  - --
  - src/rmplan/rmplan.ts
---

Building on the core functionality from Phase 1, this phase adds the user-facing output handling features. We will add CLI flags for direct actions and implement an interactive prompt as a fallback. This will make the command significantly more useful in a real-world development workflow.

**Acceptance Criteria:**
- The `description` command supports `--output-file`, `--copy`, and `--create-pr` flags.
- If no output flags are provided, an interactive prompt is displayed with choices for handling the description.
- The "Copy to clipboard" option works correctly.
- The "Write to file" option saves the description to a user-specified path.
- The "Create PR" option successfully uses the `gh` CLI to create a pull request with the generated description.
- New functionality is covered by tests.
