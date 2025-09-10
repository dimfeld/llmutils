---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: manual splitting
goal: To provide users with more control over how plans are split by adding
  manual and interactive methods, in addition to the existing automated
  LLM-based approach.
id: 116
status: in_progress
priority: medium
dependencies: []
issue: []
docs: []
planGeneratedAt: 2025-09-10T02:39:46.333Z
promptsGeneratedAt: 2025-09-10T03:13:45.489Z
createdAt: 2025-09-10T02:28:16.765Z
updatedAt: 2025-09-10T03:13:46.019Z
tasks:
  - title: Update CLI Definition for Split Command
    done: false
    description: >
      Update the `rmplan.ts` file to add the new `--auto`, `--tasks
      <specifier>`, and `--select` options to the `split` command definition.
      This involves modifying the existing split command at lines 443-450 to
      include three new mutually exclusive options. Follow the patterns used by
      other commands in the file for option definitions and help text. The
      `--auto` flag should be a boolean, `--tasks` should accept a string
      specifier, and `--select` should be a boolean for interactive selection.
    files:
      - src/rmplan/rmplan.ts
    steps:
      - prompt: >
          Add the new command line options to the split command definition in
          rmplan.ts. Add `--auto` as a boolean flag for the existing LLM-based
          behavior, `--tasks <specifier>` to accept a task index specifier
          string, and `--select` for interactive task selection. Include
          appropriate help text explaining each option and follow the existing
          patterns used by other commands in the file.
        done: false
  - title: Refactor the Split Command Handler
    done: false
    description: >
      Modify the `handleSplitCommand` function in `src/rmplan/commands/split.ts`
      to support multiple splitting modes. The current LLM-based logic should be
      moved into a conditional block that only executes when the `--auto` flag
      is present. Add branching logic to handle different modes based on which
      flag is used, and implement validation to ensure flags are mutually
      exclusive. This establishes the foundation for adding manual and
      interactive splitting functionality.
    files:
      - src/rmplan/commands/split.ts
    steps:
      - prompt: >
          Refactor the existing handleSplitCommand function to move all current
          LLM-based splitting logic into a conditional block that only executes
          when options.auto is true. Add branching logic to handle different
          splitting modes based on which flag is present.
        done: false
      - prompt: >
          Add validation logic to ensure that --auto, --tasks, and --select
          flags are mutually exclusive. Throw appropriate error messages if more
          than one flag is specified or if no mode flag is provided.
        done: false
  - title: Create a Task Specifier Parsing Utility
    done: false
    description: >
      Implement a utility function that parses task index specifier strings like
      "1-3,5,7" into a sorted array of unique zero-based indices. The parser
      should handle single numbers, ranges (e.g., "1-5"), and comma-separated
      combinations. It should validate input format, handle edge cases, and
      provide clear error messages for malformed input. Use one-based indexing
      in the input but return zero-based indices for internal use.
    files:
      - src/rmplan/utils/task_specifier_parser.ts
      - src/rmplan/utils/task_specifier_parser.test.ts
    steps:
      - prompt: >
          Create a new utility file with a parseTaskSpecifier function that
          takes a string like "1-3,5,7" and returns a sorted array of unique
          zero-based indices. Handle single numbers, ranges, and comma-separated
          combinations. Include comprehensive error handling for malformed
          input.
        done: false
      - prompt: >
          Write comprehensive unit tests for the parseTaskSpecifier function
          covering various input formats, edge cases, error conditions, and
          malformed input scenarios. Test single numbers, ranges, combinations,
          and invalid inputs.
        done: false
  - title: Implement Core Manual Splitting Logic
    done: false
    description: >
      Create the core functionality for manual plan splitting that takes a
      source plan and array of task indices, then generates a new child plan and
      updates the parent plan. This includes generating a new sequential plan ID
      using `generateNumericPlanId`, creating the child plan object with proper
      parent reference, removing selected tasks from the parent plan, adding the
      child plan ID to parent dependencies, and setting the `container` flag if
      no tasks remain in the parent.
    files:
      - src/rmplan/commands/split.ts
      - src/rmplan/commands/split.test.ts
    steps:
      - prompt: >
          Create comprehensive integration tests for manual splitting
          functionality. Set up test fixtures with temporary plan files and test
          the complete workflow: parsing task specifiers, splitting plans,
          verifying parent and child plan contents, and ensuring proper ID
          generation and file relationships.
        done: false
      - prompt: >
          Implement the core manual splitting logic as a new function that takes
          a plan and array of task indices. Generate a new plan ID, create a
          child plan with selected tasks and proper parent reference, update the
          parent plan by removing tasks and adding dependency, and set container
          flag if parent becomes empty.
        done: false
      - prompt: >
          Add the file saving functionality that writes both the updated parent
          plan and new child plan to disk using the existing writePlanFile
          utility. Ensure proper filename generation using the pattern from the
          add command.
        done: false
  - title: Implement Child Plan Title and Details Generation
    done: false
    description: >
      Develop logic for generating the child plan's title and details based on
      the selected tasks. For a single selected task, use the task's title as
      the child plan title and its description as the details. For multiple
      tasks, format their titles and descriptions as markdown in the details
      field and use an LLM call to Gemini Flash 2.0 to generate a concise title.
      Follow existing patterns for LLM integration using createModel and
      generateText from the ai package.
    files:
      - src/rmplan/commands/split.ts
      - src/rmplan/commands/split.test.ts
    steps:
      - prompt: >
          Implement the logic for single task scenarios where the child plan's
          title comes directly from the selected task's title and the details
          come from the task's description. Add this to the manual splitting
          function.
        done: false
      - prompt: >
          For multiple task scenarios, implement markdown formatting that
          combines all selected task titles and descriptions into the child
          plan's details field, using task titles as section headers.
        done: false
      - prompt: >
          Add LLM integration for generating concise titles when multiple tasks
          are selected. Use createModel with 'google/gemini-2.0-flash' and
          generateText to create a one-line title based on the combined task
          information. Include proper error handling for LLM failures.
        done: false
  - title: Add Tests for Manual Splitting
    done: false
    description: >
      Expand the test coverage for manual splitting functionality with
      comprehensive integration tests that create temporary plans, execute the
      split command with the --tasks flag, and verify all aspects of the
      splitting behavior. Include tests for edge cases, error conditions,
      filename generation, parent-child relationships, and container flag
      handling.
    files:
      - src/rmplan/commands/split.test.ts
    steps:
      - prompt: >
          Add integration tests that create temporary plan files with multiple
          tasks, run the split command with --tasks flag using various specifier
          formats, and verify the resulting parent and child plan files have
          correct content, relationships, and IDs.
        done: false
      - prompt: >
          Add tests for edge cases including splitting all tasks (container
          flag), splitting single tasks, invalid task indices, empty specifiers,
          and error conditions. Verify appropriate error messages are shown for
          invalid inputs.
        done: false
  - title: Implement Interactive Task Selection Prompt
    done: false
    description: >
      Add interactive task selection functionality using the checkbox prompt
      from @inquirer/prompts. Display all tasks from the source plan in a
      checkbox list, allowing users to select which tasks to split. Follow
      existing patterns from issue_utils.ts for checkbox usage, including proper
      message formatting, choice creation, and cancellation handling. The prompt
      should show task titles and provide keyboard shortcuts.
    files:
      - src/rmplan/commands/split.ts
    steps:
      - prompt: >
          Import the checkbox function from @inquirer/prompts and implement the
          interactive task selection logic. Create choices array from the plan's
          tasks, showing task titles with appropriate formatting. Include
          keyboard shortcuts and make the selection optional to allow
          cancellation.
        done: false
      - prompt: >
          Add proper cancellation handling for the interactive prompt. If the
          user cancels or selects no tasks, exit gracefully with an appropriate
          message rather than proceeding with an empty selection.
        done: false
  - title: Integrate Interactive Selection with Core Logic
    done: false
    description: >
      Connect the interactive prompt output with the existing manual splitting
      logic developed in earlier tasks. The checkbox prompt returns an array of
      selected indices that should be passed to the manual splitting functions.
      Ensure proper error handling throughout the integration and maintain
      consistency with the manual --tasks flag behavior.
    files:
      - src/rmplan/commands/split.ts
    steps:
      - prompt: >
          Integrate the checkbox prompt results with the manual splitting logic
          by converting the selected task indices from the interactive prompt
          and passing them to the existing splitting functions. Ensure the flow
          matches the --tasks flag behavior.
        done: false
      - prompt: >
          Add comprehensive error handling for the integration between
          interactive selection and manual splitting, including validation of
          selected indices and proper error messages for any failures during the
          splitting process.
        done: false
  - title: Finalize Command Argument Handling
    done: false
    description: >
      Complete the command implementation by adding robust argument validation,
      comprehensive error messages, and help text. Ensure the three flags
      (--auto, --tasks, --select) are properly validated as mutually exclusive.
      Define the default behavior when no mode flag is specified to guide users
      on proper usage. Add comprehensive tests for all argument validation
      scenarios.
    files:
      - src/rmplan/commands/split.ts
      - src/rmplan/commands/split.test.ts
    steps:
      - prompt: >
          Add comprehensive argument validation that checks for mutually
          exclusive flags and provides clear error messages. When no mode flag
          is specified, display helpful guidance on how to use the split command
          with the available options.
        done: false
      - prompt: >
          Add tests for all argument validation scenarios including mutually
          exclusive flag combinations, missing flags, and verify that
          appropriate error messages are displayed. Test the help text
          functionality when no mode is specified.
        done: false
      - prompt: >
          Add final integration tests that verify the complete command works
          end-to-end for all three modes (auto, tasks, select) and confirm that
          user feedback messages are appropriate and informative throughout the
          splitting process.
        done: false
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
