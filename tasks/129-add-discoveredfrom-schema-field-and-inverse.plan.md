---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add discoveredFrom schema field and inverse relationship utilities
goal: ""
id: 129
status: pending
priority: high
temp: false
parent: 128
createdAt: 2025-10-26T22:40:58.967Z
updatedAt: 2025-10-26T22:40:58.970Z
tasks: []
---

## Overview

This plan implements the foundational schema and utility changes needed for autonomous agent support. It adds the ability to track which plan led to discovering a new issue, and provides utilities to compute inverse relationships without storing redundant data.

## Schema Changes

### Add discoveredFrom Field

File: `src/rmplan/planSchema.ts` (around line 65, after `parent` field)

Add this field to the phaseSchema:

```typescript
discoveredFrom: z.coerce.number().int().positive().optional()
  .describe('Plan ID that led to discovering this issue during research/implementation')
```

**Rationale:**
- Tracks discovery lineage - useful for understanding how work expands during implementation
- Helps agents see which plans generated additional work
- Single direction only (no need for inverse `discoveredPlans` array)

### Why Not Add Other Fields?

- **`blocked_by`**: Redundant with existing `dependencies` field. "A is blocked by B" is the same as "A depends on B"
- **`children`**: Should be computed at runtime by looking for plans with matching `parent` ID. Storing would create sync issues.
- **`blocks`**: Should be computed by finding plans that list this ID in their `dependencies` array

## Utility Functions

File: `src/rmplan/plans.ts` (add near other plan utility functions)

### 1. getBlockedPlans()

Returns all plans that depend on a given plan (inverse of `dependencies`):

```typescript
/**
 * Get all plans that depend on this plan (inverse of dependencies)
 * @param planId - The plan ID to find dependents for
 * @param allPlans - Map of all plans
 * @returns Array of plans that list planId in their dependencies
 */
export function getBlockedPlans(
  planId: number,
  allPlans: Map<number, PlanSchema & { filename: string }>
): Array<PlanSchema & { filename: string }> {
  return Array.from(allPlans.values()).filter(
    (p) => p.dependencies?.includes(planId)
  );
}
```

### 2. getChildPlans()

Returns all child plans (inverse of `parent`):

```typescript
/**
 * Get all child plans (inverse of parent)
 * @param planId - The parent plan ID
 * @param allPlans - Map of all plans
 * @returns Array of plans that have planId as their parent
 */
export function getChildPlans(
  planId: number,
  allPlans: Map<number, PlanSchema & { filename: string }>
): Array<PlanSchema & { filename: string }> {
  return Array.from(allPlans.values()).filter(
    (p) => p.parent === planId
  );
}
```

### 3. getDiscoveredPlans()

Returns all plans discovered from a given plan:

```typescript
/**
 * Get plans discovered from this plan during research/implementation
 * @param planId - The source plan ID
 * @param allPlans - Map of all plans
 * @returns Array of plans that were discovered from planId
 */
export function getDiscoveredPlans(
  planId: number,
  allPlans: Map<number, PlanSchema & { filename: string }>
): Array<PlanSchema & { filename: string }> {
  return Array.from(allPlans.values()).filter(
    (p) => p.discoveredFrom === planId
  );
}
```

## Testing Requirements

### Unit Tests

File: `src/rmplan/plans.test.ts`

Add tests for:
1. Schema validation accepts valid `discoveredFrom` values
2. Schema validation rejects invalid `discoveredFrom` (negative, non-integer, etc.)
3. `getBlockedPlans()` returns correct dependents
4. `getChildPlans()` returns correct children
5. `getDiscoveredPlans()` returns correct discovered plans
6. Edge cases: empty maps, missing plans, circular references

### Integration Tests

Verify that:
1. Existing plan files without `discoveredFrom` still load correctly
2. New plans with `discoveredFrom` save and load properly
3. The `validate` command handles the new field

## Validation Updates

File: `src/rmplan/commands/validate.ts`

Ensure the validation command:
1. Checks that `discoveredFrom` references exist (similar to dependency checking)
2. Warns about orphaned discoveries (discovered from a plan that no longer exists)
3. Optionally auto-fixes by removing invalid `discoveredFrom` references

## Dependencies

This plan has no dependencies and should be implemented first, as other plans (130, 133, 135) rely on these schema changes and utilities.

## MCP Integration

The MCP server doesn't need updates for this plan since:
- The schema changes are transparent to MCP tools (they already accept any valid plan schema)
- The `get-plan` tool will automatically return the new `discoveredFrom` field if present
- The `update-plan-tasks` tool can accept `discoveredFrom` as part of plan updates

However, plan 133 will add explicit support for setting `discoveredFrom` via the `set` command, which will need its own MCP tool in a future plan.
