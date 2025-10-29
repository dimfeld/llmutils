---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Implement rmplan add-task and remove-task commands
goal: ""
id: 132
uuid: 7ebf9d14-805e-4178-83a7-a1e91154de23
generatedBy: agent
status: in_progress
priority: medium
container: false
temp: false
dependencies: []
parent: 128
references:
  "128": f69d418b-aaf1-4c29-88a9-f557baf8f81e
issue: []
pullRequest: []
docs: []
planGeneratedAt: 2025-10-28T23:31:23.749Z
promptsGeneratedAt: 2025-10-28T23:31:23.749Z
createdAt: 2025-10-26T22:41:12.354Z
updatedAt: 2025-10-29T03:41:11.069Z
progressNotes:
  - timestamp: 2025-10-29T03:03:00.217Z
    text: Implemented new task_operations utilities providing title search,
      interactive selection, and editor-backed task info prompts for reuse
      across upcoming commands.
    source: "implementer: Create shared task utilities module"
  - timestamp: 2025-10-29T03:04:24.866Z
    text: Added add-task and remove-task command handlers leveraging shared
      utilities, normalized option inputs, and integrated both commands into the
      main rmplan CLI.
    source: "implementer: Implement add/remove task commands"
  - timestamp: 2025-10-29T03:09:59.338Z
    text: Added add-plan-task and remove-plan-task MCP handlers with validation,
      normalized metadata handling, and registered them in generate mode for
      autonomous agent workflows.
    source: "implementer: Implement MCP task management tools"
  - timestamp: 2025-10-29T03:10:04.032Z
    text: Created unit tests covering task utilities, add/remove command handlers,
      and MCP task operations ensuring new features are validated end-to-end.
    source: "implementer: Write unit tests"
  - timestamp: 2025-10-29T03:12:25.897Z
    text: Ran TypeScript checks and the full Bun test suite to validate new task
      management features; all checks passed successfully.
    source: "implementer: Verification"
  - timestamp: 2025-10-29T03:18:41.288Z
    text: Added integration coverage for rmplan add-task and remove-task commands;
      bun run check and targeted integration suite both pass.
    source: "tester: integration tests"
  - timestamp: 2025-10-29T03:33:59.794Z
    text: Reviewed existing add/remove task command handlers, unit tests, and
      current README coverage to confirm gaps for the requested integration
      workflows.
    source: "implementer: Task 11"
  - timestamp: 2025-10-29T03:39:11.125Z
    text: Added end-to-end coverage in
      src/rmplan/commands/task-management.integration.test.ts for CLI add/remove
      flows, diverse MCP tool combinations, and cross-interface round-trips.
    source: "implementer: Task 11"
  - timestamp: 2025-10-29T03:39:15.964Z
    text: Updated README with explicit add-task/remove-task command descriptions,
      workflow examples, and new MCP tool documentation; noted shared utilities
      and integration tests in CLAUDE.md.
    source: "implementer: Task 12"
  - timestamp: 2025-10-29T03:40:54.984Z
    text: Ran bun run check and the full bun test suite; new task-management
      integration specs passed alongside existing suites.
    source: "tester: Task 11"
tasks:
  - title: Create shared task utilities module
    done: true
    description: >-
      Create `src/rmplan/utils/task_operations.ts` with shared utility functions
      for task manipulation:


      - `findTaskByTitle(tasks: Task[], title: string): number` - Find task
      index by partial title match (case-insensitive)

      - `selectTaskInteractive(tasks: Task[]): Promise<number>` - Present
      interactive checkbox to select a task

      - `promptForTaskInfo(options?: Partial<TaskInput>): Promise<TaskInput>` -
      Interactive prompt for task title, description, files, docs


      These utilities will be used by both add-task and remove-task commands to
      ensure consistent behavior.
  - title: Implement add-task command handler
    done: true
    description: >-
      Create `src/rmplan/commands/add-task.ts` with `handleAddTaskCommand()`
      function:


      **Function signature:**

      ```typescript

      export async function handleAddTaskCommand(
        plan: string,
        options: AddTaskOptions,
        command: any
      ): Promise<void>

      ```


      **Options interface:**

      ```typescript

      export interface AddTaskOptions {
        title?: string;
        description?: string;
        editor?: boolean;
        files?: string[];
        docs?: string[];
        interactive?: boolean;
      }

      ```


      **Implementation steps:**

      1. Load effective config from `command.parent.opts()`

      2. Resolve plan using `resolvePlanFile()`

      3. Read plan using `readPlanFile()`

      4. Collect task info:
         - If `--interactive`, use `promptForTaskInfo()`
         - If `--editor`, use `editor()` from @inquirer/prompts for description
         - Otherwise, require `--title` and `--description` flags
         - Collect optional `--files` and `--docs`
      5. Create new task object with required fields (title, description, done:
      false, steps: [])

      6. Push task to `plan.tasks` array

      7. Update `plan.updatedAt` timestamp

      8. Write plan using `writePlanFile()`

      9. Display success message with task title and index


      **Error handling:**

      - Throw error if plan not found

      - Throw error if required fields missing (non-interactive mode)

      - Handle editor cancellation gracefully
  - title: Implement remove-task command handler
    done: true
    description: >-
      Create `src/rmplan/commands/remove-task.ts` with
      `handleRemoveTaskCommand()` function:


      **Function signature:**

      ```typescript

      export async function handleRemoveTaskCommand(
        plan: string,
        options: RemoveTaskOptions,
        command: any
      ): Promise<void>

      ```


      **Options interface:**

      ```typescript

      export interface RemoveTaskOptions {
        title?: string;
        index?: number;
        interactive?: boolean;
        yes?: boolean;
      }

      ```


      **Implementation steps:**

      1. Load effective config from `command.parent.opts()`

      2. Resolve plan using `resolvePlanFile()`

      3. Read plan using `readPlanFile()`

      4. Identify task to remove:
         - If `--title`, use `findTaskByTitle()` - throw if not found
         - If `--index`, validate bounds - throw if out of range
         - If `--interactive`, use `selectTaskInteractive()`
         - Throw error if none provided
      5. Show task details and confirm deletion (unless `--yes` flag)

      6. Remove task using `splice()`

      7. Update `plan.updatedAt` timestamp

      8. Write plan using `writePlanFile()`

      9. Display success message with:
         - Removed task title and former index
         - Warning about index shifts if removed from middle

      **Error handling:**

      - Throw error if plan not found

      - Throw error if task not found (by title or index)

      - Throw error if no selection method provided

      - Handle confirmation cancellation (user selects 'no')
  - title: Register CLI commands in rmplan.ts
    done: true
    description: >-
      Add command registrations to `src/rmplan/rmplan.ts`:


      **add-task command:**

      ```typescript

      program
        .command('add-task <plan>')
        .description('Add a task to an existing plan (file path or plan ID)')
        .option('--title <title>', 'Task title')
        .option('--description <desc>', 'Task description')
        .option('--editor', 'Open editor for description')
        .option('--files <files...>', 'Related files')
        .option('--docs <docs...>', 'Documentation paths')
        .option('--interactive', 'Prompt for all fields interactively')
        .action(async (plan, options, command) => {
          const { handleAddTaskCommand } = await import('./commands/add-task.js');
          await handleAddTaskCommand(plan, options, command).catch(handleCommandError);
        });
      ```


      **remove-task command:**

      ```typescript

      program
        .command('remove-task <plan>')
        .description('Remove a task from a plan. Prefer --title over --index as indices shift after removal.')
        .option('--title <title>', 'Find task by title (partial match) - RECOMMENDED')
        .option('--index <index>', 'Task index (0-based) - use with caution', (val) => parseInt(val, 10))
        .option('--interactive', 'Select task interactively')
        .option('--yes', 'Skip confirmation prompt')
        .action(async (plan, options, command) => {
          const { handleRemoveTaskCommand } = await import('./commands/remove-task.js');
          await handleRemoveTaskCommand(plan, options, command).catch(handleCommandError);
        });
      ```


      Ensure commands are registered in the appropriate location (likely after
      other task-related commands).
  - title: Implement MCP add-plan-task tool
    done: true
    description: >-
      Add MCP tool for adding tasks in `src/rmplan/mcp/generate_mode.ts`:


      **1. Define parameter schema:**

      ```typescript

      export const addTaskParameters = z
        .object({
          plan: z.string().describe('Plan ID or file path'),
          title: z.string().describe('Task title'),
          description: z.string().describe('Task description'),
          files: z.array(z.string()).optional().describe('Related file paths'),
          docs: z.array(z.string()).optional().describe('Documentation paths'),
        })
        .describe('Add a new task to an existing plan');
      ```


      **2. Create handler function (can be in same file or separate command
      module):**

      ```typescript

      export async function mcpAddTask(
        args: z.infer<typeof addTaskParameters>,
        context: GenerateModeRegistrationContext,
        execContext: { log: GenerateModeExecutionLogger }
      ): Promise<string> {
        const { plan, planPath } = await resolvePlan(args.plan, context);
        
        const newTask = {
          title: args.title,
          description: args.description,
          done: false,
          files: args.files || [],
          docs: args.docs || [],
          steps: [],
        };
        
        plan.tasks.push(newTask);
        plan.updatedAt = new Date().toISOString();
        
        await writePlanFile(planPath, plan);
        
        const relativePath = path.relative(context.gitRoot, planPath) || planPath;
        return `Added task "${args.title}" to plan ${plan.id} at index ${plan.tasks.length - 1}`;
      }

      ```


      **3. Register tool in `registerGenerateMode()`:**

      ```typescript

      server.addTool({
        name: 'add-plan-task',
        description: 'Add a new task to an existing plan',
        parameters: addTaskParameters,
        annotations: {
          destructiveHint: true,
        },
        execute: async (args, execContext) => {
          try {
            return await mcpAddTask(args, context, {
              log: wrapLogger(execContext.log, '[add-plan-task] '),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(message);
          }
        },
      });

      ```
  - title: Implement MCP remove-plan-task tool
    done: true
    description: >-
      Add MCP tool for removing tasks in `src/rmplan/mcp/generate_mode.ts`:


      **1. Define parameter schema:**

      ```typescript

      export const removeTaskParameters = z
        .object({
          plan: z.string().describe('Plan ID or file path'),
          taskIndex: z.number().optional().describe('Task index (0-based). Note: indices shift after removal.'),
          taskTitle: z.string().optional().describe('Task title to search for (partial match). Preferred over taskIndex.'),
        })
        .describe('Remove a task from a plan by title (preferred) or index. Note: task indices shift after removal.');
      ```


      **2. Create handler function:**

      ```typescript

      export async function mcpRemoveTask(
        args: z.infer<typeof removeTaskParameters>,
        context: GenerateModeRegistrationContext,
        execContext: { log: GenerateModeExecutionLogger }
      ): Promise<string> {
        const { plan, planPath } = await resolvePlan(args.plan, context);
        
        let taskIndex: number;
        if (args.taskTitle) {
          taskIndex = plan.tasks.findIndex(t => 
            t.title.toLowerCase().includes(args.taskTitle!.toLowerCase())
          );
          if (taskIndex === -1) {
            throw new UserError(`No task found matching: ${args.taskTitle}`);
          }
        } else if (args.taskIndex !== undefined) {
          taskIndex = args.taskIndex;
          if (taskIndex < 0 || taskIndex >= plan.tasks.length) {
            throw new UserError(`Invalid task index: ${args.taskIndex}. Plan has ${plan.tasks.length} tasks.`);
          }
        } else {
          throw new UserError('Must provide either taskIndex or taskTitle');
        }
        
        const removed = plan.tasks.splice(taskIndex, 1)[0];
        plan.updatedAt = new Date().toISOString();
        
        await writePlanFile(planPath, plan);
        
        const relativePath = path.relative(context.gitRoot, planPath) || planPath;
        const shiftWarning = taskIndex < plan.tasks.length 
          ? ` Note: Indices of ${plan.tasks.length - taskIndex} subsequent tasks have shifted.`
          : '';
        return `Removed task "${removed.title}" from plan ${plan.id} (was at index ${taskIndex}).${shiftWarning}`;
      }

      ```


      **3. Register tool in `registerGenerateMode()`:**

      ```typescript

      server.addTool({
        name: 'remove-plan-task',
        description: 'Remove a task from a plan by title or index',
        parameters: removeTaskParameters,
        annotations: {
          destructiveHint: true,
        },
        execute: async (args, execContext) => {
          try {
            return await mcpRemoveTask(args, context, {
              log: wrapLogger(execContext.log, '[remove-plan-task] '),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(message);
          }
        },
      });

      ```
  - title: Write tests for task utilities
    done: true
    description: >-
      Create `src/rmplan/utils/task_operations.test.ts` with comprehensive
      tests:


      **Test cases for `findTaskByTitle`:**

      - Exact title match returns correct index

      - Partial title match (case-insensitive) returns correct index

      - Returns first match when multiple tasks match

      - Returns -1 when no tasks match

      - Empty string matches all tasks (returns 0)


      **Test cases for `selectTaskInteractive`:**

      - Mock checkbox to return selected index

      - Mock checkbox cancellation throws or returns -1

      - Displays task titles with done status indicators

      - Handles empty task list


      **Test cases for `promptForTaskInfo`:**

      - Interactive prompts collect all fields

      - Pre-filled options are used as defaults

      - Editor mode collects description via editor

      - Handles prompt cancellation


      **Test setup:**

      - Use ModuleMocker to mock @inquirer/prompts

      - Create sample task arrays for testing

      - Use real task type definitions from schema
  - title: Write tests for add-task command
    done: true
    description: |-
      Create `src/rmplan/commands/add-task.test.ts` with comprehensive tests:

      **Test cases:**
      1. Add task with --title and --description flags
      2. Add task with --files and --docs options
      3. Add task interactively (mock prompts)
      4. Add task with --editor (mock editor response)
      5. Error when plan not found
      6. Error when required fields missing (non-interactive)
      7. Verify task appended to end of tasks array
      8. Verify updatedAt timestamp updated
      9. Verify task structure matches schema (done: false, steps: [])
      10. Add multiple tasks in sequence

      **Test setup:**
      - Create temp directory with test plan files
      - Mock logging, config, git utilities
      - Mock @inquirer/prompts for interactive tests
      - Use ModuleMocker for all module mocks
      - Clean up temp directory in afterEach

      **Verification:**
      - Read plan file after command execution
      - Verify task exists in tasks array
      - Verify all fields set correctly
      - Verify timestamp updated
  - title: Write tests for remove-task command
    done: true
    description: |-
      Create `src/rmplan/commands/remove-task.test.ts` with comprehensive tests:

      **Test cases:**
      1. Remove task by --title (exact match)
      2. Remove task by --title (partial match)
      3. Remove task by --index
      4. Remove task interactively (mock selection)
      5. Error when task not found by title
      6. Error when invalid index (negative)
      7. Error when invalid index (out of bounds)
      8. Error when no selection method provided
      9. Confirmation prompt works (mock confirm)
      10. --yes flag skips confirmation
      11. User declines confirmation (no changes)
      12. Verify indices shift after removal from middle
      13. Verify removing last task doesn't shift indices
      14. Verify updatedAt timestamp updated

      **Test setup:**
      - Create temp directory with test plan files
      - Create plans with multiple tasks for index shift testing
      - Mock logging, config, git utilities
      - Mock @inquirer/prompts for interactive/confirmation tests
      - Use ModuleMocker for all module mocks
      - Clean up temp directory in afterEach

      **Verification:**
      - Read plan file after command execution
      - Verify correct task removed
      - Verify remaining tasks shifted correctly
      - Verify task count decreased by 1
      - Verify timestamp updated
  - title: Write tests for MCP tools
    done: true
    description: |-
      Add tests to `src/rmplan/mcp/generate_mode.test.ts` for the new MCP tools:

      **Test cases for add-plan-task:**
      1. Add task with all fields (title, description, files, docs)
      2. Add task with minimal fields (title, description only)
      3. Error when plan not found
      4. Verify task appended to tasks array
      5. Verify return message includes task title and index
      6. Verify updatedAt timestamp updated

      **Test cases for remove-plan-task:**
      1. Remove task by taskTitle
      2. Remove task by taskIndex
      3. Error when task not found by title
      4. Error when invalid taskIndex (out of bounds)
      5. Error when neither taskTitle nor taskIndex provided
      6. Verify return message includes shift warning when applicable
      7. Verify task removed from array
      8. Verify updatedAt timestamp updated

      **Test setup:**
      - Create temp directory with test plan files
      - Set up GenerateModeRegistrationContext
      - Use stub logger for execContext
      - Create plans with multiple tasks for comprehensive testing
      - Use clearPlanCache() between tests
      - Clean up temp directory in afterEach

      **Verification:**
      - Call MCP handler functions directly
      - Read plan file after execution
      - Verify plan modifications
      - Verify return messages are descriptive
  - title: Integration testing
    done: false
    description: >-
      Create integration tests that verify end-to-end workflows:


      **Integration test scenarios:**

      1. **Add-then-show workflow:**
         - Add task to plan using add-task command
         - Use `rmplan show` to display plan
         - Verify new task appears in output

      2. **Remove-then-show workflow:**
         - Create plan with 3 tasks
         - Remove middle task using remove-task command
         - Use `rmplan show` to display plan
         - Verify correct task removed and indices shifted

      3. **Round-trip workflow:**
         - Add task to plan
         - Remove same task
         - Verify plan returns to original state

      4. **MCP integration:**
         - Use add-plan-task MCP tool to add task
         - Use remove-plan-task MCP tool to remove task
         - Verify both tools work correctly together

      5. **Mixed CLI and MCP:**
         - Add task via CLI
         - Remove task via MCP tool
         - Verify cross-compatibility

      **Test location:** Add to existing integration test file or create
      `src/rmplan/commands/task-management.integration.test.ts`


      **Verification:**

      - All commands complete successfully

      - Plan files are modified correctly

      - No data corruption or schema violations

      - Timestamps updated appropriately
  - title: Update documentation
    done: false
    description: >-
      Update project documentation to include the new commands:


      **1. Update README.md:**

      - Add `rmplan add-task` to command list with brief description

      - Add `rmplan remove-task` to command list with brief description

      - Include note about preferring title-based removal

      - Include warning about index stability


      **2. Add usage examples:**

      Create section showing common workflows:

      ```bash

      # Add a task

      rmplan add-task 42 --title "Add tests" --description "Add unit tests for
      new feature"


      # Remove a task by title (recommended)

      rmplan remove-task 42 --title "Add tests"


      # Interactive task management

      rmplan add-task 42 --interactive

      rmplan remove-task 42 --interactive

      ```


      **3. Document MCP tools:**

      - Add `add-plan-task` tool to MCP documentation

      - Add `remove-plan-task` tool to MCP documentation

      - Include parameter descriptions

      - Note about index stability in tool descriptions


      **4. Update CLAUDE.md if applicable:**

      - Add any new patterns or conventions established

      - Document the task utilities module

      - Note testing patterns used
changedFiles:
  - README.md
  - src/rmplan/commands/add-task.test.ts
  - src/rmplan/commands/add-task.ts
  - src/rmplan/commands/remove-task.test.ts
  - src/rmplan/commands/remove-task.ts
  - src/rmplan/mcp/generate_mode.test.ts
  - src/rmplan/mcp/generate_mode.ts
  - src/rmplan/rmplan.integration.test.ts
  - src/rmplan/rmplan.ts
  - src/rmplan/utils/task_operations.test.ts
  - src/rmplan/utils/task_operations.ts
rmfilter: []
---

## Overview

Add two new commands for managing tasks within existing plans without needing to manually edit the YAML files. This makes it easier for autonomous agents to dynamically adjust plans based on discoveries during implementation.

## Commands to Implement

### 1. `rmplan add-task <plan>`

Adds a new task to an existing plan.

**Options:**
- `--title <title>` - Task title (required unless interactive)
- `--description <desc>` - Task description (required unless interactive or using editor)
- `--editor` - Open editor to write description
- `--files <files...>` - Related file paths
- `--docs <docs...>` - Documentation paths
- `--interactive` - Prompt for all fields interactively

**Implementation file:** `src/rmplan/commands/add-task.ts`

**Behavior:**
1. Resolve plan ID or file path
2. Load existing plan
3. Collect task information (from flags, interactive prompts, or editor)
4. Create new task object with `done: false` and empty `steps: []`
5. Append to `plan.tasks` array
6. Update `plan.updatedAt` timestamp
7. Write plan file back
8. Display confirmation message

**Example usage:**
```bash
# Command line
rmplan add-task 42 --title "Add logging" --description "Add comprehensive logging to all API endpoints"

# With files
rmplan add-task 42 --title "Update tests" --description "..." --files src/api/*.ts

# Interactive
rmplan add-task 42 --interactive

# With editor
rmplan add-task 42 --title "Complex task" --editor
```

### 2. `rmplan remove-task <plan>`

Removes a task from a plan by index or title match.

**Options:**
- `--index <n>` - Task index (0-based)
- `--title <title>` - Find task by title (partial match)
- `--interactive` - Select task interactively from list

**Implementation file:** `src/rmplan/commands/remove-task.ts`

**Behavior:**
1. Resolve plan ID or file path
2. Load existing plan
3. Identify task to remove (by index, title search, or interactive selection)
4. Confirm deletion (unless `--yes` flag)
5. Remove task from array using `splice()`
6. Update `plan.updatedAt` timestamp
7. Write plan file back
8. Display confirmation with removed task title

**Example usage:**
```bash
# By index
rmplan remove-task 42 --index 2

# By title
rmplan remove-task 42 --title "logging"

# Interactive selection
rmplan remove-task 42 --interactive

# Skip confirmation
rmplan remove-task 42 --index 2 --yes
```

## CLI Integration

Add to `src/rmplan/rmplan.ts`:

```typescript
program
  .command('add-task <plan>')
  .description('Add a task to an existing plan (file path or plan ID)')
  .option('--title <title>', 'Task title')
  .option('--description <desc>', 'Task description')
  .option('--editor', 'Open editor for description')
  .option('--files <files...>', 'Related files')
  .option('--docs <docs...>', 'Documentation paths')
  .option('--interactive', 'Prompt for all fields interactively')
  .action(async (plan, options, command) => {
    const { handleAddTaskCommand } = await import('./commands/add-task.js');
    await handleAddTaskCommand(plan, options, command).catch(handleCommandError);
  });

program
  .command('remove-task <plan>')
  .description('Remove a task from a plan (file path or plan ID)')
  .option('--index <index>', 'Task index (0-based)', (val) => parseInt(val, 10))
  .option('--title <title>', 'Find task by title (partial match)')
  .option('--interactive', 'Select task interactively')
  .option('--yes', 'Skip confirmation prompt')
  .action(async (plan, options, command) => {
    const { handleRemoveTaskCommand } = await import('./commands/remove-task.js');
    await handleRemoveTaskCommand(plan, options, command).catch(handleCommandError);
  });
```

## Shared Utilities

Consider creating shared utilities in `src/rmplan/utils/task_operations.ts`:

```typescript
export async function promptForTask(): Promise<TaskInput> { ... }
export function findTaskByTitle(tasks: Task[], title: string): number { ... }
export function selectTaskInteractive(tasks: Task[]): Promise<number> { ... }
```

## Testing

### Unit Tests

File: `src/rmplan/commands/add-task.test.ts`
- Add task with all options specified
- Add task interactively (mock prompts)
- Add task with editor (mock editor function)
- Error when plan not found
- Error when required fields missing

File: `src/rmplan/commands/remove-task.test.ts`
- Remove task by index
- Remove task by title match
- Error when task not found
- Error when invalid index
- Confirmation prompt works (or --yes skips it)

### Integration Tests
- Add task, then show plan to verify it's there
- Add multiple tasks in sequence
- Remove task, then show plan to verify it's gone
- Round-trip: add task, remove task, verify plan unchanged

## Use Case for Agents

During plan execution, an agent might discover that additional tasks are needed:

```bash
# Agent discovers missing task during implementation
rmplan add-task 42 \
  --title "Add error handling for edge case" \
  --description "Found during testing: need to handle null user input" \
  --discovered-from 42

# Agent removes obsolete task after completing dependency
rmplan remove-task 42 --title "Manual database setup" \
  # (automated by earlier task)
```

## Dependencies

No dependencies - operates on existing plan schema and uses existing file I/O utilities.

## MCP Integration

Add MCP tools for dynamic task management:

File: `src/rmplan/mcp/generate_mode.ts`

### add-plan-task Tool

```typescript
export const addTaskParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path'),
    title: z.string().describe('Task title'),
    description: z.string().describe('Task description'),
    files: z.array(z.string()).optional().describe('Related file paths'),
    docs: z.array(z.string()).optional().describe('Documentation paths'),
  })
  .describe('Add a new task to an existing plan');

export async function handleAddTaskTool(
  args: z.infer<typeof addTaskParameters>,
  context: GenerateModeRegistrationContext
): Promise<string> {
  const { plan, planPath } = await resolvePlan(args.plan, context);
  
  const newTask = {
    title: args.title,
    description: args.description,
    done: false,
    files: args.files || [],
    docs: args.docs || [],
    steps: [],
  };
  
  plan.tasks.push(newTask);
  plan.updatedAt = new Date().toISOString();
  
  await writePlanFile(planPath, plan);
  
  return `Added task "${args.title}" to plan ${plan.id}`;
}
```

### remove-plan-task Tool

```typescript
export const removeTaskParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path'),
    taskIndex: z.number().optional().describe('Task index (0-based)'),
    taskTitle: z.string().optional().describe('Task title to search for (partial match)'),
  })
  .describe('Remove a task from a plan by index or title');

export async function handleRemoveTaskTool(
  args: z.infer<typeof removeTaskParameters>,
  context: GenerateModeRegistrationContext
): Promise<string> {
  const { plan, planPath } = await resolvePlan(args.plan, context);
  
  let taskIndex: number;
  if (args.taskIndex !== undefined) {
    taskIndex = args.taskIndex;
  } else if (args.taskTitle) {
    taskIndex = plan.tasks.findIndex(t => 
      t.title.toLowerCase().includes(args.taskTitle!.toLowerCase())
    );
    if (taskIndex === -1) {
      throw new UserError(`No task found matching: ${args.taskTitle}`);
    }
  } else {
    throw new UserError('Must provide either taskIndex or taskTitle');
  }
  
  const removed = plan.tasks.splice(taskIndex, 1)[0];
  plan.updatedAt = new Date().toISOString();
  
  await writePlanFile(planPath, plan);
  
  return `Removed task "${removed.title}" from plan ${plan.id}`;
}
```

Register both tools in `registerGenerateMode()`.

These tools enable agents to adapt plans dynamically during execution without human intervention.

<!-- rmplan-generated-start -->
## Overview

Add two new commands for managing tasks within existing plans without needing to manually edit the YAML files. This makes it easier for autonomous agents and users to dynamically adjust plans based on discoveries during implementation.

## Commands to Implement

### 1. `rmplan add-task <plan>`

Adds a new task to an existing plan.

**Options:**
- `--title <title>` - Task title (required unless interactive)
- `--description <desc>` - Task description (required unless interactive or using editor)
- `--editor` - Open editor to write description
- `--files <files...>` - Related file paths
- `--docs <docs...>` - Documentation paths
- `--interactive` - Prompt for all fields interactively

**Implementation file:** `src/rmplan/commands/add-task.ts`

**Behavior:**
1. Resolve plan ID or file path
2. Load existing plan
3. Collect task information (from flags, interactive prompts, or editor)
4. Create new task object with `done: false` and empty `steps: []`
5. Append to `plan.tasks` array
6. Update `plan.updatedAt` timestamp
7. Write plan file back
8. Display confirmation message

**Example usage:**
```bash
# Command line
rmplan add-task 42 --title "Add logging" --description "Add comprehensive logging to all API endpoints"

# With files
rmplan add-task 42 --title "Update tests" --description "..." --files src/api/*.ts

# Interactive
rmplan add-task 42 --interactive

# With editor
rmplan add-task 42 --title "Complex task" --editor
```

### 2. `rmplan remove-task <plan>`

Removes a task from a plan. **Prefer title-based removal** as task indices shift after removal.

**Options:**
- `--title <title>` - Find task by title (partial match) - **RECOMMENDED**
- `--index <n>` - Task index (0-based) - indices shift after removal
- `--interactive` - Select task interactively from list
- `--yes` - Skip confirmation prompt

**Implementation file:** `src/rmplan/commands/remove-task.ts`

**Behavior:**
1. Resolve plan ID or file path
2. Load existing plan
3. Identify task to remove (by title search, index, or interactive selection)
4. Confirm deletion (unless `--yes` flag)
5. Remove task from array using `splice()` - **WARNING: indices of subsequent tasks will shift**
6. Update `plan.updatedAt` timestamp
7. Write plan file back
8. Display confirmation with removed task title and warning about index shifts

**Example usage:**
```bash
# By title (RECOMMENDED)
rmplan remove-task 42 --title "logging"

# Interactive selection
rmplan remove-task 42 --interactive

# By index (use with caution - indices shift after removal)
rmplan remove-task 42 --index 2

# Skip confirmation
rmplan remove-task 42 --title "logging" --yes
```

## Index Stability Decision

**Approach: Simple array removal with clear warnings (Option C)**

- Tasks are removed using `splice()`, causing subsequent task indices to shift
- This matches existing codebase patterns and keeps implementation simple
- CLI output will warn users when indices have shifted
- Documentation and help text will recommend title-based removal
- Users must be aware that task indices are not stable after removal operations

**Warning message example:**
```
✓ Removed task "Add logging" (was at index 2)
⚠ Note: Indices of subsequent tasks have shifted. Task 3 is now at index 2, etc.
```

## CLI Integration

Add to `src/rmplan/rmplan.ts`:

```typescript
program
  .command('add-task <plan>')
  .description('Add a task to an existing plan (file path or plan ID)')
  .option('--title <title>', 'Task title')
  .option('--description <desc>', 'Task description')
  .option('--editor', 'Open editor for description')
  .option('--files <files...>', 'Related files')
  .option('--docs <docs...>', 'Documentation paths')
  .option('--interactive', 'Prompt for all fields interactively')
  .action(async (plan, options, command) => {
    const { handleAddTaskCommand } = await import('./commands/add-task.js');
    await handleAddTaskCommand(plan, options, command).catch(handleCommandError);
  });

program
  .command('remove-task <plan>')
  .description('Remove a task from a plan. Prefer --title over --index as indices shift after removal.')
  .option('--title <title>', 'Find task by title (partial match) - RECOMMENDED')
  .option('--index <index>', 'Task index (0-based) - use with caution', (val) => parseInt(val, 10))
  .option('--interactive', 'Select task interactively')
  .option('--yes', 'Skip confirmation prompt')
  .action(async (plan, options, command) => {
    const { handleRemoveTaskCommand } = await import('./commands/remove-task.js');
    await handleRemoveTaskCommand(plan, options, command).catch(handleCommandError);
  });
```

## Shared Utilities

Consider creating shared utilities in `src/rmplan/utils/task_operations.ts`:

```typescript
export async function promptForTask(): Promise<TaskInput> { ... }
export function findTaskByTitle(tasks: Task[], title: string): number { ... }
export async function selectTaskInteractive(tasks: Task[]): Promise<number> { ... }
```

## Testing

### Unit Tests

File: `src/rmplan/commands/add-task.test.ts`
- Add task with all options specified
- Add task interactively (mock prompts)
- Add task with editor (mock editor function)
- Error when plan not found
- Error when required fields missing
- Verify task appended to end of array
- Verify updatedAt timestamp updated

File: `src/rmplan/commands/remove-task.test.ts`
- Remove task by index
- Remove task by title match
- Remove task by title with multiple partial matches (picks first)
- Error when task not found
- Error when invalid index (negative, out of bounds)
- Confirmation prompt works (or --yes skips it)
- Verify indices shift after removal
- Interactive selection works

### Integration Tests
- Add task, then show plan to verify it's there
- Add multiple tasks in sequence
- Remove task, then show plan to verify it's gone
- Remove task from middle, verify indices shifted
- Round-trip: add task, remove task, verify plan unchanged

## Use Case for Agents

During plan execution, an agent might discover that additional tasks are needed:

```bash
# Agent discovers missing task during implementation
rmplan add-task 42 \
  --title "Add error handling for edge case" \
  --description "Found during testing: need to handle null user input"

# Agent removes obsolete task after completing dependency
rmplan remove-task 42 --title "Manual database setup" --yes
  # (automated by earlier task)
```

## MCP Integration

Add MCP tools for dynamic task management:

File: `src/rmplan/mcp/generate_mode.ts`

### add-plan-task Tool

```typescript
export const addTaskParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path'),
    title: z.string().describe('Task title'),
    description: z.string().describe('Task description'),
    files: z.array(z.string()).optional().describe('Related file paths'),
    docs: z.array(z.string()).optional().describe('Documentation paths'),
  })
  .describe('Add a new task to an existing plan');

export async function mcpAddTask(
  args: z.infer<typeof addTaskParameters>,
  context: GenerateModeRegistrationContext,
  execContext: { log: GenerateModeExecutionLogger }
): Promise<string> {
  const { plan, planPath } = await resolvePlan(args.plan, context);
  
  const newTask = {
    title: args.title,
    description: args.description,
    done: false,
    files: args.files || [],
    docs: args.docs || [],
    steps: [],
  };
  
  plan.tasks.push(newTask);
  plan.updatedAt = new Date().toISOString();
  
  await writePlanFile(planPath, plan);
  
  const relativePath = path.relative(context.gitRoot, planPath) || planPath;
  return `Added task "${args.title}" to plan ${plan.id} at index ${plan.tasks.length - 1}`;
}
```

### remove-plan-task Tool

```typescript
export const removeTaskParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path'),
    taskIndex: z.number().optional().describe('Task index (0-based). Note: indices shift after removal.'),
    taskTitle: z.string().optional().describe('Task title to search for (partial match). Preferred over taskIndex.'),
  })
  .describe('Remove a task from a plan by title (preferred) or index. Note: task indices shift after removal.');

export async function mcpRemoveTask(
  args: z.infer<typeof removeTaskParameters>,
  context: GenerateModeRegistrationContext,
  execContext: { log: GenerateModeExecutionLogger }
): Promise<string> {
  const { plan, planPath } = await resolvePlan(args.plan, context);
  
  let taskIndex: number;
  if (args.taskTitle) {
    taskIndex = plan.tasks.findIndex(t => 
      t.title.toLowerCase().includes(args.taskTitle!.toLowerCase())
    );
    if (taskIndex === -1) {
      throw new UserError(`No task found matching: ${args.taskTitle}`);
    }
  } else if (args.taskIndex !== undefined) {
    taskIndex = args.taskIndex;
    if (taskIndex < 0 || taskIndex >= plan.tasks.length) {
      throw new UserError(`Invalid task index: ${args.taskIndex}. Plan has ${plan.tasks.length} tasks.`);
    }
  } else {
    throw new UserError('Must provide either taskIndex or taskTitle');
  }
  
  const removed = plan.tasks.splice(taskIndex, 1)[0];
  plan.updatedAt = new Date().toISOString();
  
  await writePlanFile(planPath, plan);
  
  const relativePath = path.relative(context.gitRoot, planPath) || planPath;
  const shiftWarning = taskIndex < plan.tasks.length 
    ? ` Note: Indices of ${plan.tasks.length - taskIndex} subsequent tasks have shifted.`
    : '';
  return `Removed task "${removed.title}" from plan ${plan.id} (was at index ${taskIndex}).${shiftWarning}`;
}
```

Register both tools in `registerGenerateMode()`.
<!-- rmplan-generated-end -->

## Research

### Summary
The task requires implementing two new rmplan commands (`add-task` and `remove-task`) plus corresponding MCP tools to enable dynamic task management within existing plans. The codebase has well-established patterns for command handlers, plan I/O, interactive prompts, and testing that should be followed.

Key discoveries:
- Existing command structure provides clear templates (especially `set.ts`, `done.ts`, `set-task-done.ts`)
- Plan schema is well-defined with tasks as a required array containing title, description, done, files, docs, examples, and steps
- MCP integration uses FastMCP with Zod schemas and delegates to command modules for actual implementation
- Interactive features leverage @inquirer/prompts with support for text input, confirmation, selection, checkbox, and editor
- Testing uses real filesystem operations with ModuleMocker for module-level mocking

### Findings

#### Command Handler Patterns (from Explore Agent 1)

All command handlers in `src/rmplan/commands/` follow a consistent signature:

```typescript
export async function handle<CommandName>Command(
  primaryArg: string | string[],
  options: CommandOptions,
  command: any
): Promise<void>
```

Each command defines a TypeScript interface for its options:

```typescript
export interface AddTaskOptions {
  title?: string;
  description?: string;
  editor?: boolean;
  files?: string[];
  docs?: string[];
  interactive?: boolean;
}
```

**Plan Loading and Saving Utilities** (from `src/rmplan/plans.ts`):
- `resolvePlanFile(planArg: string, configPath?: string): Promise<string>` - Resolves plan ID or file path to absolute path (lines 208-280)
- `readPlanFile(filePath: string): Promise<PlanSchema>` - Read and validate a single plan file (lines 511-590)
- `writePlanFile(filePath: string, input: PlanSchemaInput): Promise<void>` - Write plan with YAML front matter + markdown body (lines 597-641)
  - Automatically validates with schema
  - Updates `updatedAt` timestamp
  - Formats as YAML front matter with details as markdown body

**Error Handling Approaches**:
- All commands use `.catch(handleCommandError)` in CLI registration
- `handleCommandError` from `src/rmplan/utils/commands.ts` provides centralized error handling
- Commands validate inputs before making changes
- Throw descriptive errors for invalid inputs

**CLI Registration Pattern** (from `src/rmplan/rmplan.ts`):

```typescript
program
  .command('command-name <requiredArg> [optionalArg]')
  .description('Command description')
  .option('--flag', 'Flag description')
  .option('-s, --short <value>', 'Option with value')
  .action(async (arg1, options, command) => {
    const { handleCommandFunction } = await import('./commands/file.js');
    await handleCommandFunction(arg1, options, command)
      .catch(handleCommandError);
  });
```

Commands use dynamic imports for lazy loading.

For integer parsing (useful for `--index` in remove-task):

```typescript
.option('--index <index>', 'Task index to mark as done (0-based)', 
  (value: string) => {
    const n = Number(value);
    if (Number.isNaN(n) || n < 0) {
      throw new Error(`Task index must be a non-negative integer, saw ${value}`);
    }
    return n;
  })
```

From `src/rmplan/rmplan.ts` lines 221-235.

#### Plan Schema and Task Structure (from Explore Agent 2)

**Task Type Definition** (from `src/rmplan/planSchema.ts` lines 25-33):

```typescript
type Task = {
  title: string;                    // REQUIRED
  done: boolean;                    // Default: false
  description: string;              // REQUIRED
  files?: string[];                 // OPTIONAL, default: []
  examples?: string[];              // OPTIONAL
  docs?: string[];                  // OPTIONAL, default: []
  steps: Step[];                    // Default: []
}

type Step = {
  prompt: string;                   // REQUIRED
  done: boolean;                    // Default: false
  examples?: string[];              // OPTIONAL
}
```

**Plan Type Highlights** (from `src/rmplan/planSchema.ts` lines 41-88):
- `tasks: Task[]` - REQUIRED (can be empty array)
- `updatedAt?: string` - Should be updated on every modification
- All other fields like `id`, `title`, `goal`, `details`, `status`, `priority` are optional

**Task Completion Logic** (from `src/rmplan/plans.ts` line 739):

```typescript
export function isTaskDone(task: PlanSchema['tasks'][0]): boolean {
  return task.done || ((task.steps?.length ?? 0) > 0 && task.steps.every((step) => step.done));
}
```

A task is considered done if:
- The `done` flag is explicitly true, OR
- It has steps AND all steps are marked done

**Task Manipulation Examples**:

From `src/rmplan/commands/split.ts` (lines 145):
```typescript
const remainingTasks = parent.tasks.filter((_, idx) => !unique.includes(idx));
parent.tasks = remainingTasks;
```

From `src/rmplan/commands/mark_done.ts` (lines 100-112):
```typescript
const pendingSteps = task.steps.filter((step) => !step.done);
for (const step of pendingSteps) {
  step.done = true;
}
```

**Important Pattern**: Direct mutation of tasks array is common:
```typescript
// Adding task
plan.tasks.push(newTask);
await writePlanFile(planPath, plan);

// Removing task
plan.tasks.splice(taskIndex, 1);
await writePlanFile(planPath, plan);

// Always update timestamp
plan.updatedAt = new Date().toISOString();
```

#### MCP Integration Patterns (from Explore Agent 3)

MCP tools are registered in `src/rmplan/mcp/generate_mode.ts` using FastMCP:

**Registration Structure**:
```typescript
server.addTool({
  name: 'tool-name',
  description: 'Tool description',
  parameters: zodSchema,
  annotations: {
    destructiveHint: boolean,  // Indicates if tool modifies state
    readOnlyHint: boolean,      // Indicates if tool is read-only
  },
  execute: async (args, execContext) => {
    return await mcpHandlerFunction(args, context, execContext);
  },
});
```

**Context Provided to Tools** (`GenerateModeRegistrationContext`):
```typescript
export interface GenerateModeRegistrationContext {
  config: RmplanConfig;      // Effective configuration
  configPath?: string;       // Path to config file
  gitRoot: string;          // Git repository root
}
```

**Parameter Schema Pattern** with rich descriptions:

```typescript
const addTaskParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path'),
    title: z.string().describe('Task title'),
    description: z.string().describe('Task description'),
    files: z.array(z.string()).optional().describe('Related file paths'),
    docs: z.array(z.string()).optional().describe('Documentation paths'),
  })
  .describe('Add a new task to an existing plan');
```

**Delegation Pattern** - Registration file acts as thin adapter:

```typescript
// In generate_mode.ts
execute: async (args, execContext) => {
  try {
    return await mcpAddTask(args, context, {
      log: wrapLogger(execContext.log, '[add-task] '),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(message);
  }
}

// In commands/add-task.ts
export async function mcpAddTask(
  args: AddTaskArguments,
  context: GenerateModeRegistrationContext,
  execContext: { log: GenerateModeExecutionLogger }
): Promise<string> {
  const { plan, planPath } = await resolvePlan(args.plan, context);
  
  const newTask = {
    title: args.title,
    description: args.description,
    done: false,
    files: args.files || [],
    docs: args.docs || [],
    steps: [],
  };
  
  plan.tasks.push(newTask);
  plan.updatedAt = new Date().toISOString();
  
  await writePlanFile(planPath, plan);
  
  const relativePath = path.relative(context.gitRoot, planPath) || planPath;
  return `Added task "${args.title}" to plan ${plan.id}`;
}
```

**Error Handling** - Two-tier approach:
1. Registration level wraps errors in `UserError` for friendly messages to LLM
2. Handler level catches and provides descriptive context

**Plan Resolution** (from `src/rmplan/plan_display.ts`):

```typescript
export async function resolvePlan(
  planArg: string,
  context: PlanDisplayContext
): Promise<{ plan: PlanSchema; planPath: string }> {
  const planPath = await resolvePlanFile(planArg, context.configPath);
  const plan = await readPlanFile(planPath);
  return { plan, planPath };
}
```

**Logger Wrapping** for better debugging:

```typescript
function wrapLogger(log: GenerateModeExecutionLogger, prefix: string): GenerateModeExecutionLogger {
  return {
    debug: (message, data) => log.debug(`${prefix}${message}`, data),
    error: (message, data) => log.error(`${prefix}${message}`, data),
    info: (message, data) => log.info(`${prefix}${message}`, data),
    warn: (message, data) => log.warn(`${prefix}${message}`, data),
  };
}
```

**Existing MCP Tool Example** - `update-plan-tasks` (from `src/rmplan/commands/update.ts`):
- Uses `mergeTasksIntoPlan()` to merge new tasks while preserving completed ones
- Updates metadata timestamps automatically
- Returns descriptive string about what was changed

#### Interactive Prompts and Editor Integration (from Explore Agent 4)

The codebase uses **@inquirer/prompts** extensively for interactive CLI features.

**Primary Imports**:
- `input` - Single-line text input
- `confirm` - Yes/No confirmation dialogs
- `select` - Single selection from a list
- `checkbox` - Multi-selection from a list
- `editor` - Multi-line text editing in external editor

**Confirmation Pattern** (from `src/rmplan/commands/assignments.ts` lines 332-335):

```typescript
let proceed = Boolean(options.yes);
if (!proceed) {
  proceed = await confirm({
    message: 'Remove the stale assignments listed above?',
    default: false,
  });
}

if (!proceed) {
  warn('Aborted stale assignment cleanup.');
  return;
}
```

Always check for `--yes` flag first, then prompt if interactive.

**Single Selection** (from `src/rmplan/commands/description.ts` lines 321-329):

```typescript
const action = await select({
  message: 'What would you like to do with the generated description?',
  choices: [
    { name: 'Copy to clipboard', value: 'copy' },
    { name: 'Save to file', value: 'save' },
    { name: 'Create GitHub PR', value: 'pr' },
    { name: 'None (just display)', value: 'none' },
  ],
});
```

**Multi-Selection** (from `src/rmplan/commands/review.ts` lines 807-812):

```typescript
const selectedIssues = await checkbox({
  message: `Select issues to ${purpose}:`,
  choices: options,  // Options have 'checked: true' for pre-selection
  pageSize: 15,
  loop: false,
});
```

**Editor Integration** - Two approaches:

1. **@inquirer/prompts editor()** (from `src/rmplan/executors/claude_code.ts` lines 738-742):
```typescript
userFeedback = await editor({
  message: `Please provide your feedback on the reviewer's analysis:`,
  default: '',
  waitForUseInput: false,
});
```

2. **External editor spawn** (from `src/rmplan/commands/add.ts` lines 195-200):
```typescript
if (options.edit) {
  const editor = process.env.EDITOR || 'nano';
  const editorProcess = Bun.spawn([editor, filePath], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  await editorProcess.exited;
}
```

**Interactive Environment Detection** (from `src/rmplan/commands/review.ts` line 170):

```typescript
const isInteractiveEnv = process.env.RMPLAN_INTERACTIVE !== '0';

if (isInteractiveEnv) {
  action = await select({
    message: 'Issues were found during review. What would you like to do?',
    // ... choices ...
  });
} else {
  log(chalk.gray('Non-interactive environment detected; skipping fix/cleanup prompts.'));
}
```

**Advanced Patterns**:
- Dynamic pageSize based on terminal height: `pageSize: Math.min(15, process.stdout.rows - 5)`
- Pre-selection of important items: `checked: severity === 'critical' || severity === 'major'`
- Graceful cancellation handling: catch `ExitPromptError`

**Utility Functions for Task Selection** (could be added to `src/rmplan/utils/task_operations.ts`):

```typescript
export function findTaskByTitle(tasks: Task[], title: string): number {
  return tasks.findIndex(t => 
    t.title.toLowerCase().includes(title.toLowerCase())
  );
}

export async function selectTaskInteractive(tasks: Task[]): Promise<number> {
  const choices = tasks.map((task, idx) => ({
    name: `${idx}: ${task.title}${task.done ? ' ✓' : ''}`,
    value: idx,
  }));
  
  const index = await select({
    message: 'Select a task:',
    choices,
  });
  
  return index;
}
```

#### Testing Patterns (from Explore Agent 5)

**Standard Setup Pattern** (all tests follow this):

```typescript
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('CommandName', () => {
  let tempDir: string;
  let tasksDir: string;
  
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    
    // Mock dependencies
    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {})
    }));
    
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { tasks: tasksDir },
        models: {},
      }),
    }));
    
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));
  });
  
  afterEach(async () => {
    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
```

**Critical Testing Principles**:
- ✅ Use **real filesystem operations** with temp directories
- ✅ Use `ModuleMocker` for all module mocking (Bun's `mock.module()` has issues)
- ✅ Call `clearPlanCache()` in `beforeEach` to avoid cross-test contamination
- ✅ Clean up temp directories in `afterEach`
- ✅ Use real plan I/O functions (`readPlanFile`, `writePlanFile`)
- ✅ Mock logging to suppress output during tests
- ❌ DON'T mock filesystem operations
- ❌ DON'T over-mock - prefer real implementations

**Test Helper Pattern** (from integration tests):

```typescript
async function createPlanFile(plan: PlanSchema & { filename: string }) {
  const filePath = path.join(tasksDir, plan.filename);
  const planData: any = {
    id: plan.id,
    title: plan.title,
    goal: plan.goal || 'Test goal',
    status: plan.status || 'pending',
    tasks: plan.tasks || [],
  };
  
  await fs.writeFile(filePath, yaml.stringify(planData), 'utf-8');
}
```

**Verification Pattern**:

```typescript
test('command modifies plan correctly', async () => {
  // Setup
  const planFile = path.join(tasksDir, '1.yml');
  await writePlanFile(planFile, initialPlan);
  
  // Execute command
  await handleCommand(planFile, options, command);
  
  // Verify
  const updated = await readPlanFile(planFile);
  expect(updated.status).toBe('in_progress');
  expect(updated.tasks[0].done).toBe(true);
});
```

**Mocking Interactive Prompts**:

```typescript
// Mock confirmation
await moduleMocker.mock('@inquirer/prompts', () => ({
  confirm: mock(async () => true),
}));

// Mock selection
await moduleMocker.mock('@inquirer/prompts', () => ({
  select: mock(async () => 'generate'),
}));

// Mock checkbox
await moduleMocker.mock('@inquirer/prompts', () => ({
  checkbox: mock(async () => [0, 2]), // Returns selected indices
}));

// Simulate cancellation
await moduleMocker.mock('@inquirer/prompts', () => ({
  checkbox: mock(async () => {
    throw new Error('Canceled');
  }),
}));
```

**Coverage Expectations** (from `done.test.ts` as example):

```typescript
describe('handleDoneCommand', () => {
  test('calls markStepDone with correct parameters for single step');
  test('calls markStepDone with multiple steps');
  test('calls markStepDone with task flag');
  test('calls markStepDone with commit flag');
  test('releases workspace lock when plan is complete');
  test('does not release workspace lock when plan is not complete');
  test('handles errors from markStepDone');
  test('handles non-existent plan file');
});
```

Test coverage should include:
1. Happy path - Normal successful execution
2. Edge cases - Empty inputs, boundary conditions
3. Error handling - Invalid inputs, missing files
4. State transitions - Plan status changes
5. Option combinations - Flag interactions

### Risks & Constraints

**Architectural Constraints**:
- Must maintain backward compatibility with existing plan file schema
- Cannot break existing MCP tools that read/write tasks
- Must preserve parent-child relationship updates (see Pattern from add.ts lines 160-185)

**Edge Cases to Handle**:
- Task index out of bounds in remove-task
- Removing last task vs removing from middle
- Title search returning multiple matches
- Title search returning no matches
- Adding task to non-existent plan
- Interactive mode in non-TTY environment

**Testing Constraints**:
- Must use ModuleMocker for module mocking (Bun limitation)
- Must use real filesystem operations
- Must clear plan cache between tests
- Must mock logging to avoid test output noise

**MCP Integration Risks**:
- FastMCP requires specific error handling (UserError for friendly messages)
- Zod schema validation must be comprehensive
- Return values must be descriptive strings (shown to LLM)

**Plan File Schema Constraints**:
- `tasks` field is required (can be empty array)
- Task must have `title` and `description`
- Optional fields (`files`, `docs`, `examples`) default to empty arrays
- `updatedAt` timestamp must be updated on every modification
- Plan cache must be cleared when reading updated plans

### Follow-up Questions

None - all necessary information has been gathered from the codebase exploration. The implementation can proceed with confidence following the established patterns.

# Implementation Notes

Implemented shared task operations utilities (findTaskByTitle, selectTaskInteractive, promptForTaskInfo) in src/rmplan/utils/task_operations.ts to centralize task search and interactive prompting logic used by new features. Added rmplan add-task (src/rmplan/commands/add-task.ts) and rmplan remove-task (src/rmplan/commands/remove-task.ts) commands with CLI wiring, non-interactive flag handling, editor support, confirmation prompts, and shared normalization of files/docs metadata. Extended MCP generate_mode (src/rmplan/mcp/generate_mode.ts) with add-plan-task and remove-plan-task tools, including Zod schemas, task creation/removal helpers, and log instrumentation; updated CLI registration in src/rmplan/rmplan.ts. Created comprehensive unit tests for utilities, commands, and MCP helpers across src/rmplan/utils/task_operations.test.ts, src/rmplan/commands/add-task.test.ts, src/rmplan/commands/remove-task.test.ts, and src/rmplan/mcp/generate_mode.test.ts to cover happy paths, interactive flows, edge cases, and error handling. Covered plan tasks: 'Create shared task utilities module', 'Implement add-task command handler', 'Implement remove-task command handler', and associated MCP/tooling test tasks.

Documented the new task management commands by expanding README.md: added narrative coverage in the Additional Commands section explaining how `rmplan add-task` normalizes metadata across editor, inline, and interactive flows, and how `rmplan remove-task` supports index/title/interactive selection with safety prompts. Added cheat sheet entries showing representative `rmplan add-task`/`rmplan remove-task` invocations so operators have copy-paste ready examples. This fulfills plan task 'Update documentation' and keeps the CLI reference in sync with the new utilities and command handlers.

Documented the rmplan add-task and remove-task commands accurately for the Update documentation task. Updated README.md to describe the real flag combinations, spelling out that add-task requires --title with either --description or --editor unless --interactive is used, plus optional --files/--docs metadata, and that remove-task needs exactly one of --index/--title/--interactive (with --yes to skip confirmation). Refined the CLI cheat sheet examples so they demonstrate the supported syntax, including editor launch, inline metadata, title matching, and zero-based index removal. This keeps the user-facing guidance in sync with the command implementations and prevents confusion about unsupported flags.

Implemented Task 11: Integration testing and Task 12: Update documentation. Created src/rmplan/commands/task-management.integration.test.ts to exercise add-task/remove-task workflows end-to-end, covering CLI add+show, CLI remove+show with warning checks, CLI round-trip add/remove symmetry, MCP add-plan-task/remove-plan-task sequencing, and mixed CLI/MCP flows. The suite sets up temporary task directories with ModuleMocker stubs for logging, config loading, git root resolution, assignments, and clipboard to keep handlers deterministic, then asserts both plan file mutations and command output. Updated README.md with an explicit command list for add-task/remove-task, a task-management workflow snippet, and expanded MCP server documentation that details the new add-plan-task and remove-plan-task tools with parameter guidance and index-shift warnings. Extended CLAUDE.md to document the shared task_operations utility module and to call out the new integration suite as required coverage when modifying task management features. Verified changes with bun run check and bun test to ensure the new tests pass alongside the existing suite.
