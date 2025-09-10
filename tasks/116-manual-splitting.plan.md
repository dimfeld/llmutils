---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: manual splitting
goal: To provide users with more control over how plans are split by adding
  manual and interactive methods, in addition to the existing automated
  LLM-based approach.
id: 116
status: pending
priority: medium
dependencies: []
issue: []
docs: []
planGeneratedAt: 2025-09-10T02:39:46.333Z
createdAt: 2025-09-10T02:28:16.765Z
updatedAt: 2025-09-10T02:39:46.334Z
tasks:
  - title: Update CLI Definition for Split Command
    done: false
    description: Update the `rmplan.ts` file to add the new `--auto`, `--tasks
      <specifier>`, and `--select` options to the `split` command definition.
      Ensure these flags are documented and configured to be mutually exclusive.
    steps: []
  - title: Refactor the Split Command Handler
    done: false
    description: Modify the `handleSplitCommand` function in
      `src/rmplan/commands/split.ts`. Move the current LLM-based splitting logic
      into a dedicated function or a conditional block that is only executed
      when the `--auto` flag is present. Structure the command to handle
      different logic paths based on which flag is used.
    steps: []
  - title: Create a Task Specifier Parsing Utility
    done: false
    description: Implement a utility function that parses a string like "1-3,5,7"
      into a sorted and unique array of zero-based numeric indices. This
      function should handle single numbers, ranges, and comma-separated
      combinations, and it should be robust against malformed input.
    steps: []
  - title: Implement Core Manual Splitting Logic
    done: false
    description: >
      Create a new function that orchestrates the manual split process. This
      function will take a source plan and a list of task indices, then perform
      the core operations: generating a new plan ID, creating the child plan
      object, updating the parent plan object by removing tasks and adding a
      dependency, and setting the `container` flag if the parent becomes empty.
    steps: []
  - title: Implement Child Plan Title and Details Generation
    done: false
    description: Develop the logic for populating the new child plan's `title` and
      `details`. If one task is selected, its title becomes the child plan's
      title and its description becomes the details. If multiple tasks are
      selected, their titles and descriptions will be formatted into the
      `details` field as markdown, and an LLM call to Gemini Flash 2.0 will be
      made to generate a concise, new title.
    steps: []
  - title: Add Tests for Manual Splitting
    done: false
    description: Create comprehensive tests for the new functionality. This includes
      unit tests for the task specifier parsing utility and integration tests
      that create a temporary plan, run the split command with the `--tasks`
      flag, and verify the contents of the resulting parent and child plan
      files.
    steps: []
  - title: Implement Interactive Task Selection Prompt
    done: false
    description: In the `handleSplitCommand` function, add the logic for the
      `--select` flag. Use the `checkbox` prompt from `@inquirer/prompts` to
      display the list of tasks from the source plan, allowing the user to
      select which ones to split.
    steps: []
  - title: Integrate Interactive Selection with Core Logic
    done: false
    description: Connect the output of the interactive prompt to the core splitting
      and file-writing logic developed in Phase 1. The array of selected task
      indices from the prompt will be passed to the existing functions to
      perform the split, generate the title, and save the files.
    steps: []
  - title: Finalize Command Argument Handling
    done: false
    description: Implement robust validation to ensure that the `--auto`, `--tasks`,
      and `--select` flags are mutually exclusive. Add logic to provide a
      helpful error message if a user tries to use more than one. Define the
      command's default behavior when no mode flag is specified, which should be
      to guide the user on how to use the command correctly.
    steps: []
changedFiles: []
rmfilter:
  - src/rmplan/commands/split.ts
  - --with-imports
  - --
  - src/rmplan/rmplan.ts
---

# Original Plan Details

Update the src/rmplan/commands/split.ts command:
- The current behavior which uses an LLM to split should be behind an `--auto` flag
- Add a new manual split behavior, using a --tasks flag which will split out specific tasks (by index) into
a new child plan
- Add another flag --select which uses a `checkbox` to interactively select which tasks to split

The --tasks specifier should support ranges like 1-5, and also comma-separation such as 1,3,5 or combining
the two like 1-3,5. Use one-based indexing for task indexes.

## When using the --tasks or --select option:

The parent plan:
- The parent plan has the given tasks removed
- The parent plan should have the new plan's ID in its dependencies array
- If the parent plan has no tasks remaining, set `parentPlan.container = true`

The child plan:

- The child plan should have the current plan as a parent
- The child plan has the tasks' description fields as its details. If there is more than one task, then format them
together using the titles as markdown headers.

If only one task was selected, then the child plan's title should be that task's title. Otherwise use Gemini
Flash 2.0 to generate a new one-line title from the title and descriptions from the selected tasks.

# Processed Plan Details

## Implement Manual and Interactive Plan Splitting

This project will update the `rmplan split` command to support three modes of operation. The existing automated, LLM-based splitting will be placed behind an `--auto` flag. Two new modes will be added: a manual mode using a `--tasks` flag to specify task indices for splitting, and an interactive mode using a `--select` flag which presents a checkbox interface for task selection.

The implementation will involve refactoring the existing command, creating a new utility for parsing task index specifiers (e.g., "1-3,5"), and implementing the core logic for creating a new child plan from selected tasks while correctly updating the parent plan. This includes generating a new title for the child plan, either from a single task's title or by using an LLM for multiple tasks.

### Acceptance Criteria
- The `rmplan split` command must support three mutually exclusive flags: `--auto`, `--tasks`, and `--select`.
- Using `--auto` preserves the existing functionality of splitting a plan into phases using an LLM.
- Using `--tasks` with a valid specifier (e.g., "1-5", "1,3,5", "1-3,5") correctly splits the specified tasks into a new child plan.
- Using `--select` launches an interactive checkbox prompt allowing the user to select tasks to split.
- When splitting manually or interactively:
    - A new child plan file is created with a new numeric ID.
    - The child plan's `parent` field is set to the original plan's ID.
    - The child plan's `details` are correctly formatted from the selected tasks' descriptions.
    - The child plan's `title` is correctly generated based on the number of tasks selected.
    - The parent plan has the selected tasks removed.
    - The parent plan's `dependencies` array includes the new child plan's ID.
    - If the parent plan has no tasks remaining, its `container` property is set to `true`.
- The command provides clear feedback to the user about the created and modified plan files.
- The implementation includes robust unit and integration tests for the new functionality.

---

## Phase 1: Refactor Command and Implement Manual Splitting

Tasks:
- Update CLI Definition for Split Command
- Refactor the Split Command Handler
- Create a Task Specifier Parsing Utility
- Implement Core Manual Splitting Logic
- Implement Child Plan Title and Details Generation
- Add Tests for Manual Splitting

This phase lays the foundation for all new splitting functionality. We will first update the command-line interface in `rmplan.ts` to recognize the new flags. Then, the `split.ts` command handler will be refactored to isolate the existing LLM-based logic and create a new path for manual splitting. The core of this phase is building the logic to parse task indices, create a new child plan, update the parent plan, and handle title generation for the new plan.

### Acceptance Criteria
- The `rmplan split` command accepts `--auto`, `--tasks`, and `--select` flags.
- The existing LLM-based splitting logic is executed only when the `--auto` flag is provided.
- A new utility function correctly parses task specifier strings (e.g., "1-3,5") into an array of zero-based indices.
- Using the `--tasks` flag successfully creates a new child plan and updates the parent plan as per the project specifications.
- The new child plan's title is the source task's title if only one task is split.
- An LLM is used to generate a new title if multiple tasks are split.
- Unit tests for the task specifier parser are implemented and passing.
- Integration tests for the manual split functionality are implemented and passing.

---

## Phase 2: Implement Interactive Splitting and Finalize

Tasks:
- Implement Interactive Task Selection Prompt
- Integrate Interactive Selection with Core Logic
- Finalize Command Argument Handling

This phase introduces the user-friendly interactive splitting feature. It will leverage the `@inquirer/prompts` library, which is already a dependency, to present a checkbox list of tasks from the source plan. The core splitting logic developed in Phase 1 will be reused to process the user's selection. Finally, the command's argument handling will be polished to ensure correct behavior when flags are combined or omitted.

### Acceptance Criteria
- Running `rmplan split` with the `--select` flag displays an interactive checkbox prompt listing all tasks from the source plan.
- After the user selects tasks and confirms, the plan is split correctly using the logic from Phase 1.
- The command exits gracefully if the user cancels the interactive prompt.
- The command shows a clear error message if more than one of `--auto`, `--tasks`, or `--select` is used.
- If no mode flag is provided, the command displays help text or an informative error message prompting the user to choose a mode.
