---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Allow agent to perform multiple tasks in a phase at once
goal: Implement the end-to-end functionality for the new batch task execution
  mode, from CLI flag to final plan modification.
id: 92
status: pending
priority: high
dependencies: []
planGeneratedAt: 2025-08-09T03:12:30.145Z
createdAt: 2025-08-09T02:59:32.264Z
updatedAt: 2025-08-09T03:12:30.145Z
tasks:
  - title: "Task 1: Add `--batch-tasks` CLI flag"
    description: Introduce a new boolean flag, `--batch-tasks`, to the `agent`
      command. This flag will be the entry point for activating the new batch
      execution mode within the agent's logic.
    steps: []
  - title: "Task 2: Implement a function to retrieve all incomplete tasks"
    description: "Create a new helper function that takes a `PlanSchema` object and
      returns an array of all tasks that are not yet marked as `done: true`.
      This function is crucial for feeding the orchestrator agent the correct
      set of pending work."
    steps: []
  - title: "Task 3: Create the batch mode execution loop in the agent command"
    description: In the `rmplanAgent` function, add a new `while` loop that is
      active when `--batch-tasks` is used. This loop will continue as long as
      there are incomplete tasks in the plan. Inside the loop, it will gather
      all incomplete tasks, prepare a single prompt for the executor, and then
      reload the plan file to re-evaluate the state for the next iteration.
    steps: []
  - title: "Task 4: Update the orchestrator prompt for batch processing"
    description: "Modify the orchestrator prompt generation logic. The new prompt
      must instruct the orchestrator agent to analyze the provided list of
      incomplete tasks, select a logical subset to execute in one batch, use its
      sub-agents to complete the work, and finally use the `Edit` tool to modify
      the plan file to mark the completed tasks with `done: true`."
    steps: []
  - title: "Task 5: Empower the orchestrator agent to edit the plan file"
    description: Configure the `claude-code` executor to grant the orchestrator
      agent permission to use the `Edit` tool when in batch mode. The plan
      file's path must also be made available to the agent in a format it can
      use, such as an `@`-prefixed file path in the prompt, allowing it to read
      and modify the plan.
    steps: []
  - title: "Task 6: Update sub-agent prompts to handle batched tasks"
    description: Adjust the prompts for the implementer, tester, and reviewer agents
      so they understand they may receive a set of related tasks from the
      orchestrator, rather than just a single task from the original plan. This
      ensures the sub-agents have the correct context for their work.
    steps: []
  - title: "Task 7: Add integration tests for the batch execution mode"
    description: Create a new test suite for the `rmplanAgent` function. This test
      should create a temporary plan file with several tasks, run the agent with
      the `--batch-tasks` option, mock the executor's behavior to simulate
      marking tasks as done, and assert that the plan file is correctly updated
      and the agent loop terminates appropriately.
    steps: []
  - title: "Task 8: Document the new `--batch-tasks` feature"
    description: Update the relevant documentation, such as the CLI help text or a
      README file, to explain the purpose and usage of the new `--batch-tasks`
      flag, ensuring users can discover and use the new functionality.
    steps: []
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
