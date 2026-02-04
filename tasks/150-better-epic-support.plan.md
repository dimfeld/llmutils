---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: better epic support
goal: Rename 'container' to 'epic', add epic display in show/list commands, and
  add epic filtering to list/ready commands
id: 150
uuid: db330154-2628-4559-8f5f-bcaa4358505b
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2025-12-30T08:22:02.941Z
promptsGeneratedAt: 2025-12-30T08:22:02.941Z
createdAt: 2025-12-29T01:23:04.821Z
updatedAt: 2025-12-30T09:36:53.992Z
tasks:
  - title: "Phase 1: Schema Migration - Add epic field to planSchema.ts"
    done: true
    description: "Add `epic: z.boolean().default(false).optional()` field alongside
      deprecated `container` field. Keep container for backward compatibility
      reading."
  - title: "Phase 1: Update readPlanFile() to normalize container→epic"
    done: true
    description: "In plans.ts readPlanFile(), after Zod parsing, normalize container
      to epic: if container is true and epic is not set, set epic=true. Remove
      container from the in-memory object."
  - title: "Phase 1: Update writePlanFile() to remove container and write epic"
    done: true
    description: In plans.ts writePlanFile(), delete cleanedPlan.container always,
      and only write epic when true (delete when false).
  - title: "Phase 1: Update all container references to epic in code"
    done: true
    description: Update split.ts, merge.ts, promote.ts, show.ts, list.ts,
      mark_done.ts, parent_plans.ts, plan_merge.ts, process_markdown.ts, and
      mcp/generate_mode.ts to use `epic` instead of `container`.
  - title: "Phase 1: Update tests to use epic instead of container"
    done: true
    description: "Update split.test.ts, merge.test.ts, parent_completion.test.ts,
      generate_mode.test.ts to use `epic: true` instead of `container: true`."
  - title: "Phase 2: Add epic chain display to show command"
    done: true
    description: In show.ts, use getParentChain() to find any indirect epic parent
      and display it if the direct parent is not the epic.
  - title: "Phase 2: Add Epic column to list command"
    done: true
    description: In list.ts, add a new 'Epic' column showing the epic ID (from
      parent chain) or '-' if no epic exists.
  - title: "Phase 3: Add isUnderEpic helper to hierarchy.ts"
    done: true
    description: Create isUnderEpic(plan, epicId, allPlans) function that returns
      true if epicId is anywhere in the plan's parent chain.
  - title: "Phase 3: Add --epic filter to list command"
    done: true
    description: In list.ts, add --epic <id> option and filter using isUnderEpic()
      to show only plans under that epic.
  - title: "Phase 3: Add --epic filter to ready command"
    done: true
    description: In ready.ts, add --epic <id> option and filter using isUnderEpic()
      to show only ready plans under that epic.
  - title: "Phase 3: Add epic filter to ready_plans.ts and MCP"
    done: true
    description: Add epicId to ReadyPlanFilterOptions, update
      filterAndSortReadyPlans(), add epic parameter to MCP list-ready-plans
      tool, and update mcpListReadyPlans().
  - title: "Phase 3: Update MCP create-plan to use epic instead of container"
    done: true
    description: In generate_mode.ts, change container parameter to epic in
      createPlanParameters and mcpCreatePlan().
changedFiles:
  - README.md
  - schema/tim-plan-schema.json
  - src/tim/commands/agent/parent_completion.test.ts
  - src/tim/commands/agent/parent_plans.ts
  - src/tim/commands/generate.test.ts
  - src/tim/commands/import/plan_file_validation.test.ts
  - src/tim/commands/list.test.ts
  - src/tim/commands/list.ts
  - src/tim/commands/merge.test.ts
  - src/tim/commands/merge.ts
  - src/tim/commands/promote.ts
  - src/tim/commands/ready.test.ts
  - src/tim/commands/ready.ts
  - src/tim/commands/show.test.ts
  - src/tim/commands/show.ts
  - src/tim/commands/split.test.ts
  - src/tim/commands/split.ts
  - src/tim/mcp/README.md
  - src/tim/mcp/generate_mode.test.ts
  - src/tim/mcp/generate_mode.ts
  - src/tim/planSchema.ts
  - src/tim/plan_display.test.ts
  - src/tim/plan_merge.ts
  - src/tim/plans/mark_done.ts
  - src/tim/plans.test.ts
  - src/tim/plans.ts
  - src/tim/process_markdown.ts
  - src/tim/process_markdown_container_update.test.ts
  - src/tim/ready_plans.test.ts
  - src/tim/ready_plans.ts
  - src/tim/tim.ts
  - src/tim/utils/hierarchy.test.ts
  - src/tim/utils/hierarchy.ts
tags: []
---

- Rename "container" to "epic". In the data model, add both for backwards compatibility but...
  - when writing a plan always use "epic: true" instead of container: true and in `writePlanFile` explicitly remove container and add epic.
  - when reading a plan, set epic = true if container = true
  - see if some of this can be automated using Zod, by adding a preprocess function that looks for container: true and sets epic: true
- Make it easier to show the epic a task even if it's an indirect parent
- Add a filter to the list and ready commands that lists based on the epic of a task (although this can really take any parent plan)

## Implementation Guide

### Expected Behavior/Outcome

After implementation:
1. **Schema Migration**: The `container` field is renamed to `epic` across the codebase. Existing plan files with `container: true` continue to work (read as `epic: true`), and all new writes use `epic: true`.
2. **Epic Display**: When showing a plan, users can easily see which epic the plan belongs to, even if the epic is an indirect parent (e.g., grandparent).
3. **Epic Filtering**: The `list` and `ready` commands support a `--epic <id>` flag to filter plans that belong to a specific epic (or any parent hierarchy).

### Key Findings

#### Product & User Story
- **Epic/Container Purpose**: Marks parent plans that exist only to organize child plans (no direct implementation tasks)
- **Auto-Completion**: Container/epic parents automatically mark as 'done' when all children complete
- **Visual Distinction**: CLI shows "CTR" (or will show "EPIC") instead of task count for epic plans
- **Hierarchy Support**: Existing parent-child traversal functions already support finding indirect parents

#### Design & UX Approach
- The term "epic" better communicates the organizational purpose than "container"
- Epic filter on list/ready commands follows existing patterns for tag/priority filters
- Display of "epic chain" in show command similar to existing parent display

#### Technical Plan & Risks
- **Low Risk**: Post-parse normalization in readPlanFile() is simple and testable
- **Low Risk**: writePlanFile already has cleanup logic for boolean defaults
- **Medium Risk**: Need to update all places that check/display container to use epic
- **Critical Files**: planSchema.ts, plans.ts, list.ts, ready.ts, ready_plans.ts, show.ts, mcp/generate_mode.ts

#### Pragmatic Effort Estimate
Three logical phases of work that can be done independently.

---

### Acceptance Criteria

- [ ] **Schema Migration**: `epic: true` is written instead of `container: true` in plan files
- [ ] **Backward Compatibility**: Plans with `container: true` are read correctly as `epic: true`
- [ ] **CLI Display**: All places showing "container" now show "epic" (or appropriate variation)
- [ ] **Epic Filter in `list`**: `tim list --epic <id>` filters to plans under that epic (direct or indirect)
- [ ] **Epic Filter in `ready`**: `tim ready --epic <id>` filters ready plans under that epic
- [ ] **MCP Update**: `list-ready-plans` MCP tool accepts `epic` filter parameter
- [ ] **MCP Create**: `create-plan` MCP tool accepts `epic` instead of `container`
- [ ] **Show Command Epic Chain**: `tim show <id>` displays the epic hierarchy path
- [ ] **All new code paths are covered by tests**

---

### Dependencies & Constraints

- **Dependencies**: Uses existing hierarchy functions in `src/tim/utils/hierarchy.ts` (getParentChain, getAllChildren)
- **Technical Constraints**: Must maintain backward compatibility with existing plan files using `container: true`
- **Testing**: Must update existing tests that reference "container" and add new tests for epic functionality

---

### Implementation Notes

#### Codebase Architecture Overview

The tim system uses:
- **Zod schemas** in `planSchema.ts` for type validation with `.passthrough()` for forward compatibility
- **Manual YAML frontmatter parsing** (not gray-matter) - starts with `---\n`, ends with `\n---\n`
- **In-memory caching** for plan reads (bypass with `readCache=false` parameter)
- **Bidirectional parent-child sync**: When creating child plans, parent's dependencies array is automatically updated

#### Key Files and Their Roles

| File | Purpose | Changes Required |
|------|---------|------------------|
| `src/tim/planSchema.ts` | Zod schema definition | Add `epic` field with preprocess for container |
| `src/tim/plans.ts` | Plan file I/O | Update `writePlanFile()` to prefer `epic` over `container` |
| `src/tim/commands/list.ts` | List command | Add `--epic` filter option |
| `src/tim/commands/ready.ts` | Ready command | Add `--epic` filter option |
| `src/tim/ready_plans.ts` | Ready plan filtering utilities | Add epic filter to `ReadyPlanFilterOptions` |
| `src/tim/commands/show.ts` | Show command | Display epic chain for plans with indirect epic parents |
| `src/tim/mcp/generate_mode.ts` | MCP tool definitions | Update parameters and handlers |
| `src/tim/utils/hierarchy.ts` | Parent-child traversal | Already has needed functions |

---

### Detailed Implementation Steps

#### Phase 1: Schema Migration (container → epic)

**Step 1.1: Update planSchema.ts**

Location: `src/tim/planSchema.ts:54`

Current:
```typescript
container: z.boolean().default(false).optional(),
```

Change to (keep both fields for reading old files):
```typescript
container: z.boolean().optional(),  // Deprecated, for reading old files only
epic: z.boolean().default(false).optional(),
```

**Step 1.1b: Handle container→epic normalization in readPlanFile() (RECOMMENDED)**

Location: `src/tim/plans.ts` after `phaseSchema.safeParse()` (around line 587)

Add after `const plan = result.data;`:
```typescript
// Normalize deprecated container field to epic
if (plan.container && !plan.epic) {
  plan.epic = plan.container;
}
// Remove deprecated field from in-memory object
delete (plan as any).container;
```

**Step 1.2: Update writePlanFile() in plans.ts**

Location: `src/tim/plans.ts:641-649`

Current cleanup logic:
```typescript
// Remove false boolean defaults
if (cleanedPlan.container === false) {
  delete cleanedPlan.container;
}
```

Change to:
```typescript
// Remove deprecated 'container' field - always use 'epic' instead
delete cleanedPlan.container;

// Remove false boolean defaults for epic
if (cleanedPlan.epic === false) {
  delete cleanedPlan.epic;
}
```

And ensure that when `epic: true`, it's written to the file (it already will be if we just set it on the plan object).

**Step 1.3: Update all "container" references in TypeScript code**

Files to update (search for `container`):
- `src/tim/commands/split.ts:152` - Change `parent.container = true` to `parent.epic = true`
- `src/tim/commands/merge.ts:146-149` - Change `mainPlan.container` references
- `src/tim/commands/promote.ts:147-152` - Change `container: !updatedTasks.length` to `epic: !updatedTasks.length`
- `src/tim/commands/show.ts:281-286,550-553` - Update display text from "container" to "epic"
- `src/tim/commands/list.ts:433` - Change `plan.container ? 'CTR'` to `plan.epic ? 'EPIC'` (or keep CTR)
- `src/tim/plans/mark_done.ts:489-492` - Change `parentPlan.container` to `parentPlan.epic`
- `src/tim/commands/agent/parent_plans.ts:94-97` - Change `parentPlan.container` to `parentPlan.epic`
- `src/tim/plan_merge.ts:210-214` - Change `container: originalPlan.container` to `epic: originalPlan.epic`
- `src/tim/process_markdown.ts:310-323,551-559` - Update `'container'` in fieldsToPreserve arrays to `'epic'`
- `src/tim/mcp/generate_mode.ts:415-420,778-779` - Update parameter name and description

**Step 1.4: Update Types**

The `PlanSchema` type is inferred from the Zod schema, so it will automatically have `epic` instead of `container` after the schema change. However, check for any explicit type definitions that reference `container`.

**Step 1.5: Update Tests**

Files with container-related tests:
- `src/tim/commands/split.test.ts` - Lines 80, 303
- `src/tim/commands/merge.test.ts` - Lines 59, 146
- `src/tim/commands/agent/parent_completion.test.ts` - Lines 69-74, 141, 185-195, 230-250
- `src/tim/mcp/generate_mode.test.ts` - Lines 1626, 1654

---

#### Phase 2: Epic Display in Show Command

**Step 2.1: Add Epic Chain Display**

Location: `src/tim/commands/show.ts`

The show command already displays the direct parent (lines 363-373). Enhance to show the full epic chain:

```typescript
// After showing direct parent, show epic chain if there's an indirect epic
import { getParentChain } from '../utils/hierarchy.js';

// In the display section:
const parentChain = getParentChain(plan, plans);
const epicParent = parentChain.find(p => p.epic);

if (epicParent && epicParent.id !== plan.parent) {
  // There's an indirect epic parent
  output.push(`  Epic: ${chalk.cyan(`[${epicParent.id}]`)} ${epicParent.title || epicParent.goal}`);
}
```

**Step 2.2: Add Epic Column to List Command**

Location: `src/tim/commands/list.ts`

Add a new "Epic" column showing the epic ID from the parent chain:

1. Add to headers array (around line 290):
```typescript
chalk.bold('Epic'),  // Add after 'ID' column
```

2. Add Epic ID calculation and column value in the data rows section (around line 416):
```typescript
import { getParentChain } from '../utils/hierarchy.js';

// For each plan in the loop:
const parentChain = getParentChain(plan, enrichedPlans);
const epicParent = parentChain.find(p => p.epic);
const epicDisplay = epicParent ? chalk.cyan(String(epicParent.id)) : '-';

// Add to row array after ID:
epicDisplay,
```

3. Update table configuration for column widths

---

#### Phase 3: Epic Filtering

**Step 3.1: Add Helper Function to Find Plans Under Epic**

Create a utility function in `src/tim/utils/hierarchy.ts`:

```typescript
/**
 * Checks if a plan belongs to a given epic (directly or indirectly).
 * Returns true if the epic is anywhere in the plan's parent chain.
 */
export function isUnderEpic(
  plan: PlanWithFilename,
  epicId: number,
  allPlans: Map<number, PlanWithFilename>
): boolean {
  const parentChain = getParentChain(plan, allPlans);
  return parentChain.some(p => p.id === epicId);
}
```

**Step 3.2: Add --epic Filter to List Command**

Location: `src/tim/commands/list.ts`

Add to options (around line 33 in the command definition):
```typescript
.option('--epic <id>', 'Filter plans belonging to this epic (directly or indirectly)')
```

Add filtering logic after line 162 (following the tag filter pattern):
```typescript
import { isUnderEpic } from '../utils/hierarchy.js';

// After tag filter
if (options.epic) {
  const epicId = parseInt(options.epic, 10);
  if (isNaN(epicId)) {
    throw new Error(`Invalid epic ID: ${options.epic}`);
  }

  // Verify epic exists
  const epicPlan = plans.get(epicId);
  if (!epicPlan) {
    throw new Error(`Epic plan ${epicId} not found`);
  }

  planArray = planArray.filter((plan) =>
    plan.id === epicId || isUnderEpic(plan, epicId, enrichedPlans)
  );
}
```

**Step 3.3: Add --epic Filter to Ready Command**

Location: `src/tim/commands/ready.ts`

Similar pattern to list command:
1. Add option definition
2. Add filter after tag filtering (around line 525)

**Step 3.4: Add Epic Filter to ready_plans.ts**

Location: `src/tim/ready_plans.ts:18-24`

Update `ReadyPlanFilterOptions`:
```typescript
export interface ReadyPlanFilterOptions {
  pendingOnly?: boolean;
  priority?: PlanSchema['priority'];
  limit?: number;
  sortBy?: ReadyPlanSortField;
  reverse?: boolean;
  epicId?: number;  // NEW: Filter to plans under this epic
}
```

Update `filterAndSortReadyPlans()` (around line 190):
```typescript
if (options.epicId) {
  candidates = candidates.filter((plan) =>
    plan.id === options.epicId || isUnderEpic(plan, options.epicId, allPlans)
  );
}
```

**Step 3.5: Add Epic Filter to MCP list-ready-plans Tool**

Location: `src/tim/mcp/generate_mode.ts`

Update `listReadyPlansParameters` (around line 395):
```typescript
epic: z.number().int().positive().optional()
  .describe('Filter to plans belonging to this epic (directly or indirectly)'),
```

Update `mcpListReadyPlans()` in `src/tim/commands/ready.ts` to pass epic parameter.

**Step 3.6: Update MCP create-plan Tool**

Location: `src/tim/mcp/generate_mode.ts:415-420`

Change `container` parameter to `epic`:
```typescript
epic: z
  .boolean()
  .optional()
  .describe(
    'Mark plan as an epic for organizing children plans with no implementation work in the plan itself'
  ),
```

Update handler at lines 778-779:
```typescript
epic: args.epic || false,
```

---

### Potential Gotchas

1. **Zod Preprocess Complexity**: The recommended approach for backward compatibility is to handle `container → epic` migration in `readPlanFile()` after parsing, rather than trying to do it in Zod preprocess (which has limitations with accessing raw input).

2. **Test File Updates**: Tests that create plan files with `container: true` will need to be updated. Search for `container: true` in test files.

3. **Schema JSON File**: If there's a JSON schema file at `schema/tim-plan-schema.json`, it needs to be updated to include `epic` and deprecate `container`.

4. **Documentation**: The README and any other documentation mentioning "container" should be updated to use "epic".

5. **MCP Client Compatibility**: Changing `container` to `epic` in the MCP `create-plan` tool parameters could break existing MCP clients. Consider accepting both for a transition period.

---

### Manual Testing Steps

1. **Migration Test**:
   - Create a plan with `container: true` in the YAML
   - Run `tim show <id>` - should display as epic
   - Edit any field and save - file should now have `epic: true` instead of `container: true`

2. **Epic Filter Test**:
   - Create an epic plan (id=100) with `epic: true`
   - Create child plans (parent: 100)
   - Create grandchild plans (parent: child_id)
   - Run `tim list --epic 100` - should show all plans in hierarchy
   - Run `tim ready --epic 100` - should show only ready plans in hierarchy

3. **Show Command Epic Chain Test**:
   - Create a 3-level hierarchy: Epic → Phase → Task
   - Run `tim show <task_id>`
   - Verify it shows both direct parent and the epic ancestor

4. **MCP Test**:
   - Call `create-plan` with `epic: true`
   - Verify plan file has `epic: true`
   - Call `list-ready-plans` with `epic: <id>` filter
   - Verify only plans under that epic are returned

Completed Phase 1 work for the epic rename: Phase 1: Schema Migration - Add epic field to planSchema.ts; Phase 1: Update readPlanFile() to normalize container→epic; Phase 1: Update writePlanFile() to remove container and write epic; Phase 1: Update all container references to epic in code; Phase 1: Update tests to use epic instead of container. In src/tim/planSchema.ts I added epic as a defaulted boolean and kept container optional for backward compatibility. In src/tim/plans.ts readPlanFile now normalizes legacy container=true into epic=true and strips container from the in-memory object, while writePlanFile always deletes container and only persists epic when true to ensure new files use epic. I updated plan-writing call sites to set epic instead of container (split/promote/merge/mark_done/parent_plans) and adjusted display text and task column logic to reference epic (show/list). In src/tim/process_markdown.ts I renamed preserved fields from container to epic so updates do not reintroduce container, and in src/tim/plan_merge.ts I carried epic forward when merging. MCP create-plan now accepts epic (with a deprecated container parameter for compatibility) and writes epic via src/tim/mcp/generate_mode.ts, with docs updated in src/tim/mcp/README.md. I also updated the JSON schema in schema/tim-plan-schema.json to add epic and remove the container default so YAML validation matches the new field. Tests were adjusted across plan IO, import validation, merge/split, parent completion, MCP generate mode, plan display, ready plans, and generate command fixtures to assert epic instead of container. This keeps existing container plan files readable while ensuring all new writes and logic use epic.

Implemented shared container->epic normalization for non-readPlanFile flows. Added normalizeContainerToEpic in src/tim/planSchema.ts and used it in src/tim/process_markdown.ts before planSchema.safeParse plus in src/tim/plans.ts inside readPlanFile and writePlanFile so container:true inputs become epic:true and container is dropped before writing. Added regression coverage in src/tim/process_markdown_container_update.test.ts to exercise extractMarkdownToYaml update mode with container:true and assert the front matter includes epic:true and omits container. Tasks worked on: Phase 1: normalize legacy container inputs in non-readPlanFile flows; Phase 1: add regression coverage for LLM update path container migration. This keeps backward compatibility for legacy container flags while ensuring new writes stay on epic.

Implemented Phase 2/3 epic display and filtering features for tim. Tasks covered: Task 6 (show epic chain), Task 7 (list Epic column), Task 8 (isUnderEpic helper), Task 9 (list --epic filter), Task 10 (ready --epic filter), Task 11 (ready_plans + MCP epic filtering). Added the isUnderEpic helper in src/tim/utils/hierarchy.ts (using getParentChain) and extended ready_plans filtering via epicId in src/tim/ready_plans.ts so both CLI and MCP flows can share the logic. Updated tim list/ready CLI parsing in src/tim/tim.ts to accept --epic <id>, and implemented filtering in src/tim/commands/list.ts and src/tim/commands/ready.ts to include plans under the specified epic (or any parent chain), while validating epic IDs and preserving existing tag/status filters. Added an Epic column to tim list output in src/tim/commands/list.ts (computed from parent chain) and adjusted table sizing/indexing; show command now computes an epic chain from parent hierarchy and displays it in both short and full output (src/tim/commands/show.ts). Updated MCP list-ready-plans parameter schema in src/tim/mcp/generate_mode.ts and forwarded epic to filterAndSortReadyPlans in src/tim/commands/ready.ts so MCP clients can filter by epic. Updated README.md to document the new --epic filters and examples. Added/updated tests in src/tim/utils/hierarchy.test.ts (isUnderEpic coverage), src/tim/ready_plans.test.ts (epicId filtering), src/tim/commands/list.test.ts (Epic column + list --epic), src/tim/commands/ready.test.ts (ready --epic), src/tim/commands/show.test.ts (epic chain display), and src/tim/mcp/generate_mode.test.ts (MCP list-ready-plans epic filter), plus adjusted list column index assertions for the new Epic column.

Task 12 (Phase 3: Update MCP create-plan to use epic instead of container): Updated the MCP create-plan tool schema in src/tim/mcp/generate_mode.ts to treat legacy container input via normalizeContainerToEpic (imported from src/tim/planSchema.ts) so old clients still work but the published tool parameters only expose epic. This is done by wrapping the createPlanParameters Zod object in a preprocess effect that strips container and sets epic when needed, then updating mcpCreatePlan to rely solely on args.epic (no container field on the typed arguments). Added regression coverage in src/tim/mcp/generate_mode.test.ts to parse container:true through createPlanParameters and assert the resulting plan is written with epic: true. This keeps MCP compatibility while aligning the tool contract with the new epic naming, matching the rest of the epic migration work and ensuring create-plan writes do not reintroduce container.

Addressed the reviewer-flagged legacy container/epic normalization bug for MCP create-plan (Phase 3: Update MCP create-plan to use epic instead of container / Task 12). Updated src/tim/planSchema.ts normalizeContainerToEpic to only promote when container === true and epic is unset (null/undefined), eliminating truthy coercion and preventing explicit epic: false from being overridden. Reworked the MCP create-plan parameter schema in src/tim/mcp/generate_mode.ts to validate the deprecated container flag as a boolean (marked as deprecated), then transform the parsed args through normalizeContainerToEpic so CreatePlanArguments remains epic-only while blocking invalid container types. Added regression coverage in src/tim/mcp/generate_mode.test.ts for non-boolean container input rejection and for container: true + epic: false preserving epic false, alongside the existing legacy mapping test. Ran bun run format and bun test src/tim/mcp/generate_mode.test.ts to confirm formatting and behavior.
