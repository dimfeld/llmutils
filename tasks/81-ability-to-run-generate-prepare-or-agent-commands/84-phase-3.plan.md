---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Ability to run, generate, prepare, or agent commands on the next ready
  dependency of a plan. - Final Polish and Documentation
goal: To enhance the user experience with improved error handling and to provide
  clear documentation for the new feature.
id: 84
status: done
priority: medium
dependencies:
  - 83
parent: 81
planGeneratedAt: 2025-07-29T23:21:36.332Z
promptsGeneratedAt: 2025-07-31T18:25:01.862Z
createdAt: 2025-07-29T19:19:03.441Z
updatedAt: 2025-07-31T19:19:30.403Z
tasks:
  - title: Enhance Error Handling and User Feedback
    description: >
      Review all code paths in the --next-ready implementation to ensure
      potential failures are handled gracefully with descriptive error messages.
      Focus on improving user guidance when errors occur, such as when a parent
      plan is not found, no ready dependencies exist, or invalid plan IDs are
      provided. The error messages should help users understand what went wrong
      and suggest next steps.


      Key areas to enhance:

      - "Plan not found" errors should suggest checking the plan ID or using
      'rmplan list' to see available plans

      - "No ready dependencies" messages should explain why (e.g., all
      dependencies are done, or pending dependencies have incomplete
      prerequisites)

      - Invalid input errors should show the expected format

      - Directory access errors should suggest checking the path or permissions


      The existing error handling in find_next_dependency.ts provides a good
      foundation with colored output using chalk. Build upon this pattern to
      ensure consistency across all commands.
    files:
      - src/rmplan/commands/find_next_dependency.ts
      - src/rmplan/commands/find_next_dependency.test.ts
      - src/rmplan/commands/agent.ts
      - src/rmplan/commands/generate.ts
      - src/rmplan/commands/prepare.ts
      - src/rmplan/commands/show.ts
    steps:
      - prompt: >
          Create comprehensive tests in find_next_dependency.test.ts that verify
          all error message scenarios, including invalid plan IDs, missing
          directories, and cases where no dependencies are ready. Ensure tests
          check for specific, helpful error message content.
        done: true
      - prompt: >
          Enhance error messages in find_next_dependency.ts to be more
          descriptive and actionable. For "Plan not found" errors, suggest using
          'rmplan list' or checking the plan ID. For "No ready dependencies"
          errors, explain the specific reason (all done, blocked by incomplete
          dependencies, etc.).
        done: true
      - prompt: >
          Review error handling in the agent, generate, and prepare commands
          where --next-ready is used. Ensure they properly display the error
          messages from findNextReadyDependency and add any command-specific
          guidance where appropriate.
        done: true
      - prompt: >
          Add error handling for --next-ready to the show command if it's
          missing. Ensure consistent error message formatting across all
          commands using chalk colors (yellow for warnings, red for errors).
        done: true
  - title: Add Logging for Dependency Selection
    description: >
      Implement comprehensive debug logging throughout the dependency discovery
      process to provide visibility into how the next ready dependency is
      selected. This logging should help users and developers understand the
      decision-making process when --debug is enabled.


      The logging should cover:

      - Initial parent plan lookup and validation

      - Breadth-first search traversal showing each plan examined

      - Dependency status checks for each candidate

      - Filtering decisions (why plans are excluded - status, priority, missing
      tasks)

      - Sorting logic showing how candidates are prioritized

      - Final selection with clear reasoning


      Use the existing debugLog function from logging.ts and follow the pattern
      of prefixing messages with [find_next_dependency] for easy filtering. The
      dependency_traversal.ts file already has some logging that can serve as a
      reference pattern.
    files:
      - src/rmplan/commands/find_next_dependency.ts
      - src/rmplan/commands/find_next_dependency.test.ts
    steps:
      - prompt: >
          Add detailed logging to the BFS traversal section in
          find_next_dependency.ts, logging each plan ID being examined, whether
          it's being added to dependencies, and if it's skipped due to circular
          reference detection.
        done: true
      - prompt: >
          Enhance logging in the candidate filtering section to show why each
          plan is included or excluded. Log when plans are filtered out due to
          status (done/cancelled), priority (maybe), or missing tasks. Include
          plan IDs and titles for context.
        done: true
      - prompt: >
          Add logging to the sorting logic that shows the sort criteria being
          applied (status, priority, ID) and the final sorted order. Log the
          selection of the final candidate with a clear summary of why it was
          chosen.
        done: true
      - prompt: >
          Create tests that verify the logging output contains expected
          information for various scenarios (successful selection, no
          dependencies found, circular dependencies handled). Use debug mode in
          tests to capture and verify log messages.
        done: true
  - title: Update Command-Line Help Text
    description: >
      Review and enhance the command-line help documentation for all commands
      that support the --next-ready flag. While the basic help text already
      exists in rmplan.ts, ensure it clearly explains the flag's purpose and
      behavior across all commands.


      The help text should:

      - Clearly explain that --next-ready finds the next actionable dependency
      of a parent plan

      - Indicate that it accepts either a plan ID or file path

      - Be consistent across generate, prepare, agent/run, and show commands

      - Include any command-specific behavior differences


      Also verify that the flag is properly documented in the command
      descriptions and that the help output is formatted consistently with other
      options.
    files:
      - src/rmplan/rmplan.ts
    steps:
      - prompt: >
          Review the existing --next-ready option descriptions in rmplan.ts for
          all commands. Ensure each description clearly explains that the flag
          finds and operates on the next ready dependency of the specified
          parent plan, accepting either a plan ID or file path.
        done: true
      - prompt: >
          Update any command descriptions that mention --next-ready to ensure
          they accurately reflect the new capability. Verify the help text
          formatting is consistent across all commands and follows the project's
          documentation style.
        done: true
  - title: Update Project Documentation
    description: >
      Create comprehensive documentation for the new --next-ready feature in the
      project README. This documentation should explain the problem it solves,
      how it works, and provide clear usage examples for each command that
      supports it.


      The documentation should include:

      - A new section titled "Dependency-Based Execution" or similar

      - Explanation of the use case: working with multi-phase plans where you
      want to automatically find the next task to work on

      - How the dependency discovery works (breadth-first search, readiness
      criteria)

      - Usage examples for each command (generate, prepare, agent/run, show)

      - Integration with existing workflow patterns

      - Tips for organizing plans with dependencies to work well with this
      feature


      The README already has detailed examples for other features that can serve
      as a formatting guide. Place this new section after the existing command
      documentation but before the configuration sections.
    files:
      - docs/next-ready-feature.md
      - README.md
    steps:
      - prompt: >
          Create a new file docs/next-ready-feature.md that contains the full
          documentation for the --next-ready feature. Include an introduction
          explaining the problem it solves, how it works internally, readiness
          criteria, and comprehensive examples for each command that supports
          it.
        done: true
      - prompt: >
          Add a new section to README.md titled "Working with Plan Dependencies"
          after the existing rmplan usage examples. Include a brief introduction
          and overview, then incorporate the key content from
          docs/next-ready-feature.md, focusing on practical usage examples and
          workflow integration.
        done: true
      - prompt: >
          Update the main rmplan feature list in README.md to mention the new
          dependency-based execution capability. Add --next-ready examples to
          the existing command examples where appropriate to show how it
          integrates with the normal workflow.
        done: true
changedFiles:
  - README.md
  - docs/next-ready-feature.md
  - src/rmfilter/additional_docs.test.ts
  - src/rmplan/cleanup.test.ts
  - src/rmplan/commands/agent.test.ts
  - src/rmplan/commands/agent.ts
  - src/rmplan/commands/cli_integration.test.ts
  - src/rmplan/commands/cli_parsing.test.ts
  - src/rmplan/commands/find_next_dependency.test.ts
  - src/rmplan/commands/find_next_dependency.ts
  - src/rmplan/commands/generate.test.ts
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/integration.test.ts
  - src/rmplan/commands/next_ready_integration.test.ts
  - src/rmplan/commands/prepare.test.ts
  - src/rmplan/commands/prepare.ts
  - src/rmplan/commands/show.ts
  - src/rmplan/dependency_traversal.test.ts
  - src/rmplan/dependency_traversal.ts
  - src/rmplan/executors/claude_code/agent_generator.test.ts
  - src/rmplan/executors/claude_code.ts
  - src/rmplan/parent_completion.test.ts
  - src/rmplan/plans/plan_state_utils.test.ts
  - src/rmplan/plans/plan_state_utils.ts
  - src/rmplan/plans.ts
  - src/rmplan/rmplan.ts
  - src/rmpr/modes/hybrid_context.test.ts
rmfilter:
  - src/rmplan
---

This final phase focuses on making the feature robust and easy to use. It involves refining error messages, adding logging for better visibility, and updating all user-facing documentation to explain the new capability.

### Acceptance Criteria
- Error messages are clear and helpful when a plan is not found or no ready dependency exists.
- Logging provides insight into which dependency was selected.
- The command-line `--help` text is updated for the modified commands.
- The project's `README.md` or other primary documentation includes a section on the new feature with usage examples.
