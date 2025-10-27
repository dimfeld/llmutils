---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Implement rmplan ready command
goal: Implement rmplan ready command with multi-format output and MCP integration
id: 131
generatedBy: agent
status: in_progress
priority: medium
container: false
temp: false
dependencies: []
parent: 128
issue: []
pullRequest: []
docs: []
planGeneratedAt: 2025-10-26T23:45:48.368Z
promptsGeneratedAt: 2025-10-26T23:45:48.368Z
createdAt: 2025-10-26T22:41:07.692Z
updatedAt: 2025-10-27T06:24:29.901Z
progressNotes:
  - timestamp: 2025-10-27T06:06:45.805Z
    text: Successfully implemented rmplan ready command with all three output
      formats (list, table, json), complete CLI registration, and MCP tool
      integration. The command filters plans by status (pending/in_progress),
      checks dependency completion, and supports sorting by
      priority/id/title/created/updated with optional filters by priority and
      pending-only flag. All type checking and linting passed.
    source: "implementer: tasks 1-6"
  - timestamp: 2025-10-27T06:15:03.629Z
    text: "Created comprehensive test suites for rmplan ready command and MCP
      list-ready-plans tool. All 20 CLI tests and 11 MCP tests passing. Key
      learnings: (1) Priority sorting defaults to ascending order (low to high),
      use --reverse for descending, (2) Must set config.paths.tasks (not
      config.tasksDir) in tests to avoid resolveTasksDir finding real git root,
      (3) writePlanFile auto-sets updatedAt timestamp even if not provided.
      Tests cover all specified cases including filtering, sorting, output
      formats, edge cases, and dependency handling."
    source: "tester: tasks 7-8"
  - timestamp: 2025-10-27T06:19:26.079Z
    text: >-
      Reviewer identified 3 critical issues that must be fixed before marking
      tasks done:

      1. Priority sort order is backwards (shows low priority first instead of
      urgent first)

      2. Inconsistent readiness logic (custom isReadyPlan vs existing
      isPlanReady with different semantics)

      3. Missing input validation for CLI options


      Also identified: missing README documentation (task 9), code duplication
      in sorting logic, hardcoded table widths, and type safety issues.


      Will proceed with implementer to fix critical issues.
    source: "orchestrator: review phase"
  - timestamp: 2025-10-27T06:24:29.897Z
    text: >-
      Fixed critical issues from code review:

      - Fixed backwards priority sorting (now descending:
      urgent→high→medium→low)

      - Added input validation for --format, --sort, and --priority options

      - Added comment explaining custom readiness logic vs isPlanReady()

      - Replaced 'any' types with proper TypeScript types (ReadyCommandOptions,
      TableUserConfig)

      - Added responsive column widths for table format using
      process.stdout.columns

      - Updated test expectations to match corrected priority sort order

      All tests pass (20/20) and type checking passes with no errors.
    source: "implementer: code review fixes"
tasks:
  - title: Create ready command handler with filtering logic
    done: false
    description: >-
      Create `src/rmplan/commands/ready.ts` with the core command handler.


      **Implementation details:**

      - Export `handleReadyCommand(options, command)` function

      - Load config with `loadEffectiveConfig(globalOpts.config)`

      - Resolve tasks directory with `resolveTasksDir(config)`

      - Load all plans with `readAllPlans(tasksDir)`

      - Filter for ready plans using custom logic that checks:
        - Status is `pending` OR `in_progress` (not done/cancelled/deferred)
        - Has at least one task (`plan.tasks.length > 0`)
        - All dependencies have status `done` (use `isPlanReady()` as reference but modify for in_progress)
      - Support `--pending-only` flag to restrict to pending plans only

      - Apply optional priority filter if specified

      - Sort by priority (urgent→high→medium→low→undefined) then by ID

      - Support `--sort` option for alternative sorting (id, title, created,
      updated)

      - Support `--reverse` flag to invert sort order


      **Key imports:**

      ```typescript

      import { log } from '../../logging.js';

      import chalk from 'chalk';

      import { loadEffectiveConfig } from '../configLoader.js';

      import { resolveTasksDir } from '../configSchema.js';

      import { readAllPlans } from '../plans.js';

      import type { PlanSchema } from '../planSchema.js';

      import { getCombinedTitle } from '../display_utils.js';

      ```


      **Priority sorting logic** (reference list.ts:127-142):

      ```typescript

      const priorityOrder: Record<string, number> = {
        urgent: 5,
        high: 4,
        medium: 3,
        low: 2,
        maybe: 1,
      };

      ```
    files: []
    docs: []
    steps: []
  - title: Implement list format output (default)
    done: false
    description: |-
      Add list format output function to `ready.ts` that displays plans in a human-friendly format.

      **Format specification:**
      ```
      ✓ Ready Plans (3):

      ────────────────────────────────────────────────────────────────────────────────

      [42] Add authentication to API endpoints
        Status: pending
        Priority: high
        Tasks: 5 (2 done)
        Assigned to: alice
        ✓ All dependencies done: 38 (done), 39 (done)

      [55] Refactor database connection pooling
        Status: in_progress
        Priority: medium
        Tasks: 3 (1 done)
        ✓ No dependencies

      ────────────────────────────────────────────────────────────────────────────────

      Run rmplan agent <id> to execute a plan
      Run rmplan show <id> to see full details
      ```

      **Implementation:**
      - Use chalk colors following established conventions:
        - Status: pending=white, in_progress=yellow
        - Priority: urgent=red, high=orange(255,165,0), medium=yellow, low=blue
        - Dependencies: green for ✓, gray for plan IDs
      - Show task completion ratio: `5 (2 done)` or just `5` if none done
      - Display dependency summary with status indicators
      - Support `--verbose` flag to show file paths
      - Add helpful usage hints at bottom
    files: []
    docs: []
    steps: []
  - title: Implement table format output
    done: false
    description: >-
      Add table format output function to `ready.ts` for compact display similar
      to `rmplan list`.


      **Table structure:**

      - Columns: ID | Title | Status | Priority | Tasks | Deps

      - Use `table` package with box-drawing characters

      - Apply same color scheme as list format

      - Calculate responsive column widths based on terminal size

      - Word-wrap title column for long titles


      **Reference:** See `src/rmplan/commands/list.ts:306-359` for table
      configuration


      **Implementation:**

      ```typescript

      import { table } from 'table';


      const tableData = [
        ['ID', 'Title', 'Status', 'Priority', 'Tasks', 'Deps'],
        ...readyPlans.map(plan => [
          plan.id.toString(),
          getCombinedTitle(plan),
          formatStatus(plan.status),
          formatPriority(plan.priority),
          formatTaskCount(plan.tasks),
          formatDependencies(plan.dependencies, plans),
        ]),
      ];


      log(table(tableData, config));

      ```
    files: []
    docs: []
    steps: []
  - title: Implement JSON format output
    done: false
    description: >-
      Add JSON format output function to `ready.ts` for programmatic
      consumption.


      **JSON structure:**

      ```json

      {
        "count": 3,
        "plans": [
          {
            "id": 42,
            "title": "Add authentication to API endpoints",
            "goal": "Ship a high-quality feature",
            "priority": "high",
            "status": "pending",
            "taskCount": 5,
            "completedTasks": 2,
            "dependencies": [38, 39],
            "assignedTo": "alice",
            "filename": "tasks/42-add-auth.plan.md",
            "createdAt": "2025-01-15T10:30:00Z",
            "updatedAt": "2025-01-20T14:22:00Z"
          }
        ]
      }

      ```


      **Implementation:**

      - Convert plan objects to simplified JSON structure

      - Include only relevant fields (exclude internal details, large markdown)

      - Use relative paths for filenames (relative to git root)

      - Output pretty-printed JSON with 2-space indentation

      - Ensure valid JSON (handle undefined/null fields)


      **Helper function:**

      ```typescript

      function formatPlanForJson(plan: PlanSchema & { filename: string },
      gitRoot: string) {
        const taskCount = plan.tasks?.length || 0;
        const completedTasks = plan.tasks?.filter(t => t.done).length || 0;
        
        return {
          id: plan.id,
          title: plan.title || plan.goal || '',
          goal: plan.goal || '',
          priority: plan.priority,
          status: plan.status,
          taskCount,
          completedTasks,
          dependencies: plan.dependencies || [],
          assignedTo: plan.assignedTo,
          filename: path.relative(gitRoot, plan.filename),
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        };
      }

      ```
    files: []
    docs: []
    steps: []
  - title: Register ready command in CLI
    done: false
    description: >-
      Add command registration to `src/rmplan/rmplan.ts` following the
      established pattern.


      **Location:** After the `list` command (around line 414)


      **Implementation:**

      ```typescript

      program
        .command('ready')
        .description('List all plans that are ready to execute (pending/in_progress with dependencies done)')
        .option('--format <format>', 'Output format: list (default), table, json', 'list')
        .option('--sort <field>', 'Sort by: priority (default), id, title, created, updated', 'priority')
        .option('--reverse', 'Reverse sort order')
        .option('--pending-only', 'Show only pending plans (exclude in_progress)')
        .option('--priority <priority>', 'Filter by priority: low, medium, high, urgent')
        .option('-v, --verbose', 'Show additional details like file paths')
        .action(async (options, command) => {
          const { handleReadyCommand } = await import('./commands/ready.js');
          await handleReadyCommand(options, command).catch(handleCommandError);
        });
      ```


      **Validation:**

      - Validate `--format` is one of: list, table, json

      - Validate `--sort` is one of: priority, id, title, created, updated

      - Validate `--priority` is valid priority value if specified

      - All errors handled by `handleCommandError`
    files: []
    docs: []
    steps: []
  - title: Add MCP tool for list-ready-plans
    done: false
    description: >-
      Implement MCP tool in `src/rmplan/mcp/generate_mode.ts` for programmatic
      access to ready plans.


      **Step 1: Define parameter schema** (add near line 420):

      ```typescript

      export const listReadyPlansParameters = z
        .object({
          priority: prioritySchema
            .optional()
            .describe('Filter by priority level (low|medium|high|urgent)'),
          limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Maximum number of plans to return (default: all)'),
          pendingOnly: z
            .boolean()
            .optional()
            .default(false)
            .describe('Show only pending plans, exclude in_progress (default: false)'),
          sortBy: z
            .enum(['priority', 'id', 'title', 'created', 'updated'])
            .optional()
            .default('priority')
            .describe('Sort field (default: priority)'),
        })
        .describe('List all ready plans that can be executed');

      export type ListReadyPlansArguments = z.infer<typeof
      listReadyPlansParameters>;

      ```


      **Step 2: Implement handler function** (add before
      `registerGenerateMode`):

      ```typescript

      export async function handleListReadyPlansTool(
        args: ListReadyPlansArguments,
        context: GenerateModeRegistrationContext
      ): Promise<string> {
        const tasksDir = await resolveTasksDir(context.config);
        const { plans } = await readAllPlans(tasksDir);

        // Filter for ready plans (same logic as CLI command)
        let readyPlans = Array.from(plans.values()).filter((plan) => {
          const status = plan.status || 'pending';
          const statusMatch = args.pendingOnly 
            ? status === 'pending'
            : (status === 'pending' || status === 'in_progress');
          
          if (!statusMatch) return false;
          if (!plan.tasks || plan.tasks.length === 0) return false;
          
          // Check dependencies
          if (!plan.dependencies || plan.dependencies.length === 0) return true;
          return plan.dependencies.every(depId => {
            const dep = plans.get(depId);
            return dep && dep.status === 'done';
          });
        });

        // Apply filters
        if (args.priority) {
          readyPlans = readyPlans.filter((p) => p.priority === args.priority);
        }

        // Sort (reuse sorting logic from CLI)
        readyPlans.sort(/* sorting logic */);

        // Apply limit
        if (args.limit && args.limit > 0) {
          readyPlans = readyPlans.slice(0, args.limit);
        }

        // Format as JSON
        const result = {
          count: readyPlans.length,
          plans: readyPlans.map(plan => ({
            id: plan.id,
            title: plan.title || plan.goal || '',
            goal: plan.goal || '',
            priority: plan.priority,
            status: plan.status,
            taskCount: plan.tasks?.length || 0,
            completedTasks: plan.tasks?.filter(t => t.done).length || 0,
            dependencies: plan.dependencies || [],
            assignedTo: plan.assignedTo,
            filename: path.relative(context.gitRoot, plan.filename),
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
          })),
        };

        return JSON.stringify(result, null, 2);
      }

      ```


      **Step 3: Register tool** (add in `registerGenerateMode` function around
      line 680):

      ```typescript

      server.addTool({
        name: 'list-ready-plans',
        description:
          'List all plans that are ready to be executed. A plan is ready when it has status ' +
          '"pending" or "in_progress", contains tasks, and all its dependencies are marked as ' +
          '"done". Returns JSON with plan details including ID, title, priority, task counts, and dependencies.',
        parameters: listReadyPlansParameters,
        annotations: {
          destructiveHint: false,
          readOnlyHint: true,
        },
        execute: async (args) => handleListReadyPlansTool(args, context),
      });

      ```
    files: []
    docs: []
    steps: []
  - title: Write comprehensive tests for ready command
    done: false
    description: >-
      Create `src/rmplan/commands/ready.test.ts` with comprehensive test
      coverage.


      **Test setup pattern** (reference list.test.ts):

      ```typescript

      import { describe, test, expect, beforeEach, afterEach, mock } from
      'bun:test';

      import { ModuleMocker } from '../../testing.js';

      import * as fs from 'node:fs/promises';

      import * as os from 'node:os';

      import * as path from 'path';

      import { mkdtemp } from 'node:fs/promises';

      import yaml from 'yaml';

      import { clearPlanCache } from '../plans.js';

      import type { PlanSchema } from '../planSchema.js';


      const moduleMocker = new ModuleMocker();

      let tmpDir: string;

      let mockLog: any;

      let mockWarn: any;


      beforeEach(async () => {
        clearPlanCache();
        tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rmplan-ready-test-'));
        
        mockLog = mock(() => {});
        mockWarn = mock(() => {});
        
        await moduleMocker.mock('../../logging.js', () => ({
          log: mockLog,
          warn: mockWarn,
          debugLog: mock(() => {}),
        }));
        
        // Mock chalk to strip colors
        await moduleMocker.mock('chalk', () => ({ /* ... */ }));
        
        // Mock config
        await moduleMocker.mock('../configLoader.js', () => ({
          loadEffectiveConfig: mock(() => ({ tasksDir: tmpDir })),
        }));
      });


      afterEach(() => {
        moduleMocker.clear();
      });

      ```


      **Test cases to implement:**


      1. **Shows all ready pending plans**
         - Create 2 pending plans with tasks and no dependencies
         - Verify both appear in output
         - Check default format is list

      2. **Shows all ready in_progress plans**
         - Create 1 in_progress plan with tasks and no dependencies
         - Verify it appears in output
         - Check status displayed correctly

      3. **Excludes in_progress with --pending-only flag**
         - Create 1 pending and 1 in_progress plan
         - Run with `--pending-only`
         - Verify only pending plan shown

      4. **Shows empty when no plans are ready**
         - Create only done/cancelled plans
         - Verify appropriate message shown

      5. **Filters by priority correctly**
         - Create plans with different priorities
         - Run with `--priority high`
         - Verify only high priority plans shown

      6. **Sorts by priority correctly**
         - Create plans: urgent, low, high, medium
         - Verify output order: urgent, high, medium, low

      7. **Sorts by alternative fields (id, title, created)**
         - Test `--sort id`, `--sort title`, `--sort created`
         - Verify correct ordering for each

      8. **Reverse flag works**
         - Create plans with different priorities
         - Run with `--reverse`
         - Verify order is inverted

      9. **Excludes plans without tasks**
         - Create plan with empty tasks array
         - Verify it doesn't appear

      10. **Excludes plans with incomplete dependencies**
          - Create plan A (pending), plan B (depends on A)
          - Verify plan B not shown
          - Mark A as done, verify B now shown

      11. **Shows plans with all dependencies done**
          - Create plans A, B (done), C (depends on A,B)
          - Verify C appears with dependency info

      12. **Table format works**
          - Run with `--format table`
          - Verify table structure

      13. **JSON format works**
          - Run with `--format json`
          - Parse output as JSON
          - Verify structure matches spec
          - Check all required fields present

      14. **Verbose mode shows file paths**
          - Run with `--verbose`
          - Verify file paths in output

      15. **Handles edge cases**
          - Plans with no priority (should default to medium for sorting)
          - Plans with 'maybe' priority (should be included)
          - Circular dependencies (should not crash)
          - Missing dependency plans (should handle gracefully)
    files: []
    docs: []
    steps: []
  - title: Write tests for MCP list-ready-plans tool
    done: false
    description: >-
      Add tests to `src/rmplan/mcp/generate_mode.test.ts` for the new MCP tool.


      **Test cases:**


      1. **Returns all ready plans as JSON**
         - Create test plans in temp directory
         - Call `handleListReadyPlansTool()`
         - Parse JSON response
         - Verify structure and content

      2. **Respects priority filter**
         - Create plans with mixed priorities
         - Call with `priority: 'high'`
         - Verify only high priority in response

      3. **Respects limit parameter**
         - Create 5 ready plans
         - Call with `limit: 3`
         - Verify response has exactly 3 plans

      4. **Respects pendingOnly flag**
         - Create pending and in_progress plans
         - Call with `pendingOnly: true`
         - Verify only pending in response

      5. **Returns empty result when no ready plans**
         - Create only blocked/done plans
         - Call tool
         - Verify `count: 0` and `plans: []`

      6. **Sorts by priority correctly**
         - Create plans with different priorities
         - Call with `sortBy: 'priority'`
         - Verify order in JSON response

      7. **Includes all required fields**
         - Verify JSON has: id, title, goal, priority, status, taskCount, completedTasks, dependencies, assignedTo, filename, createdAt, updatedAt

      8. **Calculates task counts correctly**
         - Create plan with 5 tasks, 2 done
         - Verify `taskCount: 5` and `completedTasks: 2`

      9. **Handles missing optional fields**
         - Create plan without priority, assignedTo
         - Verify fields are undefined/null in JSON

      **Example test:**

      ```typescript

      test('handleListReadyPlansTool returns JSON with ready plans', async () =>
      {
        const plan: PlanSchema = {
          id: 1,
          goal: 'Test plan',
          status: 'pending',
          priority: 'high',
          tasks: [{ title: 'Task 1', description: 'Desc', done: false }],
          dependencies: [],
          createdAt: new Date().toISOString(),
        };
        
        await fs.writeFile(
          path.join(tmpDir, '1-test.yml'),
          yaml.stringify(plan)
        );
        
        const result = await handleListReadyPlansTool(
          { pendingOnly: false },
          context
        );
        
        const parsed = JSON.parse(result);
        expect(parsed.count).toBe(1);
        expect(parsed.plans[0].id).toBe(1);
        expect(parsed.plans[0].priority).toBe('high');
        expect(parsed.plans[0].taskCount).toBe(1);
      });

      ```
    files: []
    docs: []
    steps: []
  - title: Update README with ready command documentation
    done: false
    description: >-
      Add documentation for the new `rmplan ready` command to the README.md
      file.


      **Location:** In the Commands section, after the `list` command
      documentation


      **Content to add:**

      ```markdown

      ### `rmplan ready`


      List all plans that are ready to execute - plans with status `pending` or
      `in_progress` that have all dependencies completed.


      **Basic usage:**

      ```bash

      # Show all ready plans (default: list format)

      rmplan ready


      # Show only pending (exclude in_progress)

      rmplan ready --pending-only


      # Filter by priority

      rmplan ready --priority high


      # Different output formats

      rmplan ready --format table

      rmplan ready --format json


      # Sort options

      rmplan ready --sort id

      rmplan ready --sort title

      rmplan ready --reverse


      # Verbose output (shows file paths)

      rmplan ready -v

      ```


      **Output Formats:**


      - **list** (default): Human-friendly colored output with detailed plan
      information

      - **table**: Compact table view similar to `rmplan list`

      - **json**: Structured JSON for programmatic consumption


      **Readiness Criteria:**


      A plan is considered ready when:

      1. Status is `pending` or `in_progress`

      2. Has at least one task defined

      3. All dependencies (if any) have status `done`


      **MCP Integration:**


      The `list-ready-plans` MCP tool provides programmatic access:


      ```typescript

      // Returns JSON with ready plans

      {
        "count": 3,
        "plans": [
          {
            "id": 42,
            "title": "Add authentication",
            "priority": "high",
            "status": "pending",
            "taskCount": 5,
            "completedTasks": 2,
            "dependencies": [38, 39],
            ...
          }
        ]
      }

      ```


      **Parameters:**

      - `priority`: Filter by priority level

      - `limit`: Maximum number of plans to return

      - `pendingOnly`: Exclude in_progress plans

      - `sortBy`: Sort field (priority, id, title, created, updated)

      ```


      **Also update:**

      - Table of contents (add link to ready command)

      - Quick start section if relevant

      - Any command comparison tables
    files: []
    docs: []
    steps: []
changedFiles: []
rmfilter: []
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

### Summary

The `rmplan ready` command will provide an agent-optimized view of executable plans by combining existing filtering logic from `list.ts` with enhanced context about readiness. This command requires minimal new code since core utilities (`isPlanReady()`, `readAllPlans()`, sorting logic) already exist and are well-tested. The primary work is creating a new command handler with rich display formatting and registering an MCP tool for programmatic access.

**Critical discoveries:**
- The `isPlanReady()` function (plans.ts:379-411) handles all readiness logic: pending status, task presence, and dependency completion
- Priority sorting with proper ordering (urgent→high→medium→low) already exists in list.ts:127-142
- Color and formatting conventions are established across commands for consistency
- MCP integration follows a standardized pattern with Zod schemas and context passing
- Testing uses real filesystems with minimal mocking for integration confidence

### Findings

#### Subagent Report: Command Structure Analysis

**File: src/rmplan/rmplan.ts** - Main CLI entry point

Commands follow a consistent registration pattern using dynamic imports:

```typescript
program
  .command('command-name [arguments...]')
  .description('Human-readable description')
  .option('--option-name <value>', 'Option description')
  .option('--flag', 'Boolean flag description')
  .action(async (arg, options, command) => {
    const { handleCommandName } = await import('./commands/command-name.js');
    await handleCommandName(arg, options, command).catch(handleCommandError);
  });
```

**Key patterns identified:**
- Each command maps to a handler file in `src/rmplan/commands/`
- Handler names follow: `handle<CommandName>Command`
- All errors caught with `handleCommandError` for consistency
- Global options accessed via `command.parent.opts()`
- Dynamic imports inside `.action()` callbacks

**Standard handler structure:**
```typescript
export async function handleCommandName(
  planFile: string,
  options: any,
  command: any
) {
  // 1. Extract global options
  const globalOpts = command.parent.opts();
  
  // 2. Load configuration
  const config = await loadEffectiveConfig(globalOpts.config);
  
  // 3. Resolve file paths
  const tasksDir = await resolveTasksDir(config);
  
  // 4. Load plans
  const { plans } = await readAllPlans(tasksDir);
  
  // 5. Perform operation
  // ... command-specific logic
  
  // 6. Output results
  log(result);
}
```

**Common imports across commands:**
- Logging: `log`, `warn`, `debugLog` from `../../logging.js`
- Display: `chalk` for colors, `table` for formatting
- Configuration: `loadEffectiveConfig`, `resolveTasksDir`
- Plan operations: `readAllPlans`, `readPlanFile`, `writePlanFile`, `isPlanReady`
- Schemas: `prioritySchema`, `statusSchema`, `PlanSchema` types

**File organization:**
- `src/rmplan/rmplan.ts` - CLI registration (60+ commands)
- `src/rmplan/commands/` - Individual handlers (one per command)
- `src/rmplan/utils/commands.ts` - Error handling utilities
- `src/rmplan/plans.ts` - Core plan operations
- `src/rmplan/display_utils.ts` - Display helpers

#### Subagent Report: Plan Filtering and Display

**File: src/rmplan/plans.ts:379-411** - Readiness checking

The `isPlanReady()` function determines if a plan can be executed:

```typescript
export function isPlanReady(
  plan: PlanSchema & { filename: string },
  allPlans: Map<number, PlanSchema & { filename: string }>
): boolean
```

**Readiness criteria (all must be true):**
1. Status is `'pending'` (not in_progress, done, cancelled, deferred)
2. Has at least one task (`plan.tasks.length > 0`)
3. All dependencies have status `'done'` (or no dependencies)

**Implementation details:**
- Handles mixed ID types (numeric and string) with `parseInt()` fallback
- Missing dependencies treated as not ready (defensive)
- Returns boolean for simple integration

**File: src/rmplan/plans.ts:52-146** - Plan loading

`readAllPlans()` provides cached, concurrent plan loading:
- Matches `**/*.{plan.md,yml,yaml}` using Bun's Glob
- Parallel file reads with `Promise.all()`
- Caches results per directory to avoid re-scanning
- Detects duplicate IDs across files
- Normalizes numeric string IDs to numbers

**File: src/rmplan/display_utils.ts** - Title composition

Display helpers for consistent formatting:
- `getCombinedTitle()` - Combines project + phase titles
- `getCombinedGoal()` - Combines project + phase goals
- Falls back to available fields, defaults to 'Untitled'

**File: src/rmplan/commands/list.ts** - Filtering and sorting reference

**Filtering pipeline:**
1. User filter: `--user <name>` or `--mine` (env USER)
2. Search filter: Case-insensitive text matching
3. Status filter:
   - Default: pending + in_progress only
   - `--status <status>`: Explicit status
   - Special: `'ready'` uses `isPlanReady()`, `'blocked'` shows pending with incomplete deps

**Sorting logic (lines 91-156):**
- Default: `createdAt` (oldest first)
- Priority order: urgent(5) > high(4) > medium(3) > low(2) > maybe(1) > undefined(0)
- Reverse sorting: higher priorities first
- Secondary sort: Always falls back to ID
- Reverse flag: `--reverse` inverts comparison

**Color conventions (lines 205-235):**
- Status: done=green, cancelled=strikethrough gray, deferred=dim gray, ready=cyan, blocked=magenta, in_progress=yellow, pending=white
- Priority: urgent=red, high=orange(255,165,0), medium=yellow, low=blue, maybe=gray

**Dependency display (lines 239-267):**
- `✓` green: done
- `…` yellow: in_progress  
- `✗` gray: cancelled
- `(?)` gray: not found

#### Subagent Report: MCP Integration

**File: src/rmplan/mcp/generate_mode.ts** - Tool registration

MCP tools follow a standardized pattern:

**Registration context:**
```typescript
export interface GenerateModeRegistrationContext {
  config: RmplanConfig;
  configPath?: string;
  gitRoot: string;
}
```

**Tool registration pattern:**
```typescript
server.addTool({
  name: 'tool-name',
  description: 'Detailed description including what's preserved...',
  parameters: zod.object({ /* schema */ }).describe('Overall operation'),
  annotations: {
    destructiveHint: false,  // Whether tool modifies state
    readOnlyHint: true,      // Read-only operations
  },
  execute: async (args) => handleToolFunction(args, context),
});
```

**Existing tools:**
1. `update-plan-tasks` - Merges generated tasks into plan (preserves completed)
2. `append-plan-research` - Adds research findings under ## Research
3. `get-plan` - Read-only plan retrieval (most frequently called)
4. `update-plan-details` - Updates generated section (preserves manual content)

**Parameter schema pattern:**
```typescript
export const toolParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path'),
    priority: prioritySchema.optional().describe('Priority level'),
    limit: z.number().int().positive().optional().describe('Max results'),
  })
  .describe('Top-level description of operation');

export type ToolArguments = z.infer<typeof toolParameters>;
```

**Handler pattern:**
```typescript
export async function handleToolName(
  args: ToolArguments,
  context: GenerateModeRegistrationContext
): Promise<string> {
  try {
    const { plan, planPath } = await resolvePlan(args.plan, context);
    // Perform operation
    return 'Success message with details';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`Failed to ...: ${message}`);
  }
}
```

**For list-ready-plans tool:**
- Parameter schema: priority filter, limit, includeInProgress flag
- Handler: Use `readAllPlans()` + `isPlanReady()` filter
- Format: String list with IDs, titles, priorities
- Annotations: `destructiveHint: false`, `readOnlyHint: true`
- Return format: Human-readable with fallback for empty results

**Naming conventions:**
- Kebab-case: `list-ready-plans`, `update-plan-tasks`
- Action verbs: update, append, get, list
- Descriptions: Present tense, include what's preserved

#### Subagent Report: Testing Patterns

**File: src/rmplan/commands/list.test.ts** - Primary reference (1100+ lines)

**Test infrastructure:**
- Bun test runner: `describe`, `test`, `expect`
- `ModuleMocker` from src/testing.ts for module mocking
- Real filesystem with `fs.mkdtemp()` for isolation
- Minimal mocking - tests verify actual behavior

**Standard test structure:**
```typescript
beforeEach(async () => {
  clearPlanCache();
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rmplan-test-'));
  
  // Mock logging
  moduleMocker.mock('../../logging.js', () => ({
    log: mockLog,
    warn: mockWarn,
    debugLog: mockDebug,
  }));
  
  // Mock chalk (strip colors)
  moduleMocker.mock('chalk', () => ({ default: new Proxy(...) }));
  
  // Mock config
  moduleMocker.mock('../configLoader.js', () => ({
    loadEffectiveConfig: mock(() => ({ tasksDir: tmpDir })),
  }));
  
  // Mock table rendering
  moduleMocker.mock('table', () => ({
    table: mockTable,
  }));
});

afterEach(() => {
  moduleMocker.clear();
});
```

**Plan creation in tests:**
```typescript
const plan: PlanSchema = {
  id: 1,
  goal: 'Test plan',
  status: 'pending',
  priority: 'medium',
  tasks: [{ title: 'Task 1', description: 'Description', done: false }],
  dependencies: [],
  createdAt: new Date().toISOString(),
};

await fs.writeFile(
  path.join(tmpDir, '1-test-plan.yml'),
  yaml.stringify(plan)
);
```

**Assertion patterns:**
```typescript
// Table output
const tableData = mockTable.mock.calls[0][0];
expect(tableData).toHaveLength(2); // header + 1 row
const row = tableData[1];
expect(row[0]).toBe('1'); // ID column

// Log output
expect(mockLog).toHaveBeenCalledWith(
  expect.stringContaining('Ready Plans')
);

// File verification
const updated = await readPlanFile(planPath);
expect(updated.status).toBe('done');
```

**Test coverage for ready command:**
1. Shows all ready plans (pending with done dependencies)
2. Empty when no plans are ready
3. Respects priority filter
4. Respects sort options (priority default, id, title)
5. Reverse flag works correctly
6. Verbose mode shows file paths
7. Displays dependency status correctly
8. Limits with `-n` option

**Key test utilities:**
- `clearPlanCache()` - Clear between tests
- `readAllPlans(dir)` - Verify plan state
- `isPlanReady(plan, plansMap)` - Check readiness
- `getCombinedTitleFromSummary(plan)` - Display verification

**Reference files:**
- src/rmplan/commands/list.test.ts - Comprehensive filtering/sorting tests
- src/rmplan/commands/add.test.ts - Plan creation patterns
- src/rmplan/commands/done.test.ts - Mock spy patterns
- src/rmplan/commands/set.test.ts - Helper function patterns

### Risks & Constraints

**Architectural considerations:**

1. **Dependency resolution performance:** `isPlanReady()` is called for every plan when filtering by 'ready' status. With hundreds of plans, this could be slow. However, the existing `list` command already uses this pattern without performance issues.

2. **ID type handling:** Plans support both numeric and string IDs. The readiness checking handles mixed types via `parseInt()` fallback, but sorting logic needs careful handling to avoid type errors.

3. **Priority field is optional:** Plans without explicit priority should default to 'medium' for sorting consistency. The existing priority order map handles undefined but should be tested.

4. **Color dependency on terminal support:** Chalk automatically detects color support, but tests must mock it to avoid ANSI codes in test assertions.

5. **Table formatting width:** The list command calculates responsive widths based on terminal columns. Ready command uses simpler line-by-line output to avoid this complexity.

**Constraints:**

1. **Must use existing utilities:** Cannot reimplement `isPlanReady()` or sorting logic - must reuse from plans.ts and list.ts
2. **Consistent error handling:** All errors must bubble to `handleCommandError` for uniform CLI experience
3. **Configuration loading:** Must support both global config (`~/.config/rmplan/rmplan.yaml`) and local config (`.rmplan/rmplan.yaml`)
4. **Testing requirements:** Tests must use real filesystem operations with temp directories, minimal mocking per project guidelines
5. **Color conventions:** Must follow established status/priority color scheme for consistency

**MCP-specific constraints:**

1. **Return type:** MCP tools must return strings (cannot return objects or arrays directly)
2. **Error handling:** Must throw `UserError` for user-facing errors, not generic Error
3. **Context passing:** All handlers receive `GenerateModeRegistrationContext` for config access
4. **Schema validation:** Parameters must be Zod schemas with `.describe()` annotations
5. **Annotations:** Must specify `destructiveHint` and `readOnlyHint` correctly

### Follow-up Questions

**Implementation approach:**

1. Should the ready command show task details (like show command) or just summary info (like list command)? The spec shows summary but "detailed output" could mean either.

2. Should we include `in_progress` plans by default or require a flag? The spec says "pending with dependencies done" but agents might want to see what's already being worked on.

3. For the MCP tool, should we return JSON-formatted data for easier parsing or human-readable text like the CLI output? Current tools return text but agents might benefit from structured data.

4. Should the verbose mode (`-v`) show anything beyond file paths? Could include: dependency tree, task list, assigned user, last updated timestamp?

**Testing clarifications:**

1. Should we test the MCP tool separately from the CLI command or verify they produce equivalent output?

2. Do we need integration tests that verify the tool works through the actual MCP server, or is unit testing the handler function sufficient?

3. Should we test edge cases like: circular dependencies, missing dependency plans, plans with no tasks, plans with 'maybe' priority?

<!-- rmplan-generated-start -->
## Design Decisions

### Output Format Strategy (Hybrid Approach)
The command will support three output formats via `--format` flag:
- **`list`** (default): Human-friendly colored output with visual separators
- **`table`**: Compact table view similar to `rmplan list`
- **`json`**: Structured JSON for programmatic parsing and agent consumption

### Scope of "Ready" Plans
**Default behavior**: Show both `pending` AND `in_progress` plans that meet readiness criteria
- Rationale: Provides complete picture of executable work (what can be started or continued)
- Add `--pending-only` flag to restrict to only pending plans
- Matches the pattern used by `findNextPlan()` function

### Readiness Criteria
A plan is ready when:
1. Status is `pending` OR `in_progress`
2. Has at least one task
3. All dependencies (if any) have status `done`

### Priority Sorting
Default sort order: priority (urgent→high→medium→low→undefined), then by ID
- Reverse flag available: `--reverse`
- Alternative sort fields: `--sort id`, `--sort title`, `--sort created`

### MCP Tool Output Format
The `list-ready-plans` MCP tool will return **JSON structure** for optimal agent parsing:

```json
{
  "count": 3,
  "plans": [
    {
      "id": 42,
      "title": "Add authentication to API endpoints",
      "goal": "Ship a high-quality feature",
      "priority": "high",
      "status": "pending",
      "taskCount": 5,
      "completedTasks": 0,
      "dependencies": [38, 39],
      "assignedTo": "alice",
      "filename": "tasks/42-add-auth.plan.md"
    }
  ]
}
```

This differs from existing text-based MCP tools but provides superior agent experience for programmatic consumption.
<!-- rmplan-generated-end -->
