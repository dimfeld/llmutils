# rmplan MCP Tools Reference

Complete reference for rmplan MCP server tools and prompts.

## Prompts

### generate-plan

Full planning workflow with research phase.

**Arguments:**
- `plan` (required): Plan ID or file path
- `allowMultiplePlans` (optional): Allow creating child plans for large scope

**Workflow:**
1. Load plan context
2. Research codebase relevant to goal
3. Write findings to `## Implementation Guide` section in the plan file
4. Collaborate with user through questions
5. Generate structured tasks
6. Save with `update-plan-tasks` tool

**When to use:** Standard plan generation with thorough research.

### generate-plan-simple

Skip research, generate tasks directly.

**Arguments:**
- `plan` (optional): Plan ID or file path
- `allowMultiplePlans` (optional): Allow creating child plans

**When to use:**
- Simple changes
- Research already exists in plan
- Time-critical situations

### plan-questions

Collaborate with user to refine plan.

**Arguments:**
- `plan` (optional): Plan ID for context

**Behavior:** Ask focused, high-impact questions one at a time.

### load-plan

Display plan and wait for instructions.

**Arguments:**
- `plan` (required): Plan ID or file path

**Behavior:** Shows plan details, waits for user before acting.

### compact-plan

Summarize completed plan for archival.

**Arguments:**
- `plan` (required): Plan ID or file path

**Requirements:** Plan status must be `done`, `cancelled`, or `deferred`.

## Tools

### get-plan

Retrieve full plan details.

**Parameters:**
```typescript
{
  plan: string  // Plan ID or file path
}
```

**Returns:** Complete plan with metadata, tasks, details, and relationships.

### create-plan

Create a new plan file.

**Parameters:**
```typescript
{
  title: string           // Required
  goal?: string
  details?: string        // Markdown content
  priority?: "low" | "medium" | "high" | "urgent" | "maybe"
  parent?: number         // Parent plan ID
  dependsOn?: number[]    // Blocking plan IDs
  discoveredFrom?: number // Source plan ID
  assignedTo?: string     // Username
  issue?: string[]        // Issue URLs
  docs?: string[]         // Documentation paths
  tags?: string[]
  container?: boolean     // Container for children only
  temp?: boolean          // Temporary plan
}
```

**Behavior:**
- Generates numeric ID automatically
- Creates file in configured tasks directory
- Updates parent's dependencies if `parent` specified
- Reopens parent if it was marked done

### update-plan-tasks

Update plan with generated tasks and details.

**Parameters:**
```typescript
{
  plan: string            // Plan ID or file path (required)
  title?: string
  goal?: string
  details?: string        // Markdown, merged into generated section
  priority?: "low" | "medium" | "high" | "urgent"
  tasks: Array<{
    title: string         // Required
    description: string   // Required
    done?: boolean
  }>
}
```

**Behavior:**
- Merges new tasks with existing (preserves completed tasks)
- Updates generated section content
- Preserves manual content outside delimiters

### update-plan-details

Update the generated section content.

**Parameters:**
```typescript
{
  plan: string      // Plan ID or file path (required)
  details: string   // New content (required)
  append?: boolean  // true=append, false=replace (default: false)
}
```

**Behavior:**
- Modifies content between `<!-- rmplan-generated-start -->` and `<!-- rmplan-generated-end -->`
- Preserves content outside delimiters

### manage-plan-task

Add, update, or remove individual tasks.

**Parameters:**
```typescript
{
  plan: string                           // Required
  action: "add" | "update" | "remove"    // Required

  // Task identification (for update/remove)
  taskTitle?: string      // Partial match, case-insensitive (preferred)
  taskIndex?: number      // 0-based index

  // Task fields (for add/update)
  title?: string          // Required for add
  description?: string    // Required for add
  done?: boolean          // For update only
}
```

**Examples:**

Add task:
```json
{
  "plan": "123",
  "action": "add",
  "title": "Add validation",
  "description": "Validate user input before processing"
}
```

Update task by title:
```json
{
  "plan": "123",
  "action": "update",
  "taskTitle": "validation",
  "done": true
}
```

Remove task:
```json
{
  "plan": "123",
  "action": "remove",
  "taskTitle": "Add validation"
}
```

### list-ready-plans

Find plans ready to execute.

**Parameters:**
```typescript
{
  priority?: "low" | "medium" | "high" | "urgent" | "maybe"
  limit?: number
  pendingOnly?: boolean   // Exclude in_progress (default: false)
  sortBy?: "priority" | "id" | "title" | "created" | "updated"
  tags?: string[]         // Filter by any of these tags
}
```

**Returns:** JSON with plan summaries including:
- id, title, priority, status
- taskCount, completedTasks
- dependencies, filePath

**Readiness criteria:**
- Status is `pending` or `in_progress`
- All dependencies have status `done`
- Priority is not `maybe`

## Resources

### rmplan://plans/list

List all plans with summary info.

**Returns:** JSON array of plan summaries.

### rmplan://plans/{planId}

Get full plan details.

**Returns:** Complete plan JSON.

### rmplan://plans/ready

List ready plans.

**Returns:** Same as `list-ready-plans` tool with default options.

## Common Patterns

### Research and Generate

```
1. Use generate-plan prompt with plan ID
2. Explore codebase with Read, Grep, Glob tools
3. Write findings directly to plan file under ## Implementation Guide
4. Ask user clarifying questions
5. Use update-plan-tasks to save generated tasks
```

### Create Child Plans

When scope is large:
```
1. Use create-plan with parent field set
2. Set dependencies between children as needed
3. Each child should deliver complete functionality
4. Split by feature areas, NOT architectural layers
```

### Mark Task Complete

```
1. Use manage-plan-task with action="update"
2. Identify task by title (partial match works)
3. Set done=true
```
