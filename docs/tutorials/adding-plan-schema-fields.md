# Tutorial: Adding New Fields to the Plan Schema

This tutorial walks through the process of adding a new field to the tim plan schema, using the `assignedTo` field as an example. This demonstrates all the places that need to be updated when extending the plan schema with new fields.

## Overview

When adding a new field to the plan schema, you'll typically need to update:

1. The schema definition itself
2. Plan generation/processing logic
3. Display commands (show, list)
4. Modification commands (set)
5. Any filtering or query functionality

## Step 1: Update the Plan Schema

First, add the new field to the plan schema definition in `src/tim/planSchema.ts`:

```typescript
// src/tim/planSchema.ts
export const phaseSchema = z
  .object({
    // ... existing fields ...
    docs: z.array(z.string()).default([]).optional(),
    assignedTo: z.string().optional(), // Add your new field here
    // ... more fields ...
  })
  .describe('tim phase file schema');
```

The field should be marked as `.optional()` unless it's required for all plans.

## Step 2: Update Plan Processing Logic

When plans are generated from markdown or processed through various transformations, you need to ensure the new field is preserved. Update `src/tim/process_markdown.ts`:

### For Single-Phase Plans

```typescript
// In extractMarkdownToYaml function, around line 230
if (options.stubPlan?.data) {
  // ... existing field inheritance ...

  if (options.stubPlan?.data.assignedTo) {
    validatedPlan.assignedTo = options.stubPlan?.data.assignedTo;
  }
}
```

### For Multi-Phase Plans

```typescript
// In saveMultiPhaseYaml function, around line 400
if (options.stubPlan?.data) {
  // ... existing field inheritance ...

  // Inherit assignedTo if not already set
  if (!phase.assignedTo && options.stubPlan?.data.assignedTo) {
    phase.assignedTo = options.stubPlan?.data.assignedTo;
  }
}
```

## Step 3: Update Display Commands

### Show Command

Update `src/tim/commands/show.ts` to display the new field:

```typescript
// After displaying priority, around line 118
if (plan.assignedTo) {
  log(`${chalk.cyan('Assigned To:')} ${plan.assignedTo}`);
}
```

Only display the field if it has a value to keep the output clean.

### List Command

If the field should be filterable in the list command, update `src/tim/commands/list.ts`:

```typescript
// Add filtering logic after line 29
if (options.user || options.mine) {
  const filterUser = options.mine ? process.env.USER || process.env.USERNAME : options.user;
  if (filterUser) {
    planArray = planArray.filter((plan) => plan.assignedTo === filterUser);
  } else if (options.mine) {
    log(chalk.yellow('Warning: Could not determine current user from environment'));
  }
}
```

Then add the corresponding CLI options in `src/tim/tim.ts`:

```typescript
// In the list command definition
.option('-u, --user <username>', 'Filter by assignedTo username')
.option('--mine', 'Show only plans assigned to current user')
```

## Step 4: Update the Set Command

To allow users to modify the field, update the set command:

### Add to SetOptions Interface

In `src/tim/commands/set.ts`:

```typescript
export interface SetOptions {
  // ... existing fields ...
  assign?: string;
  noAssign?: boolean;
}
```

### Implement the Logic

Add the field handling in the `handleSetCommand` function:

```typescript
// Set assignedTo
if (options.assign !== undefined) {
  plan.assignedTo = options.assign;
  modified = true;
  log(`Assigned to ${options.assign}`);
}

// Remove assignedTo
if (options.noAssign) {
  if (plan.assignedTo !== undefined) {
    delete plan.assignedTo;
    modified = true;
    log('Removed assignedTo');
  } else {
    log('No assignedTo to remove');
  }
}
```

### Add CLI Options

In `src/tim/tim.ts`, add the options to the set command:

```typescript
.option('--assign <username>', 'Assign the plan to a user')
.option('--no-assign', 'Remove the plan assignment')
```

## Step 5: Test Your Changes

After making all the changes:

1. Run the test suite: `bun test`
2. Run type checking: `bun run check`
3. Run linting: `bun run lint`
4. Format the code: `bun run format`

## Best Practices

1. **Make fields optional**: Unless a field is truly required for all plans, make it optional to maintain backward compatibility.

2. **Consider inheritance**: When plans are generated from stubs or split into phases, decide whether the field should be inherited from parent plans.

3. **Keep display clean**: Only show fields in the `show` command when they have values to avoid cluttering the output.

4. **Use consistent naming**: Follow the existing naming patterns in the codebase (camelCase for field names, kebab-case for CLI options).

5. **Update documentation**: Don't forget to update the README or other documentation to mention the new field.

## Common Field Types

Here are examples of different field types you might add:

```typescript
// String field
assignedTo: z.string().optional(),

// Array field
tags: z.array(z.string()).default([]).optional(),

// Boolean field
isPublic: z.boolean().default(false).optional(),

// Enum field
category: z.enum(['feature', 'bug', 'task']).optional(),

// Number field
estimatedHours: z.number().positive().optional(),

// Date field
dueDate: z.string().datetime().optional(),
```

## Summary

Adding a new field to the plan schema involves:

1. Updating the schema definition
2. Ensuring the field is preserved during plan processing
3. Adding display logic where appropriate
4. Implementing modification commands
5. Adding any filtering or query functionality
6. Testing all changes

By following this pattern, you can extend the plan schema while maintaining consistency with the existing codebase.
