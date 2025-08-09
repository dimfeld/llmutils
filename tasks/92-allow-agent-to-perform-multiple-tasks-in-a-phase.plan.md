---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Allow agent to perform multiple tasks in a phase at once
goal: Implement the end-to-end functionality for the new batch task execution
  mode, from CLI flag to final plan modification.
id: 92
status: in_progress
priority: high
dependencies: []
planGeneratedAt: 2025-08-09T03:12:30.145Z
promptsGeneratedAt: 2025-08-09T03:20:02.991Z
createdAt: 2025-08-09T02:59:32.264Z
updatedAt: 2025-08-09T04:35:18.909Z
tasks:
  - title: "Task 1: Add `--batch-tasks` CLI flag"
    description: >
      Introduce a new boolean flag, `--batch-tasks`, to the `agent` command in
      src/rmplan/commands/agent.ts. This flag will be the entry point for
      activating the new batch execution mode.


      The flag should be added to the CLI command definition where other options
      are defined. It should be passed through the handleAgentCommand function
      to rmplanAgent as part of the options object. The flag should be optional
      and default to false to maintain backward compatibility with existing
      behavior.
    files:
      - src/rmplan/commands/agent.ts
    steps:
      - prompt: >
          Add a new boolean CLI option `--batch-tasks` to the agent command
          definition. Look for where other options like `--workspace`,
          `--executor`, and `--steps` are defined and add the new flag there
          with appropriate description explaining it enables batch task
          execution mode.
        done: true
      - prompt: >
          Ensure the new `--batch-tasks` option is properly passed through from
          handleAgentCommand to rmplanAgent function in the options parameter so
          it can be accessed within the agent execution logic.
        done: true
  - title: "Task 2: Implement a function to retrieve all incomplete tasks"
    description: >
      Create a new helper function `getAllIncompleteTasks` in
      src/rmplan/plans/find_next.ts that takes a PlanSchema object and returns
      an array of all tasks that are not yet marked as `done: true`. This
      function will be used by the batch mode to collect all pending work.


      The function should iterate through all tasks in the plan and filter out
      those where task.done is false or undefined. It should return an array
      containing task objects along with their indices for later reference when
      marking them as complete. Add comprehensive unit tests to verify the
      function correctly identifies incomplete tasks.
    files:
      - src/rmplan/plans/find_next.ts
      - src/rmplan/plans/find_next.test.ts
    steps:
      - prompt: >
          In src/rmplan/plans/find_next.ts, create a new exported function
          `getAllIncompleteTasks` that takes a PlanSchema parameter and returns
          an array of objects containing taskIndex and task for all tasks where
          done is not true. Include a proper TypeScript interface for the return
          type.
        done: true
      - prompt: >
          In src/rmplan/plans/find_next.test.ts, add comprehensive tests for
          getAllIncompleteTasks including cases with: all tasks complete, no
          tasks complete, mixed completion status, empty task list, and tasks
          without the done field set.
        done: true
  - title: "Task 3: Create the batch mode execution loop in the agent command"
    description: >
      In the rmplanAgent function, add a new execution path when `--batch-tasks`
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
    files:
      - src/rmplan/commands/agent.ts
    steps:
      - prompt: >
          Import the getAllIncompleteTasks function from plans/find_next.js at
          the top of the file with the other imports.
        done: true
      - prompt: >
          After the plan preparation section (around line 386) and before the
          main execution loop, add a conditional check for options.batchTasks.
          If true, implement a new while loop that continues until no incomplete
          tasks remain.
        done: true
      - prompt: >
          Inside the batch mode loop, read the plan file, get all incomplete
          tasks, and if tasks exist, build a prompt that includes the plan
          context and all incomplete task details. Pass the plan file path to
          the executor so the orchestrator can edit it.
        done: true
      - prompt: >
          After the executor completes in batch mode, re-read the plan file to
          get the updated state. If all tasks are now marked done, update the
          plan status to 'done' and handle parent plan updates similar to the
          existing logic. Include appropriate logging for batch mode operations.
        done: true
  - title: "Task 4: Update the orchestrator prompt for batch processing"
    description: >
      Modify the wrapWithOrchestration function in
      src/rmplan/executors/claude_code/orchestrator_prompt.ts to handle batch
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
    files:
      - src/rmplan/executors/claude_code/orchestrator_prompt.ts
    steps:
      - prompt: >
          Add a new parameter to wrapWithOrchestration function to accept an
          optional planFilePath and a boolean flag indicating batch mode. When
          in batch mode, include additional instructions about analyzing and
          selecting task subsets.
        done: true
      - prompt: >
          In the batch mode instructions, add clear guidance that the
          orchestrator should use the Edit tool to modify the plan file at the
          provided path, updating the `done` field to true for each completed
          task. Include an example of the YAML structure they'll be editing.
        done: true
      - prompt: >
          Add instructions explaining how the orchestrator should select which
          tasks to batch together - considering factors like related
          functionality, shared files, logical grouping, and efficiency.
          Emphasize they should not attempt all tasks at once but select a
          reasonable subset.
        done: true
  - title: "Task 5: Empower the orchestrator agent to edit the plan file"
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
    files:
      - src/rmplan/executors/claude_code.ts
      - src/rmplan/prompt_builder.ts
    steps:
      - prompt: >
          In src/rmplan/executors/claude_code.ts, modify the execute method to
          check if batch mode is active (could be indicated by presence of
          multiple tasks in planInfo). When in batch mode, ensure the plan file
          path is properly formatted with the @ prefix for Edit tool access.
        done: true
      - prompt: >
          Update the orchestration wrapper call in the execute method to pass
          the plan file path when in batch mode, ensuring it's included in the
          orchestrator's context with proper @ prefix formatting.
        done: true
      - prompt: >
          In src/rmplan/prompt_builder.ts, add a helper function or modify
          buildExecutionPromptWithoutSteps to include the plan file reference
          when building prompts for batch mode, making it clear to the
          orchestrator which file to edit.
        done: true
  - title: "Task 6: Update sub-agent prompts to handle batched tasks"
    description: >
      Adjust the prompts for the implementer, tester, and reviewer agents in
      src/rmplan/executors/claude_code/agent_prompts.ts so they understand they
      may receive multiple related tasks from the orchestrator.


      The sub-agents should be instructed that when they receive multiple tasks,
      they should work on them efficiently, considering shared context and
      avoiding redundant work. The implementer should implement all provided
      tasks, the tester should create tests covering all implemented
      functionality, and the reviewer should review the complete batch of
      changes holistically.


      The prompts should maintain backward compatibility - working correctly
      whether they receive a single task or multiple tasks.
    files:
      - src/rmplan/executors/claude_code/agent_prompts.ts
    steps:
      - prompt: >
          Update the getImplementerPrompt function to include instructions for
          handling multiple tasks. Add guidance that when multiple tasks are
          provided, the implementer should work on them together efficiently,
          considering shared code and avoiding duplication.
        done: true
      - prompt: >
          Update the getTesterPrompt function to handle multiple tasks,
          instructing the tester to create comprehensive tests that cover all
          functionality from all provided tasks, ensuring test coverage across
          the batch.
        done: true
      - prompt: >
          Update the getReviewerPrompt function to review batched changes
          holistically, checking that all tasks are properly implemented, work
          together correctly, and maintain code quality standards across the
          entire batch.
        done: true
  - title: "Task 7: Add integration tests for the batch execution mode"
    description: >
      Create a comprehensive test suite in src/rmplan/commands/agent.test.ts for
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
    files:
      - src/rmplan/commands/agent.test.ts
    steps:
      - prompt: >
          Add a new test suite 'rmplanAgent - Batch Tasks Mode' with setup that
          creates temporary directories and plan files with multiple incomplete
          tasks. Use the existing test patterns and ModuleMocker setup.
        done: false
      - prompt: >
          Create a test that verifies batch mode executes when --batch-tasks
          flag is true, mocking the executor to simulate updating specific tasks
          to done: true in the plan file, and confirming the loop continues
          until all tasks are complete.
        done: false
      - prompt: >
          Add a test for batch mode completing in multiple iterations - where
          the executor marks only some tasks as done in each iteration,
          requiring multiple loop cycles to complete all tasks.
        done: false
      - prompt: >
          Create tests for edge cases: all tasks already complete (should exit
          immediately), executor fails to update plan file (should handle error
          gracefully), and verification that parent plan status updates work
          correctly in batch mode.
        done: false
  - title: "Task 8: Document the new `--batch-tasks` feature"
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
    files:
      - docs/batch-tasks-feature.md
    steps:
      - prompt: >
          Create a new documentation file docs/batch-tasks-feature.md with a
          clear introduction explaining that --batch-tasks mode allows the agent
          to intelligently select and execute multiple related tasks in a single
          operation, improving efficiency for plans with many small or related
          tasks.
        done: false
      - prompt: >
          Add sections covering: Usage (with example commands), How it Works
          (explaining the orchestrator's role in task selection and plan
          updates), Benefits (efficiency, context preservation), When to Use
          (multiple small tasks, related functionality), and Comparison with
          Normal Mode.
        done: false
      - prompt: >
          Include a practical example showing a plan YAML before and after batch
          execution, demonstrating how tasks are marked as done: true, and add
          any important notes about limitations or best practices for using
          batch mode effectively.
        done: false
changedFiles:
  - BATCH_TASKS_TESTING_SUMMARY.md
  - README.md
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
  - src/rmplan/batch_mode_integration.test.ts
  - src/rmplan/commands/agent.ts
  - src/rmplan/commands/agent_batch_mode.test.ts
  - src/rmplan/commands/batch_tasks.test.ts
  - src/rmplan/commands/batch_tasks_simple.test.ts
  - src/rmplan/commands/batch_tasks_unit.test.ts
  - src/rmplan/commands/documentation_consistency_check.test.ts
  - src/rmplan/commands/generate.test.ts
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/import.integration.test.ts
  - src/rmplan/commands/import.test.ts
  - src/rmplan/commands/import.ts
  - src/rmplan/commands/integration_linear.test.ts
  - src/rmplan/commands/issue_tracker_integration.test.ts
  - src/rmplan/commands/linear_documentation_examples.test.ts
  - src/rmplan/commands/linear_plan_structure.test.ts
  - src/rmplan/commands/plan_file_validation.test.ts
  - src/rmplan/configLoader.test.ts
  - src/rmplan/configSchema.test.ts
  - src/rmplan/configSchema.ts
  - src/rmplan/executors/claude_code/agent_prompts.test.ts
  - src/rmplan/executors/claude_code/agent_prompts.ts
  - src/rmplan/executors/claude_code/orchestrator_integration.test.ts
  - src/rmplan/executors/claude_code/orchestrator_prompt.test.ts
  - src/rmplan/executors/claude_code/orchestrator_prompt.ts
  - src/rmplan/executors/claude_code.test.ts
  - src/rmplan/executors/claude_code.ts
  - src/rmplan/executors/types.ts
  - src/rmplan/issue_utils.ts
  - src/rmplan/plans/find_next.test.ts
  - src/rmplan/plans/find_next.ts
  - src/rmplan/plans/prepare_phase.ts
  - src/rmplan/prompt_builder.test.ts
  - src/rmplan/prompt_builder.ts
  - src/rmplan/rmplan.ts
rmfilter:
  - src/rmplan/commands/agent.ts
  - src/rmplan/executors
---

# Original Plan Details

Add a new mode to the agent command that gived the agent the plan file and all the not-done tasks, and tell it to choose some subset of those
tasks that makes sense to do in a batch together for a single unit of work. Then the orchestrator agent should edit the plan file to set `done: true` mark those tasks as done once
complete and then exit. 

Then the rmplan agent loop will reread the plan file, and go again if there are still tasks to be done in the plan file.

Put this mode under a new CLI option for now.

For this work we will need to give the orchestrator agent access to the `Update` tool and also update its instructions,
as well as passing all the not-done tasks to it and to the subagent prompts.

# Processed Plan Details

The current `rmplan agent` processes one task or step at a time in a linear fashion. This can be inefficient for plans with many small, independent, or related tasks that could be addressed concurrently or in a single context. This project will add a new `--batch-tasks` mode. In this mode, the agent loop will identify all incomplete tasks in a plan and pass them to an orchestrator agent. This orchestrator will be instructed to select a logical subset of these tasks, execute them (leveraging existing sub-agents like implementer, tester, reviewer), and then use a file editing tool to update the plan file, marking the completed tasks as `done: true`. The main agent loop will then re-evaluate the plan and continue if more tasks remain.

### Technical Approach
1. A new CLI flag `--batch-tasks` will be added to `src/rmplan/commands/agent.ts`.
2. A new execution path within `rmplanAgent` will be created for this mode.
3. A helper function will be created to gather all incomplete tasks from a `PlanSchema`.
4. The `claude-code` executor will be enhanced. Its orchestrator prompt (`orchestrator_prompt.ts`) will be updated with instructions for batching and for using a file editing tool.
5. The `claude-code` executor will be configured to allow the orchestrator agent to use the `Edit` tool on the plan file.
6. The main loop in `rmplanAgent` will be structured to run until no incomplete tasks are left in the plan.

### Acceptance Criteria
1. Running `rmplan agent --batch-tasks <plan_file>` successfully executes a plan with multiple tasks.
2. The orchestrator agent correctly identifies a subset of tasks to work on.
3. After the orchestrator agent completes a batch, the corresponding tasks in the plan YAML file are marked with `done: true`.
4. The agent loop continues until all tasks in the plan are marked as `done`.
5. The feature is covered by automated tests that verify the plan file modification and loop termination.
6. The new CLI flag is documented.

This phase will introduce the `--batch-tasks` CLI flag and all associated logic. It involves modifying the agent's main loop, updating the orchestrator agent's capabilities and instructions to handle task batching, and ensuring the plan state is correctly updated and re-evaluated after each batch execution.
