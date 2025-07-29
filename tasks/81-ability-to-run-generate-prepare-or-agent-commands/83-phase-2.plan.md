---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Ability to run, generate, prepare, or agent commands on the next ready
  dependency of a plan. - Integrate Dependency Discovery into CLI Commands
goal: To expose the new dependency discovery logic through a command-line flag
  for the `generate`, `prepare`, and `agent` commands.
id: 83
status: pending
priority: high
dependencies:
  - 82
parent: 81
planGeneratedAt: 2025-07-29T23:21:36.332Z
createdAt: 2025-07-29T19:19:03.441Z
updatedAt: 2025-07-29T23:21:36.332Z
tasks:
  - title: Add New CLI Flag to Command Parser
    description: Modify the CLI argument parsing configuration to add a new flag,
      such as `--next-ready`, to the `generate`, `prepare`, and `agent`
      commands. This flag will signal the new execution behavior.
    steps: []
  - title: Modify `generate` Command to Use New Logic
    description: Update the `generate` command's implementation. When the
      `--next-ready` flag is detected, the command will invoke the dependency
      discovery function from Phase 1 and, if a target is found, proceed with
      generation for that target plan.
    steps: []
  - title: Modify `prepare` Command to Use New Logic
    description: Similarly, update the `prepare` command to use the
      `--next-ready` flag. It will find the appropriate dependency and then
      execute its preparation logic on that dependency.
    steps: []
  - title: Modify `agent` Command to Use New Logic
    description: Apply the same integration pattern to the `agent` command. It will
      use the new flag to identify and run the agent on the next ready
      dependency in the plan's dependency chain.
    steps: []
  - title: Add End-to-End CLI Tests
    description: Create automated tests that execute the application with the new
      flag and various plan configurations. These tests will set up temporary
      plan files with different states and dependencies, run the commands, and
      assert that the correct plan was acted upon.
    steps: []
rmfilter:
  - src/rmplan
---

This phase connects the core logic from Phase 1 to the user-facing CLI. A new flag will be added to the relevant commands. When this flag is present, the command's execution target will be determined by the dependency discovery logic instead of being the plan provided directly as an argument.

### Acceptance Criteria
- A new flag (e.g., `--next-ready`) is available on the `generate`, `prepare`, and `agent` commands.
- Using the flag with a parent plan correctly redirects the command to execute on the next ready dependency.
- The commands exit gracefully with a message if no ready dependency is found.
- End-to-end tests confirm the correct behavior for all three commands.
