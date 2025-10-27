---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add discoveredFrom schema field and inverse relationship utilities
goal: Implement foundational schema and utility changes to track plan discovery
  lineage and compute inverse relationships, enabling autonomous agent support
  without data redundancy
id: 129
uuid: 1993c51d-3c29-4f8d-9928-6fa7ebea414c
generatedBy: agent
status: done
priority: high
container: false
temp: false
dependencies: []
parent: 128
issue: []
pullRequest: []
docs: []
planGeneratedAt: 2025-10-27T07:19:12.171Z
promptsGeneratedAt: 2025-10-27T07:19:12.171Z
createdAt: 2025-10-26T22:40:58.967Z
updatedAt: 2025-10-27T08:39:04.247Z
progressNotes:
  - timestamp: 2025-10-27T07:23:12.424Z
    text: Added optional discoveredFrom field to phase schema and implemented
      inverse relationship helpers getBlockedPlans, getChildPlans, and
      getDiscoveredPlans for use across rmplan.
    source: "implementer: Tasks 1-4"
  - timestamp: 2025-10-27T07:26:59.176Z
    text: Expanded rmplan test suite to cover discoveredFrom schema validation,
      inverse relationship helpers, and read/write integration ensuring new
      lineage data is preserved and legacy files remain compatible.
    source: "implementer: Tasks 5-10"
  - timestamp: 2025-10-27T07:32:21.151Z
    text: Extended rmplan validate command to detect orphaned discoveredFrom
      references, automatically strip them when allowed, and covered both fix
      and --no-fix flows with new tests.
    source: "implementer: Task 11"
  - timestamp: 2025-10-27T07:37:38.157Z
    text: Executed bun test and bun run check; all tests pass after verifying
      discoveredFrom utilities and validation suites cover requested scenarios.
    source: "tester: automated coverage"
tasks:
  - title: Add discoveredFrom field to plan schema
    done: true
    description: Add the `discoveredFrom` field to `phaseSchema` in
      `src/rmplan/planSchema.ts` after the `parent` field. Use
      `z.coerce.number().int().positive().optional()` with a descriptive comment
      explaining it tracks which plan led to discovering this issue during
      research/implementation.
    files: []
    docs: []
    steps: []
  - title: Implement getBlockedPlans utility function
    done: true
    description: Add `getBlockedPlans(planId, allPlans)` to `src/rmplan/plans.ts`.
      Returns all plans that have `planId` in their `dependencies` array
      (inverse of dependencies). Include JSDoc comments with @param and @returns
      annotations.
    files: []
    docs: []
    steps: []
  - title: Implement getChildPlans utility function
    done: true
    description: Add `getChildPlans(planId, allPlans)` to `src/rmplan/plans.ts`.
      Returns all plans where `parent === planId` (inverse of parent). Include
      JSDoc comments with @param and @returns annotations.
    files: []
    docs: []
    steps: []
  - title: Implement getDiscoveredPlans utility function
    done: true
    description: Add `getDiscoveredPlans(planId, allPlans)` to
      `src/rmplan/plans.ts`. Returns all plans where `discoveredFrom ===
      planId`. Include JSDoc comments with @param and @returns annotations.
    files: []
    docs: []
    steps: []
  - title: Add schema validation tests for discoveredFrom
    done: true
    description: "Create tests in `src/rmplan/plans.test.ts` that verify: (1) schema
      accepts valid positive integers for `discoveredFrom`, (2) schema rejects
      negative numbers, zero, non-integers, and non-numeric values, (3) field is
      optional and plans without it validate successfully."
    files: []
    docs: []
    steps: []
  - title: Add unit tests for getBlockedPlans
    done: true
    description: "Add tests for `getBlockedPlans()` covering: (1) returns plans that
      depend on target plan, (2) returns empty array when no dependents exist,
      (3) handles multiple dependents correctly, (4) works with empty plan map."
    files: []
    docs: []
    steps: []
  - title: Add unit tests for getChildPlans
    done: true
    description: "Add tests for `getChildPlans()` covering: (1) returns direct
      children of parent plan, (2) returns empty array when no children exist,
      (3) handles multiple children correctly, (4) doesn't return grandchildren
      (only direct children), (5) works with empty plan map."
    files: []
    docs: []
    steps: []
  - title: Add unit tests for getDiscoveredPlans
    done: true
    description: "Add tests for `getDiscoveredPlans()` covering: (1) returns plans
      discovered from source plan, (2) returns empty array when no discoveries
      exist, (3) handles multiple discovered plans correctly, (4) works with
      empty plan map."
    files: []
    docs: []
    steps: []
  - title: Add edge case tests for utility functions
    done: true
    description: "Add tests covering edge cases: (1) circular references in
      relationships don't cause infinite loops, (2) missing plan IDs are handled
      gracefully, (3) functions work correctly with large plan sets (>100
      plans)."
    files: []
    docs: []
    steps: []
  - title: Add integration tests for plan file operations
    done: true
    description: "Create integration tests that: (1) load existing plan files
      without `discoveredFrom` and verify no errors, (2) create and save new
      plans with `discoveredFrom` field, (3) round-trip plans with
      `discoveredFrom` through save/load cycle, (4) verify the field appears in
      loaded plan objects."
    files: []
    docs: []
    steps: []
  - title: Add discoveredFrom validation to validate command
    done: true
    description: "Update `src/rmplan/commands/validate.ts` to: (1) check that
      `discoveredFrom` references point to existing plans (similar to dependency
      validation), (2) warn about orphaned discoveries (references to
      non-existent plans), (3) report validation errors clearly with plan ID and
      referenced plan ID."
    files: []
    docs: []
    steps: []
  - title: Run full test suite and type checking
    done: true
    description: Execute `bun test` to verify all tests pass and `bun run check` to
      ensure TypeScript compilation succeeds with no errors. Fix any issues
      found.
    files: []
    docs: []
    steps: []
changedFiles:
  - README.md
  - src/rmplan/commands/ready.test.ts
  - src/rmplan/commands/ready.ts
  - src/rmplan/commands/validate.test.ts
  - src/rmplan/commands/validate.ts
  - src/rmplan/fix_yaml.test.ts
  - src/rmplan/mcp/generate_mode.test.ts
  - src/rmplan/mcp/generate_mode.ts
  - src/rmplan/planSchema.ts
  - src/rmplan/plans.test.ts
  - src/rmplan/plans.ts
  - src/rmplan/rmplan.ts
rmfilter: []
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

<!-- rmplan-generated-start -->
# Add discoveredFrom Schema Field and Inverse Relationship Utilities

## Expected Behavior/Outcome

After implementation, the rmplan system will:

1. **Track Discovery Lineage**: Plans can record which plan led to discovering them during research/implementation via the `discoveredFrom` field
2. **Compute Inverse Relationships**: Three new utility functions will provide efficient reverse lookups:
   - `getBlockedPlans()`: Find all plans that depend on a given plan
   - `getChildPlans()`: Find all child plans of a parent
   - `getDiscoveredPlans()`: Find all plans discovered from a source plan
3. **Maintain Data Integrity**: Validation ensures `discoveredFrom` references point to existing plans
4. **Preserve Backward Compatibility**: Existing plan files without the new field continue to work

### State Definitions

- **discoveredFrom**: Optional positive integer referencing the plan ID that led to discovering this issue
- **Inverse relationships**: Computed at runtime by filtering the plan map, never stored to disk

## Key Findings

### Product & User Story

**User Story**: As an autonomous agent implementing a plan, I need to track which new issues I discover during research or implementation, so that the system can understand how work expands organically and maintain proper context for future decisions.

**Business Value**: 
- Enables transparent audit trails for work expansion
- Supports autonomous agent decision-making about scope management
- Prevents data duplication while maintaining relationship visibility

### Design & UX Approach

**Design Philosophy**: Single-direction storage, runtime computation for inverse lookups

**Why This Approach**:
- Storing only `discoveredFrom` (not inverse `discoveredPlans[]`) eliminates sync issues
- Storing only `parent` (not inverse `children[]`) prevents redundancy
- Using existing `dependencies` (not adding `blocked_by` or `blocks`) reduces complexity
- Runtime computation is cheap: plans are already loaded into memory for most operations

**Performance Considerations**:
- Linear scan O(n) for inverse lookups is acceptable given typical plan counts (<1000)
- Plans are already loaded into `Map<number, PlanSchema>` for commands
- Future optimization: maintain inverse indexes in memory if needed

### Technical Plan & Risks

**Implementation Sequence**:
1. Schema changes first (foundation for everything else)
2. Utility functions second (tested independently)
3. Validation updates third (ensures data integrity)
4. Integration testing fourth (confirms no regressions)

**Risks & Mitigations**:
- **Risk**: Existing plan files might fail validation
  - **Mitigation**: Make `discoveredFrom` optional; test against real plan files
- **Risk**: Circular reference bugs in utility functions
  - **Mitigation**: Explicit test cases for cycles; functions only read, never traverse
- **Risk**: Performance degradation with large plan sets
  - **Mitigation**: Benchmark with 1000+ plan simulation; optimize if needed

**Files Modified**:
- `src/rmplan/planSchema.ts`: Add `discoveredFrom` field (~5 lines)
- `src/rmplan/plans.ts`: Add 3 utility functions (~60 lines with docs)
- `src/rmplan/plans.test.ts`: Add comprehensive tests (~150 lines)
- `src/rmplan/commands/validate.ts`: Add `discoveredFrom` validation (~30 lines)

### Pragmatic Effort Estimate

**Complexity**: Low-Medium
- Schema change: Trivial (single optional field)
- Utility functions: Simple (filter operations)
- Testing: Moderate (need good coverage for edge cases)
- Validation: Simple (similar to existing dependency validation)

**Estimated Time**: 2-3 hours
- Schema + utilities: 30 minutes
- Comprehensive tests: 1 hour
- Validation logic: 30 minutes
- Integration testing + docs: 30-60 minutes

## Acceptance Criteria

### Functional Criteria
- [ ] Plans can include a `discoveredFrom` field referencing another plan ID
- [ ] `getBlockedPlans(planId)` returns all plans with `planId` in their `dependencies` array
- [ ] `getChildPlans(planId)` returns all plans with `parent` equal to `planId`
- [ ] `getDiscoveredPlans(planId)` returns all plans with `discoveredFrom` equal to `planId`
- [ ] The `validate` command checks `discoveredFrom` references and warns about orphans

### UX Criteria
- [ ] Existing plan files without `discoveredFrom` load without errors or warnings
- [ ] New plans with valid `discoveredFrom` save and load correctly
- [ ] Validation warnings clearly indicate when `discoveredFrom` references missing plans

### Technical Criteria
- [ ] Schema accepts positive integers for `discoveredFrom` and rejects invalid values
- [ ] Utility functions handle edge cases: empty maps, missing plans, circular references
- [ ] All new code paths are covered by tests with >90% coverage
- [ ] Type safety: All functions properly typed with `PlanSchema & { filename: string }`
- [ ] Performance: Utility functions execute in <10ms for 1000 plans

### Testing Criteria
- [ ] Unit tests for schema validation (valid/invalid `discoveredFrom` values)
- [ ] Unit tests for each utility function (happy path + edge cases)
- [ ] Integration tests verify backward compatibility with existing plans
- [ ] Edge case tests: circular references, orphaned discoveries, empty sets

## Dependencies & Constraints

### Dependencies
- **No blocking dependencies**: This plan is foundational and can be implemented immediately
- **Enables future plans**: Plans 130, 133, and 135 depend on these schema changes

### Technical Constraints
- **Backward compatibility required**: Cannot break existing plan files or commands
- **Type safety required**: All TypeScript compilation must pass with strict mode
- **No breaking changes**: Existing commands and MCP tools must continue working

### Design Constraints
- **No redundant storage**: Inverse relationships computed at runtime, not stored
- **No new CLI commands yet**: Utilities are internal; CLI exposure comes in plan 133
- **MCP transparency**: MCP server requires no changes for this plan

## Implementation Notes

### Recommended Approach

**Phase 1: Schema Changes**
1. Add `discoveredFrom` field to `phaseSchema` in `src/rmplan/planSchema.ts`
2. Place after the `parent` field for logical grouping
3. Use `z.coerce.number().int().positive().optional()` for validation
4. Add descriptive `.describe()` text for documentation

**Phase 2: Utility Functions**
1. Add all three functions to `src/rmplan/plans.ts` together
2. Use consistent function signatures: `(planId: number, allPlans: Map<...>) => Array<...>`
3. Include comprehensive JSDoc comments with `@param` and `@returns`
4. Use `Array.from(allPlans.values()).filter()` pattern for consistency

**Phase 3: Testing**
1. Start with schema validation tests (simplest)
2. Add utility function unit tests with fixtures
3. Create integration tests with real plan file operations
4. Add edge case tests last (empty maps, cycles, etc.)

**Phase 4: Validation Updates**
1. Study existing dependency validation in `validate.ts`
2. Mirror that pattern for `discoveredFrom` validation
3. Add clear warning messages for orphaned discoveries
4. Consider auto-fix option (optional, can defer to later)

### Potential Gotchas

1. **Map Iteration Order**: `Map.values()` maintains insertion order, but don't rely on it. Sort results if order matters.

2. **Type Consistency**: The pattern `PlanSchema & { filename: string }` appears throughout the codebase. Ensure all utility functions use this exact type.

3. **Optional Field Handling**: `discoveredFrom` is optional, so filters need `=== planId`, not truthy checks.

4. **Circular References**: While unlikely with `discoveredFrom`, test that utilities don't infinite loop if they exist.

5. **Performance Testing**: With `ModuleMocker` limitations, create real fixtures for performance tests rather than mocking the Map.

6. **Validation Timing**: The `validate` command loads all plans into memory anyway, so `discoveredFrom` checking is essentially free.

### Example Test Fixture

```typescript
const testPlans = new Map<number, PlanSchema & { filename: string }>([
  [1, { id: 1, title: 'Parent Plan', status: 'done', filename: 'tasks/1.plan.md' }],
  [2, { id: 2, title: 'Child Plan', parent: 1, status: 'pending', filename: 'tasks/2.plan.md' }],
  [3, { id: 3, title: 'Discovered Plan', discoveredFrom: 1, status: 'pending', filename: 'tasks/3.plan.md' }],
  [4, { id: 4, title: 'Blocked Plan', dependencies: [1], status: 'pending', filename: 'tasks/4.plan.md' }],
]);
```

### Conflicting, Unclear, or Impossible Requirements

**None identified.** The requirements are clear and well-scoped:
- Single field addition with obvious semantics
- Utility functions mirror existing patterns in the codebase
- Validation follows established dependency validation approach
- No breaking changes required
<!-- rmplan-generated-end -->

Implemented 'Add discoveredFrom field to plan schema', 'Implement getBlockedPlans utility function', 'Implement getChildPlans utility function', 'Implement getDiscoveredPlans utility function', 'Add schema validation tests for discoveredFrom', 'Add unit tests for getBlockedPlans', 'Add unit tests for getChildPlans', 'Add unit tests for getDiscoveredPlans', 'Add edge case tests for utility functions', 'Add integration tests for plan file operations', 'Add discoveredFrom validation to validate command', and 'Run full test suite and type checking'. Added an optional discoveredFrom field in src/rmplan/planSchema.ts to persist plan discovery lineage while maintaining backward compatibility. Implemented new inverse lookup helpers in src/rmplan/plans.ts that compute dependents, child plans, and discovered plans on demand from the plan map. Expanded src/rmplan/plans.test.ts with schema validation coverage, comprehensive unit tests for the new helpers (including cycles, missing references, and large data sets), and integration checks that ensure legacy files load while newly written plans round-trip the discoveredFrom field. Updated src/rmplan/commands/validate.ts to detect orphaned discovery references, optionally auto-remove them via a new fixDiscoveredFromReferences helper, and surface the results in command output and summary counters. Added matching tests in src/rmplan/commands/validate.test.ts that cover success, autofix, and --no-fix modes to guard the new behaviour. Verified the changes with bun run check, bun test, and bun run format.
