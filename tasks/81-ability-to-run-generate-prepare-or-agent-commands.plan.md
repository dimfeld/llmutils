---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Ability to run, generate, prepare, or agent commands on the next ready
  dependency of a plan.
goal: The project aims to introduce a new command-line flag that allows users to
  run `generate`, `prepare`, or `agent` commands on the next available
  dependency of a specified parent plan. The system will automatically find the
  first dependency in a "ready" or "pending" state and execute the command on
  it.
id: 81
uuid: 01a26e46-236d-45c3-a53d-4f70c65fc91a
status: done
priority: medium
container: true
dependencies:
  - 82
  - 83
  - 84
references:
  "82": c5a4a763-d7cf-4278-9a14-9d75119fdaeb
  "83": 5b0aeb44-6c70-4574-8290-07ccacb3f2b6
  "84": e6cf0714-e39c-423f-ae0a-4c4e1a177490
createdAt: 2025-07-29T19:19:03.441Z
updatedAt: 2025-10-27T08:39:04.257Z
tasks: []
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
  - src/common/cleanup_registry.test.ts
  - src/common/cleanup_registry.ts
  - src/rmplan/agent_runner.test.ts
  - src/rmplan/agent_runner.ts
  - src/rmplan/executors/claude_code/agent_generator.ts
  - src/rmplan/executors/claude_code/agent_prompts.ts
  - src/rmplan/executors/claude_code/orchestrator_prompt.ts
  - src/rmplan/executors/claude_code.test.ts
  - src/rmplan/executors/claude_code.ts
  - src/rmplan/executors/copy_only.ts
  - src/rmplan/executors/copy_paste.ts
  - src/rmplan/executors/one-call.ts
  - src/rmplan/executors/types.ts
  - src/rmplan/prompt_builder.test.ts
  - src/rmpr/main.ts
  - README.md
  - docs/next-ready-feature.md
  - src/rmfilter/additional_docs.test.ts
  - src/rmplan/cleanup.test.ts
  - src/rmplan/parent_completion.test.ts
  - src/rmplan/plans.ts
  - src/rmpr/modes/hybrid_context.test.ts
rmfilter:
  - src/rmplan
---

# Original Plan Details

So we want a new command line flag to be able to take any parent plan, and find the next plan that it depends on, either directly or indirectly, which is ready or pending.

The generate, prepare, or agent commands should be able to run on that plan.

# Processed Plan Details

## Implement CLI flag for next ready dependency

This feature enhances workflow automation by allowing users to trigger actions on the next logical step in a dependency chain without manually identifying which plan is ready.

### Analysis
The core of this project is to implement a dependency graph traversal mechanism. Given a parent plan, the system must:
1.  Identify all its direct and indirect dependencies, forming a dependency graph.
2.  Traverse this graph to find potential target plans. A breadth-first search (BFS) is recommended to find the "closest" dependencies first.
3.  For each dependency found, check its current state.
4.  Select the first dependency that is in a "ready" or "pending" state.
5.  This logic will be encapsulated and then integrated into the `generate`, `prepare`, and `agent` commands through a new command-line flag (e.g., `--next-ready`).
6.  If no suitable dependency is found, the command should exit gracefully with an informative message.

### Acceptance Criteria
- A new command-line flag exists for the `generate`, `prepare`, and `agent` commands.
- When the flag is used with a parent plan, the command successfully identifies and executes on the first direct or indirect dependency that is in a "ready" or "pending" state.
- If multiple dependencies are ready, the system deterministically chooses one (e.g., the first one encountered in a breadth-first search).
- If no dependencies are in a "ready" or "pending" state, the command exits with a status code indicating no action was taken and prints a clear message to the user.
- The command-line help text and project documentation are updated to reflect the new functionality.

### Technical Considerations
- The implementation will require a robust method for loading a plan and its dependencies to build a graph representation.
- A state management system must be accessible to query the status of each plan.
- The new logic should be thoroughly tested, with unit tests for the graph traversal and state checking, and integration tests for the CLI behavior.

### Constraints or Assumptions
- The system assumes that plans have a clearly defined state, including "ready" and "pending".
- It is assumed that plan dependencies are well-defined and do not contain unbreakable circular references.
