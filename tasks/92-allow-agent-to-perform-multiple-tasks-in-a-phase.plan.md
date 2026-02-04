---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Allow agent to perform multiple tasks in a phase at once
goal: Implement the end-to-end functionality for the new batch task execution
  mode, from CLI flag to final plan modification.
id: 92
uuid: f60ca94a-8ee3-4a87-9702-31d8bd65f367
status: done
priority: high
planGeneratedAt: 2025-08-09T03:12:30.145Z
promptsGeneratedAt: 2025-08-09T03:20:02.991Z
createdAt: 2025-08-09T02:59:32.264Z
updatedAt: 2025-10-27T08:39:04.233Z
tasks:
  - title: "Task 1: Add `--batch-tasks` CLI flag"
    done: true
    description: >
      Introduce a new boolean flag, `--batch-tasks`, to the `agent` command in
      src/tim/commands/agent.ts. This flag will be the entry point for
      activating the new batch execution mode.


      The flag should be added to the CLI command definition where other options
      are defined. It should be passed through the handleAgentCommand function
      to timAgent as part of the options object. The flag should be optional
      and default to false to maintain backward compatibility with existing
      behavior.
  - title: "Task 2: Implement a function to retrieve all incomplete tasks"
    done: true
    description: >
      Create a new helper function `getAllIncompleteTasks` in
      src/tim/plans/find_next.ts that takes a PlanSchema object and returns
      an array of all tasks that are not yet marked as `done: true`. This
      function will be used by the batch mode to collect all pending work.


      The function should iterate through all tasks in the plan and filter out
      those where task.done is false or undefined. It should return an array
      containing task objects along with their indices for later reference when
      marking them as complete. Add comprehensive unit tests to verify the
      function correctly identifies incomplete tasks.
  - title: "Task 3: Create the batch mode execution loop in the agent command"
    done: true
    description: >
      In the timAgent function, add a new execution path when `--batch-tasks`
      is true. This path will use a while loop that continues as long as there
      are incomplete tasks in the plan.


      The loop should: 1) Read the current plan file to get updated state, 2)
      Get all incomplete tasks using getAllIncompleteTasks, 3) If no incomplete
      tasks remain, exit the loop, 4) Format all incomplete tasks into a single
      prompt for the executor, 5) Execute the orchestrator with the batch
      prompt, 6) After execution, re-read the plan file to check for updates
      made by the orchestrator.


      The batch mode should check after the needsPreparation section but before
      the main execution loop. When batch mode is active, it should replace the
      existing step-by-step execution loop entirely.
  - title: "Task 4: Update the orchestrator prompt for batch processing"
    done: true
    description: >
      Modify the wrapWithOrchestration function in
      src/tim/executors/claude_code/orchestrator_prompt.ts to handle batch
      task processing when multiple tasks are provided.


      The updated prompt must instruct the orchestrator to: 1) Analyze the
      provided list of incomplete tasks, 2) Select a logical subset that makes
      sense to execute together (related functionality, dependencies, or
      efficiency), 3) Use the existing sub-agents to complete the selected
      tasks, 4) After successful completion, use the Edit tool to modify the
      plan YAML file at the provided path, setting `done: true` for each
      completed task.


      The prompt should emphasize that the orchestrator must update the plan
      file directly and should only mark tasks as done after they are
      successfully completed. Include the plan file path using the @ prefix so
      it can be edited.
  - title: "Task 5: Empower the orchestrator agent to edit the plan file"
    done: true
    description: >
      Configure the claude-code executor to ensure the orchestrator agent has
      permission to use the Edit tool on the plan file when in batch mode. 


      The plan file path needs to be made available to the orchestrator in a
      format it can use with the Edit tool. This involves: 1) Passing the plan
      file path through the executor's execute method, 2) Including the plan
      file with the @ prefix in the prompt so it's accessible, 3) Ensuring Edit
      is in the allowed tools list (which it already is by default).


      The executor should track that the plan file is being modified and handle
      any necessary cleanup or validation after execution.
  - title: "Task 6: Update sub-agent prompts to handle batched tasks"
    done: true
    description: >
      Adjust the prompts for the implementer, tester, and reviewer agents in
      src/tim/executors/claude_code/agent_prompts.ts so they understand they
      may receive multiple related tasks from the orchestrator.


      The sub-agents should be instructed that when they receive multiple tasks,
      they should work on them efficiently, considering shared context and
      avoiding redundant work. The implementer should implement all provided
      tasks, the tester should create tests covering all implemented
      functionality, and the reviewer should review the complete batch of
      changes holistically.


      The prompts should maintain backward compatibility - working correctly
      whether they receive a single task or multiple tasks.
  - title: "Task 7: Add integration tests for the batch execution mode"
    done: true
    description: >
      Create a comprehensive test suite in src/tim/commands/agent.test.ts for
      the batch execution mode functionality.


      Tests should cover: 1) Batch mode with multiple incomplete tasks,
      verifying tasks are marked done in the plan file, 2) Batch mode that
      completes in multiple iterations, 3) Batch mode with all tasks already
      complete, 4) Error handling when the orchestrator fails to update the plan
      file, 5) Verification that the plan status is updated to 'done' when all
      tasks complete.


      Use the existing test patterns with ModuleMocker for mocking dependencies.
      Create temporary plan files in test directories and verify they are
      correctly modified. Mock the executor to simulate the orchestrator
      updating the plan file.
  - title: "Task 8: Document the new `--batch-tasks` feature"
    done: true
    description: >
      Create documentation for the new --batch-tasks feature that explains its
      purpose, usage, and benefits. The documentation should be added to a file
      where it can be referenced by future development.


      Documentation should cover: 1) What batch mode does differently from
      normal execution, 2) When to use batch mode vs normal mode, 3) How the
      orchestrator selects which tasks to batch, 4) Example command usage, 5)
      How tasks are marked as complete in the plan file, 6) Any limitations or
      considerations.


      The documentation should be clear and include examples to help users
      understand when and how to use this feature effectively.
changedFiles:
  - BATCH_TASKS_TESTING_SUMMARY.md
  - README.md
  - docs/batch-tasks-feature.md
  - docs/linear-integration.md
  - integration_test.ts
  - package.json
  - src/common/issue_tracker/factory.integration.test.ts
  - src/common/issue_tracker/factory.test.ts
  - src/common/issue_tracker/factory.ts
  - src/common/issue_tracker/github.test.ts
  - src/common/issue_tracker/github.ts
  - src/common/issue_tracker/index.ts
  - src/common/issue_tracker/types.test.ts
  - src/common/issue_tracker/types.ts
  - src/common/linear.test.ts
  - src/common/linear.ts
  - src/common/linear_client.test.ts
  - src/common/linear_client.ts
  - src/rmfilter/rmfilter.ts
  - src/tim/batch_mode_integration.test.ts
  - src/tim/commands/agent.test.ts
  - src/tim/commands/agent.ts
  - src/tim/commands/agent_batch_mode.test.ts
  - src/tim/commands/batch_tasks.test.ts
  - src/tim/commands/batch_tasks_simple.test.ts
  - src/tim/commands/batch_tasks_unit.test.ts
  - src/tim/commands/documentation_consistency_check.test.ts
  - src/tim/commands/generate.test.ts
  - src/tim/commands/generate.ts
  - src/tim/commands/import.integration.test.ts
  - src/tim/commands/import.test.ts
  - src/tim/commands/import.ts
  - src/tim/commands/integration_linear.test.ts
  - src/tim/commands/issue_tracker_integration.test.ts
  - src/tim/commands/linear_documentation_examples.test.ts
  - src/tim/commands/linear_plan_structure.test.ts
  - src/tim/commands/plan_file_validation.test.ts
  - src/tim/configLoader.test.ts
  - src/tim/configSchema.test.ts
  - src/tim/configSchema.ts
  - src/tim/executors/claude_code/agent_prompts.test.ts
  - src/tim/executors/claude_code/agent_prompts.ts
  - src/tim/executors/claude_code/orchestrator_integration.test.ts
  - src/tim/executors/claude_code/orchestrator_prompt.test.ts
  - src/tim/executors/claude_code/orchestrator_prompt.ts
  - src/tim/executors/claude_code.test.ts
  - src/tim/executors/claude_code.ts
  - src/tim/executors/types.ts
  - src/tim/issue_utils.ts
  - src/tim/plans/find_next.test.ts
  - src/tim/plans/find_next.ts
  - src/tim/plans/prepare_phase.ts
  - src/tim/prompt_builder.test.ts
  - src/tim/prompt_builder.ts
  - src/tim/tim.ts
  - test.yml
  - test_yaml.js
rmfilter:
  - src/tim/commands/agent.ts
  - src/tim/executors
---

# Original Plan Details

Add a new mode to the agent command that gived the agent the plan file and all the not-done tasks, and tell it to choose some subset of those
tasks that makes sense to do in a batch together for a single unit of work. Then the orchestrator agent should edit the plan file to set `done: true` mark those tasks as done once
complete and then exit. 

Then the tim agent loop will reread the plan file, and go again if there are still tasks to be done in the plan file.

Put this mode under a new CLI option for now.

For this work we will need to give the orchestrator agent access to the `Update` tool and also update its instructions,
as well as passing all the not-done tasks to it and to the subagent prompts.

# Processed Plan Details

The current `tim agent` processes one task or step at a time in a linear fashion. This can be inefficient for plans with many small, independent, or related tasks that could be addressed concurrently or in a single context. This project will add a new `--batch-tasks` mode. In this mode, the agent loop will identify all incomplete tasks in a plan and pass them to an orchestrator agent. This orchestrator will be instructed to select a logical subset of these tasks, execute them (leveraging existing sub-agents like implementer, tester, reviewer), and then use a file editing tool to update the plan file, marking the completed tasks as `done: true`. The main agent loop will then re-evaluate the plan and continue if more tasks remain.

### Technical Approach
1. A new CLI flag `--batch-tasks` will be added to `src/tim/commands/agent.ts`.
2. A new execution path within `timAgent` will be created for this mode.
3. A helper function will be created to gather all incomplete tasks from a `PlanSchema`.
4. The `claude-code` executor will be enhanced. Its orchestrator prompt (`orchestrator_prompt.ts`) will be updated with instructions for batching and for using a file editing tool.
5. The `claude-code` executor will be configured to allow the orchestrator agent to use the `Edit` tool on the plan file.
6. The main loop in `timAgent` will be structured to run until no incomplete tasks are left in the plan.

### Acceptance Criteria
1. Running `tim agent --batch-tasks <plan_file>` successfully executes a plan with multiple tasks.
2. The orchestrator agent correctly identifies a subset of tasks to work on.
3. After the orchestrator agent completes a batch, the corresponding tasks in the plan YAML file are marked with `done: true`.
4. The agent loop continues until all tasks in the plan are marked as `done`.
5. The feature is covered by automated tests that verify the plan file modification and loop termination.
6. The new CLI flag is documented.

This phase will introduce the `--batch-tasks` CLI flag and all associated logic. It involves modifying the agent's main loop, updating the orchestrator agent's capabilities and instructions to handle task batching, and ensuring the plan state is correctly updated and re-evaluated after each batch execution.
