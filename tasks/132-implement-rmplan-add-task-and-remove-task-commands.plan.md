---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Implement rmplan add-task and remove-task commands
goal: ""
id: 132
uuid: 7ebf9d14-805e-4178-83a7-a1e91154de23
status: pending
priority: medium
temp: false
parent: 128
createdAt: 2025-10-26T22:41:12.354Z
updatedAt: 2025-10-27T08:39:04.274Z
tasks: []
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
