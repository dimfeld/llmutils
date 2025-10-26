---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add comprehensive MCP tools for autonomous agent workflows
goal: ""
id: 138
status: pending
priority: high
temp: false
dependencies:
  - 129
  - 132
parent: 128
createdAt: 2025-10-26T22:53:29.123Z
updatedAt: 2025-10-26T22:53:29.126Z
tasks: []
---

## Overview

The current MCP server (src/rmplan/mcp/generate_mode.ts) provides tools for updating existing plans but lacks tools for creating plans and updating plan properties. This plan adds comprehensive MCP tool coverage so autonomous agents can perform all essential rmplan operations programmatically without CLI access.

## Current MCP Tools

Existing tools in the MCP server:
- ✅ `update-plan-tasks` - Merge tasks into existing plan
- ✅ `append-plan-research` - Add research section
- ✅ `get-plan` - Read plan details
- ✅ `update-plan-details` - Update details within delimiters

## Missing MCP Capabilities

Comparing with CLI commands, agents need MCP tools for:

1. **Plan Creation** (`rmplan add`)
   - Create new plan files
   - Set initial properties (title, priority, parent, dependencies, etc.)
   - Include initial details if available

2. **Property Updates** (`rmplan set`)
   - Update priority, status, dependencies
   - Set parent, discoveredFrom relationships
   - Update assignedTo, issue links

3. **Task Management** (`rmplan add-task`, `rmplan remove-task`)
   - Add tasks to existing plans
   - Remove tasks by index or title

4. **Plan Discovery** (`rmplan ready`, `rmplan list`)
   - Query ready plans
   - Search plans by criteria

## Tools to Implement

File: `src/rmplan/mcp/generate_mode.ts`

### 1. create-plan Tool

```typescript
export const createPlanParameters = z
  .object({
    title: z.string().describe('Plan title'),
    goal: z.string().optional().describe('High-level goal'),
    details: z.string().optional().describe('Plan details (markdown)'),
    priority: prioritySchema.optional().describe('Priority level'),
    parent: z.number().optional().describe('Parent plan ID'),
    dependsOn: z.array(z.number()).optional().describe('Plan IDs this depends on'),
    discoveredFrom: z.number().optional().describe('Plan ID this was discovered from'),
    assignedTo: z.string().optional().describe('Username to assign plan to'),
    issue: z.array(z.string()).optional().describe('GitHub issue URLs'),
    docs: z.array(z.string()).optional().describe('Documentation file paths'),
    container: z.boolean().optional().describe('Mark as container plan'),
    temp: z.boolean().optional().describe('Mark as temporary plan'),
  })
  .describe('Create a new plan file');

export async function handleCreatePlanTool(
  args: z.infer<typeof createPlanParameters>,
  context: GenerateModeRegistrationContext
): Promise<string> {
  // Implementation:
  // 1. Get next available plan ID from tasks directory
  // 2. Create plan object with provided fields
  // 3. Generate filename from ID and title
  // 4. Write plan file
  // 5. Update parent plan if specified (add to parent's dependencies)
  // 6. Return plan ID and path

  const tasksDir = await resolveTasksDir(context.config);
  const nextId = await getNextPlanId(tasksDir);

  const plan: PlanSchema = {
    id: nextId,
    title: args.title,
    goal: args.goal,
    details: args.details,
    priority: args.priority,
    parent: args.parent,
    dependencies: args.dependsOn || [],
    discoveredFrom: args.discoveredFrom,
    assignedTo: args.assignedTo,
    issue: args.issue || [],
    docs: args.docs || [],
    container: args.container || false,
    temp: args.temp || false,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
  };

  const filename = generatePlanFilename(nextId, args.title);
  const planPath = path.join(tasksDir, filename);

  await writePlanFile(planPath, plan);

  // Update parent if specified
  if (args.parent) {
    await addChildToParent(args.parent, nextId, context);
  }

  return `Created plan ${nextId} at ${path.relative(context.gitRoot, planPath)}`;
}
```

### 2. update-plan-properties Tool

```typescript
export const updatePlanPropertiesParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path'),
    priority: prioritySchema.optional().describe('Set priority'),
    status: statusSchema.optional().describe('Set status'),
    addDependencies: z.array(z.number()).optional().describe('Plan IDs to add as dependencies'),
    removeDependencies: z.array(z.number()).optional().describe('Plan IDs to remove from dependencies'),
    parent: z.number().optional().describe('Set parent plan ID'),
    removeParent: z.boolean().optional().describe('Remove parent association'),
    discoveredFrom: z.number().optional().describe('Set discoveredFrom plan ID'),
    removeDiscoveredFrom: z.boolean().optional().describe('Remove discoveredFrom'),
    assignedTo: z.string().optional().describe('Set assignedTo username'),
    removeAssignment: z.boolean().optional().describe('Remove assignment'),
    addIssues: z.array(z.string()).optional().describe('Add issue URLs'),
    removeIssues: z.array(z.string()).optional().describe('Remove issue URLs'),
    addDocs: z.array(z.string()).optional().describe('Add documentation paths'),
    removeDocs: z.array(z.string()).optional().describe('Remove documentation paths'),
  })
  .describe('Update plan properties (equivalent to rmplan set)');

export async function handleUpdatePlanPropertiesTool(
  args: z.infer<typeof updatePlanPropertiesParameters>,
  context: GenerateModeRegistrationContext
): Promise<string> {
  const { plan, planPath } = await resolvePlan(args.plan, context);

  // Apply updates
  const updates: Partial<PlanSchema> = {};

  if (args.priority !== undefined) updates.priority = args.priority;
  if (args.status !== undefined) updates.status = args.status;

  // Handle dependencies
  if (args.addDependencies || args.removeDependencies) {
    const deps = new Set(plan.dependencies || []);
    args.addDependencies?.forEach(id => deps.add(id));
    args.removeDependencies?.forEach(id => deps.delete(id));
    updates.dependencies = Array.from(deps);
  }

  // Handle parent
  if (args.removeParent) {
    updates.parent = undefined;
  } else if (args.parent !== undefined) {
    updates.parent = args.parent;
  }

  // Handle discoveredFrom
  if (args.removeDiscoveredFrom) {
    updates.discoveredFrom = undefined;
  } else if (args.discoveredFrom !== undefined) {
    updates.discoveredFrom = args.discoveredFrom;
  }

  // Handle assignment
  if (args.removeAssignment) {
    updates.assignedTo = undefined;
  } else if (args.assignedTo !== undefined) {
    updates.assignedTo = args.assignedTo;
  }

  // Handle issues
  if (args.addIssues || args.removeIssues) {
    const issues = new Set(plan.issue || []);
    args.addIssues?.forEach(url => issues.add(url));
    args.removeIssues?.forEach(url => issues.delete(url));
    updates.issue = Array.from(issues);
  }

  // Handle docs
  if (args.addDocs || args.removeDocs) {
    const docs = new Set(plan.docs || []);
    args.addDocs?.forEach(path => docs.add(path));
    args.removeDocs?.forEach(path => docs.delete(path));
    updates.docs = Array.from(docs);
  }

  const updatedPlan = {
    ...plan,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await writePlanFile(planPath, updatedPlan);

  return `Updated properties for plan ${plan.id}`;
}
```

### 3. add-plan-task Tool

(Already outlined in plan 132's MCP section)

### 4. remove-plan-task Tool

(Already outlined in plan 132's MCP section)

### 5. list-ready-plans Tool

(Already outlined in plan 131's MCP section)

### 6. search-plans Tool

```typescript
export const searchPlansParameters = z
  .object({
    status: z.array(statusSchema).optional().describe('Filter by status values'),
    priority: z.array(prioritySchema).optional().describe('Filter by priority values'),
    assignedTo: z.string().optional().describe('Filter by assignee'),
    parent: z.number().optional().describe('Filter by parent ID'),
    hasParent: z.boolean().optional().describe('Filter plans with/without parent'),
    titleContains: z.string().optional().describe('Filter by title substring (case-insensitive)'),
    limit: z.number().optional().describe('Limit results (default: 20)'),
    sortBy: z.enum(['id', 'priority', 'created', 'updated']).optional().describe('Sort field'),
  })
  .describe('Search and filter plans');

export async function handleSearchPlansTool(
  args: z.infer<typeof searchPlansParameters>,
  context: GenerateModeRegistrationContext
): Promise<string> {
  const tasksDir = await resolveTasksDir(context.config);
  const { plans } = await readAllPlans(tasksDir);

  let results = Array.from(plans.values());

  // Apply filters
  if (args.status) {
    results = results.filter(p => args.status!.includes(p.status || 'pending'));
  }
  if (args.priority) {
    results = results.filter(p => p.priority && args.priority!.includes(p.priority));
  }
  if (args.assignedTo) {
    results = results.filter(p => p.assignedTo === args.assignedTo);
  }
  if (args.parent !== undefined) {
    results = results.filter(p => p.parent === args.parent);
  }
  if (args.hasParent !== undefined) {
    results = results.filter(p => args.hasParent ? p.parent !== undefined : p.parent === undefined);
  }
  if (args.titleContains) {
    const search = args.titleContains.toLowerCase();
    results = results.filter(p =>
      (p.title?.toLowerCase().includes(search)) ||
      (p.goal?.toLowerCase().includes(search))
    );
  }

  // Sort
  if (args.sortBy) {
    results.sort((a, b) => {
      // Implement sorting logic
    });
  }

  // Limit
  results = results.slice(0, args.limit || 20);

  // Format output
  return results
    .map(p => `- [${p.id}] ${p.title || p.goal} (${p.status}, ${p.priority || 'medium'})`)
    .join('\n');
}
```

## Tool Registration

Add all new tools to `registerGenerateMode()`:

```typescript
export function registerGenerateMode(
  server: FastMCP,
  context: GenerateModeRegistrationContext
): void {
  // ... existing prompts ...

  // Existing tools
  server.addTool({ name: 'update-plan-tasks', ... });
  server.addTool({ name: 'append-plan-research', ... });
  server.addTool({ name: 'get-plan', ... });
  server.addTool({ name: 'update-plan-details', ... });

  // New tools
  server.addTool({
    name: 'create-plan',
    description: 'Create a new plan file with specified properties',
    parameters: createPlanParameters,
    annotations: { destructiveHint: true, readOnlyHint: false },
    execute: async (args) => handleCreatePlanTool(args, context),
  });

  server.addTool({
    name: 'update-plan-properties',
    description: 'Update plan properties like priority, status, dependencies, etc.',
    parameters: updatePlanPropertiesParameters,
    annotations: { destructiveHint: true, readOnlyHint: false },
    execute: async (args) => handleUpdatePlanPropertiesTool(args, context),
  });

  server.addTool({
    name: 'add-plan-task',
    description: 'Add a new task to an existing plan',
    parameters: addTaskParameters,
    annotations: { destructiveHint: true, readOnlyHint: false },
    execute: async (args) => handleAddTaskTool(args, context),
  });

  server.addTool({
    name: 'remove-plan-task',
    description: 'Remove a task from a plan',
    parameters: removeTaskParameters,
    annotations: { destructiveHint: true, readOnlyHint: false },
    execute: async (args) => handleRemoveTaskTool(args, context),
  });

  server.addTool({
    name: 'list-ready-plans',
    description: 'List plans ready to execute',
    parameters: listReadyPlansParameters,
    annotations: { destructiveHint: false, readOnlyHint: true },
    execute: async (args) => handleListReadyPlansTool(args, context),
  });

  server.addTool({
    name: 'search-plans',
    description: 'Search and filter plans by various criteria',
    parameters: searchPlansParameters,
    annotations: { destructiveHint: false, readOnlyHint: true },
    execute: async (args) => handleSearchPlansTool(args, context),
  });
}
```

## Helper Functions Needed

### getNextPlanId()

```typescript
async function getNextPlanId(tasksDir: string): Promise<number> {
  const { plans } = await readAllPlans(tasksDir);
  const ids = Array.from(plans.keys()).filter(id => typeof id === 'number');
  return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}
```

### generatePlanFilename()

```typescript
function generatePlanFilename(id: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
  return `${id}-${slug}.plan.md`;
}
```

### addChildToParent()

```typescript
async function addChildToParent(
  parentId: number,
  childId: number,
  context: GenerateModeRegistrationContext
): Promise<void> {
  const tasksDir = await resolveTasksDir(context.config);
  const { plans } = await readAllPlans(tasksDir);
  const parent = plans.get(parentId);

  if (!parent) {
    throw new UserError(`Parent plan ${parentId} not found`);
  }

  // Add child to parent's dependencies if not already there
  const deps = new Set(parent.dependencies || []);
  deps.add(childId);
  parent.dependencies = Array.from(deps);
  parent.updatedAt = new Date().toISOString();

  await writePlanFile(parent.filename, parent);
}
```

## Testing

### Unit Tests

File: `src/rmplan/mcp/generate_mode.test.ts`

Add tests for each new tool:
1. create-plan creates valid plan file
2. create-plan with parent updates parent's dependencies
3. update-plan-properties modifies correct fields
4. update-plan-properties handles add/remove operations
5. add-plan-task appends task correctly
6. remove-plan-task removes by index and title
7. list-ready-plans filters correctly
8. search-plans applies all filters

### Integration Tests

Test via MCP client:
1. Create plan, verify file exists
2. Update properties, verify changes persist
3. Add task, show plan, verify task appears
4. Search for created plan, verify it's found
5. List ready plans after completing dependencies

## Use Cases for Agents

### Discovering Work During Implementation

```javascript
// Agent discovers a bug while working on plan 42
const result = await mcp.call('create-plan', {
  title: 'Fix authentication edge case',
  discoveredFrom: 42,
  priority: 'high',
  details: '## Problem\nFound during implementation...',
});
```

### Managing Plan Lifecycle

```javascript
// Mark plan as in progress
await mcp.call('update-plan-properties', {
  plan: '42',
  status: 'in_progress',
});

// Add dependency discovered later
await mcp.call('update-plan-properties', {
  plan: '42',
  addDependencies: [45],
});

// Mark complete
await mcp.call('update-plan-properties', {
  plan: '42',
  status: 'done',
});
```

### Finding Next Work

```javascript
// What's ready to work on?
const readyPlans = await mcp.call('list-ready-plans', {
  limit: 5,
  sortBy: 'priority',
});

// Search for specific work
const authPlans = await mcp.call('search-plans', {
  titleContains: 'auth',
  status: ['pending', 'in_progress'],
  priority: ['high', 'urgent'],
});
```

### Dynamic Task Adjustment

```javascript
// Add task discovered during implementation
await mcp.call('add-plan-task', {
  plan: '42',
  title: 'Add null checks',
  description: 'Found edge case requiring validation',
});

// Remove obsolete task
await mcp.call('remove-plan-task', {
  plan: '42',
  taskTitle: 'manual setup',
});
```

## Documentation Updates

Update `src/rmplan/mcp/README.md` (create if doesn't exist):

```markdown
# rmplan MCP Server

## Available Tools

### Plan Creation
- `create-plan` - Create new plan files
- `add-plan-task` - Add tasks to plans
- `remove-plan-task` - Remove tasks from plans

### Plan Modification
- `update-plan-tasks` - Merge generated tasks
- `update-plan-properties` - Update metadata (priority, status, etc.)
- `update-plan-details` - Update details section
- `append-plan-research` - Add research notes

### Plan Discovery
- `get-plan` - Retrieve plan details
- `list-ready-plans` - Find executable plans
- `search-plans` - Search by criteria

## Example Workflows

[Include examples from use cases above]
```

## Dependencies

Depends on:
- Plan 129: For `discoveredFrom` field support
- Plan 132: For task management command implementations (to ensure CLI and MCP have feature parity)

## Implementation Order

1. Implement helper functions (getNextPlanId, generatePlanFilename, addChildToParent)
2. Implement create-plan tool (most fundamental)
3. Implement update-plan-properties tool
4. Implement task management tools (add-plan-task, remove-plan-task)
5. Implement discovery tools (list-ready-plans, search-plans)
6. Update tool registration
7. Add tests
8. Update documentation
