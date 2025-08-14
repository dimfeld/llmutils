---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Change description command
goal: To create a new `rmplan description` command that, similar to the `review`
  command, gathers context from a plan and code changes, but uses it to generate
  a comprehensive pull request description.
id: 106
status: in_progress
priority: medium
container: true
dependencies:
  - 107
  - 108
createdAt: 2025-08-14T00:55:08.903Z
updatedAt: 2025-08-14T01:47:04.330Z
tasks: []
rmfilter:
  - src/rmplan/commands/review.ts
  - --with-imports
  - --
  - src/rmplan/rmplan.ts
---

# Original Plan Details

This works a lot like the existing review command, but with a different prompt that asks it to generate a PR description for work done on a plan.

Create a new function that contains the relevant context gathering used by the review command which can also be used
here.

The output should include details like:
- What was implemented
- What existing functionality was changed
- What might have been changed to implement this plan, but was not
- A description of how the changes work with each other and how it integrates with the rest of the system
- optional diagrams in Mermaid format if helpful to understand the changes
- Potential future improvements

Unlike the review command, we don't need an incremental mode, issue detection, or a "fix" option since it's just generating text.

When done, we should ask to copy to the clipboard and/or create the PR using the Github CLI. Also have the option to
write to a file.

# Processed Plan Details

## Implement a `description` command to generate PR descriptions from plan context

This project introduces a new `description` command to streamline the process of writing pull request descriptions. The command will leverage the existing context-gathering mechanisms of the `review` command by refactoring this logic into a shared utility.

The new command will:
1.  Accept a plan file path or ID as input.
2.  Gather context including the plan's details, tasks, hierarchy (parent/child plans), and a diff of code changes.
3.  Use a specialized prompt to instruct an LLM to generate a detailed PR description.
4.  The generated description will cover what was implemented, what changed, what was intentionally not changed, how the changes integrate, optional Mermaid diagrams, and potential future work.
5.  Provide interactive options to the user for handling the output, such as copying to the clipboard, saving to a file, or creating a PR directly using the GitHub CLI.

Unlike the `review` command, this new command will not support incremental reviews, issue detection, or autofixing, as its sole purpose is text generation.

**Acceptance Criteria:**
- A new `rmplan description <plan>` command is available in the CLI.
- The context-gathering logic from the `review` command is successfully refactored into a shared function without breaking existing `review` functionality.
- The `description` command generates a PR description and prints it to the console.
- The user is prompted with options to copy the description, save it to a file, or create a PR.
- The command is documented and has corresponding tests.

**Technical Considerations:**
- The refactoring of context-gathering logic from `src/rmplan/commands/review.ts` is a critical first step. This shared utility will be used by both `review` and the new `description` command.
- A new prompt will be created, likely in `src/rmplan/executors/claude_code/agent_prompts.ts`, specifically for generating PR descriptions.
- The `@inquirer/prompts` library will be used for interactive output handling.
- The GitHub CLI (`gh`) will be invoked as a subprocess for the "Create PR" option.
