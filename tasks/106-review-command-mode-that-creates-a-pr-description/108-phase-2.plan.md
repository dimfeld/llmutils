---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Change description command - Interactive Output Handling and CLI Integration
goal: To enhance the `description` command with interactive options for handling
  the generated output, allowing users to easily copy it, save it, or create a
  pull request.
id: 108
status: pending
priority: medium
dependencies:
  - 107
parent: 106
planGeneratedAt: 2025-08-14T01:21:36.414Z
createdAt: 2025-08-14T00:55:08.903Z
updatedAt: 2025-08-14T01:21:36.414Z
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
    description: "Extend the `description` command definition in `rmplan.ts` to
      include flags for non-interactive output handling: `--output-file <path>`
      to save to a file, `--copy` to copy to the clipboard, and `--create-pr` to
      initiate PR creation."
    steps: []
  - title: Implement Direct Output Actions
    description: In `handleDescriptionCommand`, add logic to process the new CLI
      flags. If a flag is present, perform the corresponding action (write to
      file, copy to clipboard, or invoke `gh pr create`) immediately after the
      description is generated.
    steps: []
  - title: Implement Interactive Output Prompt
    description: If no output-related flags are provided, use the
      `@inquirer/prompts` library to display a checklist or series of questions
      to the user. The prompt will offer choices to copy to clipboard, write to
      a file, or create a PR, and the command will act based on the user's
      selection.
    steps: []
  - title: Add Tests for Output Handling
    description: Create or update tests for the `description` command to verify the
      behavior of the new output flags and the interactive prompt. Mock external
      dependencies like the clipboard, filesystem, and the `gh` CLI subprocess
      to test the command's logic in isolation.
    steps: []
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
