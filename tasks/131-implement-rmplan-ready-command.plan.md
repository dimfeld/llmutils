---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Implement rmplan ready command
goal: ""
id: 131
status: pending
priority: medium
temp: false
parent: 128
createdAt: 2025-10-26T22:41:07.692Z
updatedAt: 2025-10-26T22:41:07.694Z
tasks: []
---

## Overview

Create a new `rmplan ready` command that shows a detailed, prioritized view of all plans that are ready to execute. This is more agent-friendly than `rmplan list --status ready` because it provides context about why each plan is ready and sorts by priority to help agents choose what to work on next.

## Difference from `rmplan list --status ready`

The `list` command shows a table view with limited information. The new `ready` command will:

1. **Show more context**: Display why each plan is ready (dependencies completed)
2. **Better sorting**: Default sort by priority (urgent → high → medium → low), then by ID
3. **Detailed output**: Show tasks count, dependency summary, and readiness reason
4. **Agent-optimized**: Formatted for easy parsing and decision-making

## Implementation

### Create New Command Handler

File: `src/rmplan/commands/ready.ts`

```typescript
import chalk from 'chalk';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir } from '../configSchema.js';
import { getCombinedTitle } from '../display_utils.js';
import { isPlanReady, readAllPlans } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';

type PlanWithFilename = PlanSchema & { filename: string };

export async function handleReadyCommand(options: any, command: any) {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const tasksDir = await resolveTasksDir(config);
  const { plans } = await readAllPlans(tasksDir);

  // Filter to ready plans
  const readyPlans = Array.from(plans.values())
    .filter((plan) => isPlanReady(plan, plans));

  if (readyPlans.length === 0) {
    log('No plans are currently ready to execute.');
    log('All pending plans have incomplete dependencies.');
    return;
  }

  // Sort by priority, then by ID
  readyPlans.sort((a, b) => {
    // Priority order: urgent=5, high=4, medium=3, low=2, maybe=1
    const priorityOrder: Record<string, number> = {
      urgent: 5,
      high: 4,
      medium: 3,
      low: 2,
      maybe: 1,
    };

    const aPriority = priorityOrder[a.priority || 'medium'] || 3;
    const bPriority = priorityOrder[b.priority || 'medium'] || 3;

    if (aPriority !== bPriority) {
      return bPriority - aPriority; // Higher priority first
    }

    // Secondary sort by ID
    return (a.id || 0) - (b.id || 0);
  });

  // Apply reverse flag if specified
  if (options.reverse) {
    readyPlans.reverse();
  }

  // Display results
  log(chalk.bold(`\n✓ Ready Plans (${readyPlans.length}):\n`));
  log('─'.repeat(80));

  for (const plan of readyPlans) {
    // Plan header
    log(chalk.cyan(`\n[${plan.id}] ${getCombinedTitle(plan)}`));

    // Priority
    if (plan.priority) {
      const priorityColor = plan.priority === 'urgent' ? chalk.red :
                           plan.priority === 'high' ? chalk.rgb(255, 165, 0) :
                           plan.priority === 'medium' ? chalk.yellow :
                           plan.priority === 'low' ? chalk.blue :
                           chalk.gray;
      log(`  Priority: ${priorityColor(plan.priority)}`);
    }

    // Task count
    const taskCount = plan.tasks?.length || 0;
    log(`  Tasks: ${taskCount}`);

    // Assignment
    if (plan.assignedTo) {
      log(`  Assigned to: ${plan.assignedTo}`);
    }

    // Dependencies (all completed)
    if (plan.dependencies && plan.dependencies.length > 0) {
      const depSummary = plan.dependencies.map(id => {
        const dep = plans.get(id);
        return dep ? `${id} (${dep.status})` : `${id} (not found)`;
      }).join(', ');
      log(chalk.green(`  ✓ All dependencies done: ${depSummary}`));
    } else {
      log(chalk.gray(`  ✓ No dependencies`));
    }

    // Show file path in verbose mode
    if (options.verbose) {
      log(chalk.gray(`  File: ${plan.filename}`));
    }
  }

  log('\n' + '─'.repeat(80));
  log(`\nRun ${chalk.bold('rmplan agent <id>')} to execute a plan`);
  log(`Run ${chalk.bold('rmplan show <id>')} to see full details`);
}
```

### CLI Integration

File: `src/rmplan/rmplan.ts` (add after the `list` command, around line 414)

```typescript
program
  .command('ready')
  .description('List all plans that are ready to execute (pending with all dependencies done)')
  .option('--sort <field>', 'Sort by: priority (default), id, title, created, updated', 'priority')
  .option('--reverse', 'Reverse sort order')
  .option('-v, --verbose', 'Show additional details like file paths')
  .action(async (options, command) => {
    const { handleReadyCommand } = await import('./commands/ready.js');
    await handleReadyCommand(options, command).catch(handleCommandError);
  });
```

## Example Output

```
✓ Ready Plans (3):

────────────────────────────────────────────────────────────────────────────────

[42] Add authentication to API endpoints
  Priority: high
  Tasks: 5
  ✓ All dependencies done: 38 (done), 39 (done)

[55] Refactor database connection pooling
  Priority: medium
  Tasks: 3
  Assigned to: alice
  ✓ No dependencies

[61] Update documentation for API changes
  Priority: low
  Tasks: 2
  ✓ All dependencies done: 42 (done)

────────────────────────────────────────────────────────────────────────────────

Run rmplan agent <id> to execute a plan
Run rmplan show <id> to see full details
```

## Testing

### Manual Testing

1. **Empty state**: No ready plans
   ```bash
   rmplan ready
   # Should show: "No plans are currently ready to execute"
   ```

2. **Multiple ready plans**: Create test plans with various priorities
   ```bash
   rmplan add "High priority task" -p high
   rmplan add "Low priority task" -p low
   rmplan add "Urgent task" -p urgent
   rmplan ready
   # Should show urgent first, then high, then low
   ```

3. **Sorting options**:
   ```bash
   rmplan ready --sort id
   rmplan ready --sort title
   rmplan ready --reverse
   ```

4. **With dependencies**: Create plans with completed dependencies
   ```bash
   rmplan add "Plan A" --status done
   rmplan add "Plan B" -d 1  # Should show as ready
   rmplan ready
   # Should show Plan B with "All dependencies done: 1 (done)"
   ```

### Automated Tests

File: `src/rmplan/commands/ready.test.ts`

Tests to add:
1. Returns empty when no plans are ready
2. Filters correctly (only pending plans with completed dependencies)
3. Default sort by priority works correctly
4. Custom sort fields work (id, title, etc.)
5. Reverse flag works
6. Verbose mode shows file paths

## User Experience Benefits

For autonomous agents:
- Quick answer to "What should I work on next?"
- Priority-sorted output helps with decision making
- Dependency context shows why each plan is ready
- Can be easily parsed by scripts or agents

For human users:
- Better than scanning the full list output
- Clear indication of what's unblocked
- Easy to see high-priority ready work

## Dependencies

No dependencies - uses existing `isPlanReady()` function from plans.ts.

## MCP Integration

Add a new MCP tool to query ready plans programmatically:

File: `src/rmplan/mcp/generate_mode.ts`

```typescript
export const listReadyPlansParameters = z
  .object({
    limit: z.number().optional().describe('Limit number of results (default: 10)'),
    sortBy: z.enum(['priority', 'id', 'created']).optional().describe('Sort field (default: priority)'),
  })
  .describe('List all plans that are ready to execute');

export async function handleListReadyPlansTool(
  args: { limit?: number; sortBy?: string },
  context: GenerateModeRegistrationContext
): Promise<string> {
  const tasksDir = await resolveTasksDir(context.config);
  const { plans } = await readAllPlans(tasksDir);
  
  const readyPlans = Array.from(plans.values())
    .filter((plan) => isPlanReady(plan, plans))
    .sort(/* priority sorting logic */)
    .slice(0, args.limit || 10);
  
  if (readyPlans.length === 0) {
    return 'No plans are currently ready to execute.';
  }
  
  return readyPlans
    .map(p => `- [${p.id}] ${p.title || p.goal} (${p.priority || 'medium'})`)
    .join('\n');
}
```

Register in `registerGenerateMode()`:
```typescript
server.addTool({
  name: 'list-ready-plans',
  description: 'List all plans that are ready to execute (pending with dependencies done)',
  parameters: listReadyPlansParameters,
  annotations: { destructiveHint: false, readOnlyHint: true },
  execute: async (args) => handleListReadyPlansTool(args, context),
});
```

This allows agents to programmatically query `"What should I work on next?"` via MCP.
