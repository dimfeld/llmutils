# rmplan MCP Server

The rmplan MCP server provides comprehensive tools and resources for autonomous agents to manage project plans programmatically. It enables agents to discover work, create plans, manage tasks, and track progress without requiring CLI access.

## Overview

The MCP server exposes two primary interfaces:

- **Tools**: Programmatic actions to create and modify plans (create-plan, update-plan-tasks, etc.)
- **Resources**: Read-only access to browse plan data (rmplan://plans/list, rmplan://plans/ready, etc.)

Both interfaces operate on plan files stored in the repository's tasks directory and follow the same data model as the rmplan CLI commands.

## Available Tools

### Plan Creation

#### create-plan

Create a new plan file with specified properties. Automatically updates parent plan dependencies to maintain bidirectional relationships.

**Parameters:**

- `title` (required): Plan title
- `goal` (optional): High-level goal of the plan
- `details` (optional): Plan details in markdown format
- `priority` (optional): Priority level (low|medium|high|urgent|maybe)
- `parent` (optional): Parent plan ID
- `dependsOn` (optional): Array of plan IDs this plan depends on
- `discoveredFrom` (optional): Plan ID this was discovered from
- `assignedTo` (optional): Username to assign plan to
- `issue` (optional): Array of GitHub issue URLs
- `docs` (optional): Array of documentation file paths
- `container` (optional): Mark as container plan (boolean)
- `temp` (optional): Mark as temporary plan (boolean)

**Example:**

```javascript
const result = await mcp.call('create-plan', {
  title: 'Fix authentication edge case',
  discoveredFrom: 42,
  priority: 'high',
  details: '## Problem\nFound during implementation of plan 42...',
});
// Returns: "Created plan 43 at tasks/43-fix-authentication-edge-case.plan.md"
```

### Task Management

#### add-plan-task

Add a new task to an existing plan.

**Parameters:**

- `plan` (required): Plan ID or file path
- `title` (required): Task title
- `description` (required): Task description
- `files` (optional): Array of related file paths
- `docs` (optional): Array of documentation paths

**Example:**

```javascript
await mcp.call('add-plan-task', {
  plan: '42',
  title: 'Add null checks',
  description: 'Found edge case requiring validation in user input handler',
  files: ['src/handlers/user.ts'],
});
```

#### remove-plan-task

Remove a task from a plan by title (preferred) or index.

**Parameters:**

- `plan` (required): Plan ID or file path
- `taskTitle` (optional): Task title to search for (partial match, case-insensitive)
- `taskIndex` (optional): Task index (0-based)

**Note:** Either `taskTitle` or `taskIndex` must be provided. `taskTitle` is preferred as indices shift when tasks are removed.

**Example:**

```javascript
await mcp.call('remove-plan-task', {
  plan: '42',
  taskTitle: 'manual setup',
});
```

#### update-plan-task

Update a single existing task in a plan by title or index.

**Parameters:**

- `plan` (required): Plan ID or file path
- `taskTitle` (optional): Task title to search for (partial match, case-insensitive)
- `taskIndex` (optional): Task index (0-based)
- `newTitle` (optional): New task title
- `newDescription` (optional): New task description
- `done` (optional): Mark task as done or not done (boolean)

**Note:** Either `taskTitle` or `taskIndex` must be provided.

**Example:**

```javascript
await mcp.call('update-plan-task', {
  plan: '42',
  taskTitle: 'Add tests',
  done: true,
});
```

### Plan Modification

#### update-plan-tasks

Merge generated tasks and metadata into an existing plan. This is typically used after generating a plan with an LLM.

**Parameters:**

- `plan` (required): Plan ID or file path to update
- `tasks` (required): Array of task objects with `title`, `description`, and optional `done` boolean
- `title` (optional): Plan title
- `goal` (optional): High-level goal of the plan
- `details` (optional): Additional details about the plan in markdown format
- `priority` (optional): Priority level for the plan

**Example:**

```javascript
await mcp.call('update-plan-tasks', {
  plan: '42',
  title: 'Implement user authentication',
  goal: 'Add secure authentication system',
  priority: 'high',
  tasks: [
    { title: 'Create login endpoint', description: 'POST /api/login with email/password' },
    { title: 'Add password hashing', description: 'Use bcrypt for secure password storage' },
    { title: 'Implement JWT tokens', description: 'Generate and validate JWT tokens for sessions' },
  ],
});
```

#### update-plan-details

Update plan details within the delimiter-bounded generated section. Can append to or replace existing generated content while preserving manually-added sections like Research.

**Parameters:**

- `plan` (required): Plan ID or file path to update
- `details` (required): New details text to add or replace within the generated section
- `append` (optional): If true, append to existing generated content; if false, replace it (default: false)

**Example:**

```javascript
await mcp.call('update-plan-details', {
  plan: '42',
  details: '## Implementation Notes\n\nUse passport.js library for authentication middleware.',
  append: true,
});
```

#### append-plan-research

Append research findings to the plan details under a Research section.

**Parameters:**

- `plan` (required): Plan ID or file path to update
- `research` (required): Extensive research notes to append under the Research section
- `heading` (optional): Override the section heading (defaults to "## Research")
- `timestamp` (optional): Include an automatic timestamp heading (default: false)

**Example:**

```javascript
await mcp.call('append-plan-research', {
  plan: '42',
  research: 'Investigated JWT libraries. jsonwebtoken is most popular with 18k stars...',
  timestamp: true,
});
```

### Plan Discovery

#### get-plan

Retrieve the full plan details by numeric ID or file path.

**Parameters:**

- `plan` (required): Plan ID or file path to retrieve

**Returns:** JSON string containing the complete plan object with metadata, goal, details, tasks, and related information.

**Example:**

```javascript
const planJson = await mcp.call('get-plan', { plan: '42' });
const plan = JSON.parse(planJson);
console.log(plan.title, plan.status, plan.tasks);
```

#### list-ready-plans

List all plans that are ready to be worked on. A plan is ready when it has status "pending" or "in_progress", contains at least one task, and all its dependencies are marked as "done".

**Parameters:**

- `priority` (optional): Filter by priority level (low|medium|high|urgent|maybe)
- `limit` (optional): Maximum number of plans to return (default: all)
- `pendingOnly` (optional): Show only pending plans, exclude in_progress (default: false)
- `sortBy` (optional): Sort field - priority|id|title|created|updated (default: priority)

**Returns:** JSON array of ready plans with their details.

**Example:**

```javascript
const readyJson = await mcp.call('list-ready-plans', {
  limit: 5,
  sortBy: 'priority',
});
const readyPlans = JSON.parse(readyJson);
readyPlans.forEach((plan) => {
  console.log(`[${plan.id}] ${plan.title} (${plan.priority})`);
});
```

## Available Resources

Resources provide read-only access to plan data via URI-based browsing. Unlike tools, resources are pull-based and don't modify any data.

### rmplan://plans/list

List of all plans in the repository with summary information.

**Returns:** JSON array with the following fields for each plan:

- `id`: Plan ID
- `title`: Plan title
- `goal`: High-level goal
- `status`: Current status (pending|in_progress|done|cancelled)
- `priority`: Priority level (low|medium|high|urgent|maybe)
- `parent`: Parent plan ID (if any)
- `dependencies`: Array of plan IDs this plan depends on
- `assignedTo`: Assigned username (if any)
- `taskCount`: Total number of tasks
- `completedTasks`: Number of completed tasks
- `createdAt`: ISO timestamp when plan was created
- `updatedAt`: ISO timestamp when plan was last updated

**Example:**

```javascript
const allPlans = await mcp.readResource('rmplan://plans/list');
const plans = JSON.parse(allPlans.contents[0].text);

// Display by status
const byStatus = plans.reduce((acc, plan) => {
  acc[plan.status] = acc[plan.status] || [];
  acc[plan.status].push(plan);
  return acc;
}, {});

console.log(`Pending: ${byStatus.pending?.length || 0}`);
console.log(`In Progress: ${byStatus.in_progress?.length || 0}`);
console.log(`Done: ${byStatus.done?.length || 0}`);
```

### rmplan://plans/{planId}

Full details of a specific plan including all metadata, tasks, and details.

**URI Template:** `rmplan://plans/{planId}` where `{planId}` is a plan ID or file path.

**Returns:** JSON object containing the complete plan structure.

**Example:**

```javascript
// Get plan by ID
const plan42 = await mcp.readResource('rmplan://plans/42');
const plan = JSON.parse(plan42.contents[0].text);

console.log(plan.title);
console.log(`Status: ${plan.status}`);
console.log(`Tasks: ${plan.tasks.length}`);
plan.tasks.forEach((task) => {
  const status = task.done ? '✓' : ' ';
  console.log(`  [${status}] ${task.title}`);
});
```

### rmplan://plans/ready

Plans ready to execute (all dependencies satisfied). This includes both stub plans without tasks (awaiting task generation) and plans with existing tasks ready for implementation.

**Returns:** JSON array of plans that are ready to work on, filtered and sorted by priority.

**Example:**

```javascript
const readyPlans = await mcp.readResource('rmplan://plans/ready');
const plans = JSON.parse(readyPlans.contents[0].text);

// Pick highest priority plan
const nextPlan = plans[0];
console.log(`Next: [${nextPlan.id}] ${nextPlan.title}`);

// Get full details
const planDetails = await mcp.readResource(`rmplan://plans/${nextPlan.id}`);
const fullPlan = JSON.parse(planDetails.contents[0].text);
```

## When to Use Resources vs Tools

### Use Resources When:

- **Browsing or querying** plan data without modifying it
- **Discovering work** by checking ready plans
- **Building dashboards** or reporting on plan status
- **Monitoring progress** across multiple plans
- **Searching for specific plans** by status, priority, or other criteria

Resources are pull-based and read-only, making them ideal for non-destructive operations.

### Use Tools When:

- **Creating new plans** as you discover additional work
- **Modifying plan metadata** like priority, status, or dependencies
- **Managing tasks** by adding, removing, or updating them
- **Updating plan details** with research or implementation notes
- **Performing any write operation** that changes plan files

Tools are push-based and can modify plan data, making them essential for active plan management.

## Example Workflows

### Discovering and Starting Work

```javascript
// 1. Find ready plans
const readyPlans = await mcp.readResource('rmplan://plans/ready');
const plans = JSON.parse(readyPlans.contents[0].text);

// 2. Pick highest priority plan
const nextPlan = plans[0];
console.log(`Working on: [${nextPlan.id}] ${nextPlan.title}`);

// 3. Get full details
const planJson = await mcp.call('get-plan', { plan: nextPlan.id.toString() });
const fullPlan = JSON.parse(planJson);

// 4. Start working on tasks
for (const task of fullPlan.tasks) {
  if (!task.done) {
    console.log(`Starting: ${task.title}`);
    // ... implement task ...

    // Mark complete
    await mcp.call('update-plan-task', {
      plan: nextPlan.id.toString(),
      taskTitle: task.title,
      done: true,
    });
  }
}
```

### Discovering Work During Implementation

```javascript
// While working on plan 42, agent discovers a bug
const result = await mcp.call('create-plan', {
  title: 'Fix authentication edge case',
  discoveredFrom: 42,
  priority: 'high',
  details: `## Problem
Found during implementation of plan 42.

When a user logs in with an expired password reset token,
the system throws an unhandled exception instead of showing
a user-friendly error message.

## Solution
Add proper error handling in the password reset flow.`,
});

// The new plan is now tracked and will appear in ready plans immediately.
// The discoveredFrom field helps track that this was discovered during plan 42.
```

### Managing Plan Lifecycle

```javascript
// Create a new plan
const createResult = await mcp.call('create-plan', {
  title: 'Implement user authentication',
  priority: 'high',
  goal: 'Add secure authentication system',
});

// Extract plan ID from result
const planId = createResult.match(/Created plan (\d+)/)[1];

// Add initial task as you discover work
await mcp.call('add-plan-task', {
  plan: planId,
  title: 'Research authentication libraries',
  description: 'Compare passport.js, Auth0, and custom JWT implementation',
});

// Add research findings
await mcp.call('append-plan-research', {
  plan: planId,
  research: 'Investigated JWT libraries. jsonwebtoken is most popular...',
  timestamp: true,
});

// Generate full task list
await mcp.call('update-plan-tasks', {
  plan: planId,
  tasks: [
    { title: 'Create login endpoint', description: 'POST /api/login' },
    { title: 'Add password hashing', description: 'Use bcrypt' },
    { title: 'Implement JWT tokens', description: 'Generate and validate JWTs' },
  ],
});

// As you complete tasks, mark them done
await mcp.call('update-plan-task', {
  plan: planId,
  taskTitle: 'Create login endpoint',
  done: true,
});
```

### Dynamic Task Adjustment

```javascript
// While implementing, discover a subtask is no longer needed
await mcp.call('remove-plan-task', {
  plan: '42',
  taskTitle: 'manual setup',
});

// Add a newly discovered task
await mcp.call('add-plan-task', {
  plan: '42',
  title: 'Add integration tests',
  description: 'Test authentication flow end-to-end with real HTTP requests',
  files: ['tests/integration/auth.test.ts'],
});

// Update task description after learning more
await mcp.call('update-plan-task', {
  plan: '42',
  taskTitle: 'Add integration tests',
  newDescription: 'Test authentication flow including token refresh and logout',
});
```

### Monitoring Progress Across Plans

```javascript
// Get all plans
const allPlans = await mcp.readResource('rmplan://plans/list');
const plans = JSON.parse(allPlans.contents[0].text);

// Calculate statistics
const stats = {
  total: plans.length,
  pending: plans.filter((p) => p.status === 'pending').length,
  inProgress: plans.filter((p) => p.status === 'in_progress').length,
  done: plans.filter((p) => p.status === 'done').length,
  totalTasks: plans.reduce((sum, p) => sum + p.taskCount, 0),
  completedTasks: plans.reduce((sum, p) => sum + p.completedTasks, 0),
};

console.log('Project Status:');
console.log(`  Plans: ${stats.done}/${stats.total} complete`);
console.log(`  Tasks: ${stats.completedTasks}/${stats.totalTasks} complete`);
console.log(`  In Progress: ${stats.inProgress}`);
console.log(`  Pending: ${stats.pending}`);
```

## Best Practices

### Parent-Child Relationships

When creating a child plan with a `parent` parameter, the create-plan tool automatically:

1. Sets the child's `parent` field to the specified parent ID
2. Adds the child's ID to the parent's `dependencies` array
3. Updates the parent plan file on disk

This maintains bidirectional consistency in the dependency graph.

### Task Management

- **Use taskTitle over taskIndex** when removing or updating tasks, as indices shift when tasks are removed
- **Partial matching** is case-insensitive for taskTitle searches (e.g., "add tests" matches "Add integration tests")
- **Mark tasks done** as you complete them to track progress accurately

### Plan Discovery

- Use `discoveredFrom` field when creating plans during implementation to track the context in which work was discovered
- The `discoveredFrom` relationship helps understand how plans relate to each other beyond strict dependencies
- Check `rmplan://plans/ready` regularly to find the next highest-priority work

### Details and Research

- Use `update-plan-details` with `append: true` to add implementation notes without overwriting generated content
- Use `append-plan-research` to accumulate research findings with timestamps
- Generated content lives within delimiters and can be safely replaced; manual content outside delimiters is preserved

## Error Handling

All MCP tools throw `UserError` exceptions for user-facing errors:

- Plan not found
- Invalid plan ID
- Task not found
- Empty or invalid parameters

Errors include descriptive messages that can be shown to users or logged for debugging.

## Related Documentation

- [rmplan CLI Commands](../../README.md) - Command-line interface documentation
- [Plan File Format](.cursor/rules/plan_files.mdc) - Structure and schema of .plan.md files
- [MCP Protocol](https://modelcontextprotocol.io/) - Model Context Protocol specification
