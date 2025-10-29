---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Ability to run, generate, prepare, or agent commands on the next ready
  dependency of a plan. - Integrate Dependency Discovery into CLI Commands
goal: To expose the new dependency discovery logic through a command-line flag
  for the `generate`, `prepare`, and `agent` commands.
id: 83
uuid: 5b0aeb44-6c70-4574-8290-07ccacb3f2b6
status: done
priority: high
dependencies:
  - 82
parent: 81
references:
  "81": 01a26e46-236d-45c3-a53d-4f70c65fc91a
  "82": c5a4a763-d7cf-4278-9a14-9d75119fdaeb
planGeneratedAt: 2025-07-29T23:21:36.332Z
promptsGeneratedAt: 2025-07-31T07:17:59.983Z
createdAt: 2025-07-29T19:19:03.441Z
updatedAt: 2025-10-27T08:39:04.324Z
tasks:
  - title: Add New CLI Flag to Command Parser
    done: true
    description: >
      Modify the CLI argument parsing configuration in src/rmplan/rmplan.ts to
      add a new flag, --next-ready, to the generate, prepare, and agent
      commands. This flag will accept a parent plan ID (either numeric or file
      path) and signal that the command should find and operate on the next
      ready dependency of that plan instead of the plan itself. The flag follows
      the existing pattern of --next and --current flags in the prepare command,
      but with the specific behavior of using the dependency discovery logic
      from Phase 1.
  - title: Modify `generate` Command to Use New Logic
    done: true
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
  - title: Modify `prepare` Command to Use New Logic
    done: true
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
  - title: Modify `agent` Command to Use New Logic
    done: true
    description: >
      Update the agent command's implementation in src/rmplan/commands/agent.ts
      to handle the --next-ready flag. Since the agent command has more complex
      initialization including workspace management, the implementation needs to
      resolve the target plan early in the execution flow. The --next-ready
      logic should be placed after basic validation but before workspace
      operations, ensuring that workspace creation uses the correct target plan.
      The command should maintain full compatibility with existing options like
      --workspace, --auto-workspace, and execution-related flags.
  - title: Add End-to-End CLI Tests
    done: true
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
changedFiles:
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
  - src/rmplan/plans/plan_state_utils.test.ts
  - src/rmplan/plans/plan_state_utils.ts
  - src/rmplan/rmplan.ts
rmfilter:
  - src/rmplan
---

This phase connects the core logic from Phase 1 to the user-facing CLI. A new flag will be added to the relevant commands. When this flag is present, the command's execution target will be determined by the dependency discovery logic instead of being the plan provided directly as an argument.

### Acceptance Criteria
- A new flag (e.g., `--next-ready`) is available on the `generate`, `prepare`, and `agent` commands.
- Using the flag with a parent plan correctly redirects the command to execute on the next ready dependency.
- The commands exit gracefully with a message if no ready dependency is found.
- End-to-end tests confirm the correct behavior for all three commands.
