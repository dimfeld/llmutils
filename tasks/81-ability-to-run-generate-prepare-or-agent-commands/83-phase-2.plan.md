---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Ability to run, generate, prepare, or agent commands on the next ready
  dependency of a plan. - Integrate Dependency Discovery into CLI Commands
goal: To expose the new dependency discovery logic through a command-line flag
  for the `generate`, `prepare`, and `agent` commands.
id: 83
status: in_progress
priority: high
dependencies:
  - 82
parent: 81
planGeneratedAt: 2025-07-29T23:21:36.332Z
promptsGeneratedAt: 2025-07-31T07:17:59.983Z
createdAt: 2025-07-29T19:19:03.441Z
updatedAt: 2025-07-31T07:18:00.293Z
tasks:
  - title: Add New CLI Flag to Command Parser
    description: >
      Modify the CLI argument parsing configuration in src/rmplan/rmplan.ts to
      add a new flag, --next-ready, to the generate, prepare, and agent
      commands. This flag will accept a parent plan ID (either numeric or file
      path) and signal that the command should find and operate on the next
      ready dependency of that plan instead of the plan itself. The flag follows
      the existing pattern of --next and --current flags in the prepare command,
      but with the specific behavior of using the dependency discovery logic
      from Phase 1.
    files:
      - src/rmplan/rmplan.ts
    steps:
      - prompt: >
          Add a new option --next-ready <planId> to the generate command
          definition. The option should accept a plan ID or file path as its
          value and have a description explaining that it finds and operates on
          the next ready dependency of the specified parent plan.
        done: false
      - prompt: >
          Add the same --next-ready <planId> option to the prepare command
          definition, maintaining consistency with the generate command's
          implementation.
        done: false
      - prompt: >
          Add the --next-ready <planId> option to both the agent and run
          commands (since run is an alias for agent). Use the createAgentCommand
          function to add this option so it applies to both commands.
        done: false
  - title: Modify `generate` Command to Use New Logic
    description: >
      Update the generate command's implementation in
      src/rmplan/commands/generate.ts to handle the --next-ready flag. When this
      flag is present, the command will use the findNextReadyDependency function
      from src/rmplan/commands/find_next_dependency.ts to locate the appropriate
      dependency plan. If a ready dependency is found, the command proceeds with
      generation for that plan. If no ready dependency is found, the command
      exits gracefully with an informative message. The implementation should
      resolve the parent plan ID (supporting both numeric IDs and file paths)
      before calling the dependency discovery function.
    files:
      - src/rmplan/commands/generate.ts
      - src/rmplan/commands/generate.test.ts
    steps:
      - prompt: >
          Create a new test file or add to the existing generate.test.ts to test
          the --next-ready flag behavior. Include tests for: finding a ready
          dependency successfully, handling when no ready dependencies exist,
          and handling invalid parent plan IDs.
        done: false
      - prompt: >
          In handleGenerateCommand, add logic at the beginning to check if
          options.nextReady is present. If it is, resolve the parent plan file
          using resolvePlanFile, then call findNextReadyDependency with the
          parent plan's ID and the tasks directory.
        done: false
      - prompt: >
          Handle the result from findNextReadyDependency. If a plan is found,
          update the planArg to use the found plan's filename and log a message
          indicating which dependency was found. If no plan is found, log the
          message from the result and return early from the function.
        done: false
      - prompt: >
          Ensure the existing flow continues normally after the --next-ready
          logic, so that if a dependency is found, it's processed as if it was
          passed directly as the plan argument.
        done: false
  - title: Modify `prepare` Command to Use New Logic
    description: >
      Update the prepare command's implementation in
      src/rmplan/commands/prepare.ts to handle the --next-ready flag. The
      implementation follows a similar pattern to the generate command but
      integrates with the existing --next and --current flag logic. The command
      should check for --next-ready first, resolve the parent plan, find its
      next ready dependency, and then proceed with the normal prepare flow for
      the found dependency. The implementation must maintain compatibility with
      existing options and handle edge cases consistently with the other dynamic
      plan selection options.
    files:
      - src/rmplan/commands/prepare.ts
      - src/rmplan/commands/prepare.test.ts
    steps:
      - prompt: >
          Add tests to prepare.test.ts for the --next-ready flag, following the
          existing test patterns. Include scenarios for successful dependency
          discovery, no ready dependencies, and error cases.
        done: false
      - prompt: >
          In handlePrepareCommand, add a new conditional block to handle
          options.nextReady before the existing options.next || options.current
          check. Resolve the parent plan file, read the plan to get its ID, and
          call findNextReadyDependency.
        done: false
      - prompt: >
          Process the result from findNextReadyDependency similar to how --next
          and --current are handled. If a plan is found, set phaseYamlFile to
          the found plan's filename and log a success message. If not found, log
          an appropriate message and return.
        done: false
      - prompt: >
          Ensure the --next-ready logic integrates cleanly with the existing
          flow, particularly with options like --use-yaml and the rmfilter
          argument handling.
        done: false
  - title: Modify `agent` Command to Use New Logic
    description: >
      Update the agent command's implementation in src/rmplan/commands/agent.ts
      to handle the --next-ready flag. Since the agent command has more complex
      initialization including workspace management, the implementation needs to
      resolve the target plan early in the execution flow. The --next-ready
      logic should be placed after basic validation but before workspace
      operations, ensuring that workspace creation uses the correct target plan.
      The command should maintain full compatibility with existing options like
      --workspace, --auto-workspace, and execution-related flags.
    files:
      - src/rmplan/commands/agent.ts
      - src/rmplan/commands/agent.test.ts
    steps:
      - prompt: >
          Add comprehensive tests to agent.test.ts for the --next-ready flag.
          Include tests that verify workspace operations work correctly with the
          redirected plan, and that all existing agent options remain
          compatible.
        done: false
      - prompt: >
          In handleAgentCommand, add validation to ensure that when --next-ready
          is used, a plan file argument is provided (it becomes the parent plan
          ID). Throw an appropriate error if missing.
        done: false
      - prompt: >
          In rmplanAgent function, add logic after resolvePlanFile but before
          any workspace operations to check for options.nextReady. If present,
          load the parent plan, call findNextReadyDependency, and update
          currentPlanFile to the found dependency's filename.
        done: false
      - prompt: >
          Handle the case where no ready dependency is found by logging an
          informative message, closing any open log file, and returning early.
          Ensure the message is consistent with the other commands.
        done: false
      - prompt: >
          Verify that all subsequent operations in the agent command (workspace
          creation, executor setup, plan execution) use the updated
          currentPlanFile value when --next-ready redirects to a dependency.
        done: false
  - title: Add End-to-End CLI Tests
    description: >
      Create comprehensive end-to-end tests that execute the actual CLI commands
      with the new --next-ready flag. These tests will set up temporary plan
      files with various dependency configurations, run the commands through the
      actual CLI interface, and verify correct behavior. The tests should cover
      successful scenarios where ready dependencies are found, edge cases like
      circular dependencies or missing dependencies, and error scenarios with
      invalid inputs. Tests should verify not just the command execution but
      also the messages displayed to users and the final state of plan files
      where applicable.
    files:
      - src/rmplan/commands/cli_integration.test.ts
      - src/rmplan/commands/integration.test.ts
    steps:
      - prompt: >
          Create a new test file cli_integration.test.ts focused on testing the
          --next-ready flag across all three commands. Set up a test harness
          that can execute the actual rmplan CLI commands and capture their
          output.
        done: false
      - prompt: >
          Implement test cases for the generate command with --next-ready.
          Create plan hierarchies with various states, execute rmplan generate
          --next-ready [parentId], and verify it generates for the correct
          dependency plan.
        done: false
      - prompt: >
          Implement test cases for the prepare command with --next-ready. Test
          scenarios including plans with in-progress dependencies (which should
          be selected first), multiple ready dependencies (to verify priority
          ordering), and plans with no ready dependencies.
        done: false
      - prompt: >
          Implement test cases for the agent command with --next-ready. Since
          agent modifies plan states, verify that it correctly executes on the
          dependency plan and that plan states are updated appropriately.
        done: false
      - prompt: >
          Add edge case tests including: using --next-ready with non-existent
          parent plans, plans that have no dependencies at all, and plans where
          all dependencies are already completed. Verify appropriate error
          messages in each case.
        done: false
      - prompt: >
          Add a test that verifies the --next-ready flag works correctly with
          other options like --direct for generate/prepare commands, and
          --dry-run for the agent command, ensuring proper option composition.
        done: false
rmfilter:
  - src/rmplan
---

This phase connects the core logic from Phase 1 to the user-facing CLI. A new flag will be added to the relevant commands. When this flag is present, the command's execution target will be determined by the dependency discovery logic instead of being the plan provided directly as an argument.

### Acceptance Criteria
- A new flag (e.g., `--next-ready`) is available on the `generate`, `prepare`, and `agent` commands.
- Using the flag with a parent plan correctly redirects the command to execute on the next ready dependency.
- The commands exit gracefully with a message if no ready dependency is found.
- End-to-end tests confirm the correct behavior for all three commands.
