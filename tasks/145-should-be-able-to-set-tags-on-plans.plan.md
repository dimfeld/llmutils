---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Should be able to set tags on plans
goal: ""
id: 145
uuid: 3206a9ea-0d0a-4aaf-8733-fe1c69203f7b
generatedBy: agent
simple: false
status: in_progress
priority: medium
container: false
temp: false
dependencies: []
references: {}
issue: []
pullRequest: []
docs: []
planGeneratedAt: 2025-11-07T18:28:25.095Z
promptsGeneratedAt: 2025-11-07T18:28:25.095Z
createdAt: 2025-11-07T18:16:10.651Z
updatedAt: 2025-11-08T03:04:35.162Z
progressNotes:
  - timestamp: 2025-11-08T02:39:46.849Z
    text: Added tags schema/config fields, normalization helpers, and CLI plumbing
      for add/set with validation; updating tests next.
    source: "implementer: tasks 1-5"
  - timestamp: 2025-11-08T02:41:04.731Z
    text: Finished CLI, docs, and tests for tag creation/removal; added
      normalization + allowlist validation.
    source: "implementer: tasks 1-5"
  - timestamp: 2025-11-08T02:45:10.972Z
    text: Ran bun test for planSchema/add/set suites; all passing (64 tests).
    source: "tester: initial"
  - timestamp: 2025-11-08T02:48:51.949Z
    text: Added new tests covering normalizeTags/validateTags plus config
      schema/loader allowlist handling.
    source: "tester: Step1"
  - timestamp: 2025-11-08T02:49:30.512Z
    text: Ran targeted Bun tests covering config loader/schema, tag utilities, and
      split/promote suites (163 tests) – all green.
    source: "tester: Step3"
tasks:
  - title: Add tags field to plan schemas
    done: true
    description: "Add `tags: z.array(z.string()).default([]).optional()` to
      PlanSchema in src/rmplan/planSchema.ts and add corresponding field to
      schema/rmplan-plan-schema.json with type array of strings. This
      establishes the foundation for tag support across the codebase."
  - title: Add tag normalization utility function
    done: true
    description: "Create a `normalizeTags(tags: string[]): string[]` utility
      function that converts tags to lowercase, removes empty strings, removes
      duplicates, and sorts them. Place in src/rmplan/planSchema.ts or a shared
      utility file. This ensures consistent tag handling across all entry
      points."
  - title: Update planPropertiesUpdater for tag operations
    done: true
    description: "In src/rmplan/planPropertiesUpdater.ts, add handling for `tag` and
      `noTag` options. For additions: validate tags using validateTags,
      deduplicate with existing tags using Set, and sort. For removals: filter
      out specified tags and track if modifications were made. Pass config
      parameter through for validation. Follow the pattern used for issue/docs
      fields."
  - title: Add tag options to set command
    done: true
    description: "In src/rmplan/commands/set.ts, add `tag?: string[]` and `noTag?:
      string[]` to SetOptions interface. Add corresponding CLI flags `--tag`
      (repeatable) and `--no-tag` (repeatable). Load config and pass to
      updatePlanProperties for validation. Handle validation errors gracefully
      with helpful error messages."
  - title: Add tag option to add command
    done: true
    description: "In src/rmplan/commands/add.ts, add `tag?: string[]` to AddOptions
      interface and add CLI flag `--tag` (repeatable). When creating new plans,
      validate and normalize tags using validateTags with loaded config. Set
      initial tags in the plan object before writing. Handle validation errors
      with clear messages."
  - title: Add tag filtering to list command
    done: false
    description: In src/rmplan/commands/list.ts, add `--tag` flag (repeatable) to
      filter plans by tags using OR logic. After loading plans, filter to
      include only plans where plan.tags contains at least one of the specified
      tags. Normalize filter tags to lowercase for comparison. No validation
      needed for filtering (allow filtering by any tag).
  - title: Add tag filtering to ready command
    done: false
    description: "In src/rmplan/commands/ready.ts, add `--tag` flag (repeatable) to
      ReadyOptions. Pass tags filter to getReadyPlans or apply filtering after
      getting ready plans. Use OR logic: include plans that have ANY of the
      specified tags. Normalize filter tags to lowercase. No validation needed
      for filtering."
  - title: Add tags display to show command
    done: false
    description: "In src/rmplan/commands/show.ts, add tags field to the plan detail
      output. Display tags as a comma-separated list or formatted list. Show
      empty state clearly if no tags present (e.g., 'Tags: none' or omit the
      line)."
  - title: Add tags display to list command output
    done: false
    description: In src/rmplan/commands/list.ts, add tags to the display output. For
      table format, consider adding a Tags column or showing inline with title.
      Handle display overflow gracefully (truncate with '...' if needed). For
      JSON format, include tags array.
  - title: Add tags display to ready command output
    done: false
    description: In src/rmplan/commands/ready.ts, add tags to all three output
      formats (list, table, JSON). Follow same display patterns as list command.
      Ensure tags are visible but don't clutter the output.
  - title: Add tags parameter to MCP create-plan tool
    done: false
    description: "In src/rmplan/mcp/generate_mode.ts, add `tags:
      z.array(z.string()).optional()` to createPlanParameters schema (lines
      ~413-428). In mcpCreatePlan implementation (lines ~786-804), load config
      and validate tags using validateTags before setting plan.tags. Handle
      validation errors appropriately for MCP response."
  - title: Add tags filtering to MCP list-ready-plans tool
    done: false
    description: "In src/rmplan/mcp/generate_mode.ts, add `tags:
      z.array(z.string()).optional()` to listReadyPlansParameters schema (lines
      ~387-409). In mcpListReadyPlans implementation (lines ~556-576), apply tag
      filtering with OR logic after getting ready plans. Normalize filter tags
      to lowercase. No validation needed."
  - title: Add tags to MCP list-ready-plans output
    done: false
    description: In src/rmplan/mcp/generate_mode.ts, add tags field to the plan
      object in list-ready-plans output JSON (lines ~209-233). Include the full
      tags array in the response for each plan.
  - title: Write tests for tag schema validation
    done: true
    description: "Add tests to src/rmplan/planSchema.test.ts (or create if needed)
      to verify: tags field accepts string arrays, defaults to empty array,
      rejects non-string values, and handles optional/missing tags field."
  - title: Write tests for set command tag operations
    done: true
    description: "Add tests to src/rmplan/commands/set.test.ts for: adding tags,
      removing tags, tag normalization (uppercase → lowercase), duplicate
      handling, adding and removing in same command, empty tag filtering, and
      validation against allowed tags (both success and failure cases)."
  - title: Write tests for add command tag option
    done: true
    description: "Add tests to src/rmplan/commands/add.test.ts (or create if needed)
      for: creating plans with initial tags, tag normalization during creation,
      default empty tags array, and validation against allowed tags (both
      success and failure cases)."
  - title: Write tests for list command tag filtering
    done: false
    description: "Add tests to src/rmplan/commands/list.test.ts for: filtering by
      single tag, filtering by multiple tags (OR logic), case-insensitive
      matching, plans with no tags excluded from tag filters, and display of
      tags in output."
  - title: Write tests for ready command tag filtering
    done: false
    description: "Add tests to src/rmplan/commands/ready.test.ts for: filtering
      ready plans by tags, OR logic with multiple tags, and tags display in all
      output formats (list, table, JSON)."
  - title: Write tests for MCP tag operations
    done: false
    description: "Add tests to src/rmplan/mcp/generate_mode.test.ts for: create-plan
      with tags parameter, list-ready-plans with tags filter, tag normalization
      in MCP tools, tag validation against allowed tags in MCP tools, and tags
      in output JSON."
  - title: Write integration tests for cross-interface tag consistency
    done: false
    description: "Following the pattern in
      src/rmplan/commands/task-management.integration.test.ts, create tests that
      verify tag operations work consistently across CLI and MCP interfaces.
      Test: create via CLI/filter via MCP, create via MCP/modify via CLI,
      validation works consistently across both interfaces, etc."
changedFiles:
  - README.md
  - schema/rmplan-config-schema.json
  - schema/rmplan-plan-schema.json
  - src/rmplan/commands/add.test.ts
  - src/rmplan/commands/add.ts
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/promote.test.ts
  - src/rmplan/commands/promote.ts
  - src/rmplan/commands/set.test.ts
  - src/rmplan/commands/set.ts
  - src/rmplan/commands/split.test.ts
  - src/rmplan/commands/split.ts
  - src/rmplan/configLoader.test.ts
  - src/rmplan/configLoader.ts
  - src/rmplan/configSchema.test.ts
  - src/rmplan/configSchema.ts
  - src/rmplan/issue_utils.ts
  - src/rmplan/mcp/generate_mode.ts
  - src/rmplan/planPropertiesUpdater.ts
  - src/rmplan/planSchema.test.ts
  - src/rmplan/planSchema.ts
  - src/rmplan/rmplan.ts
  - src/rmplan/utils/cleanup_plan_creator.ts
  - src/rmplan/utils/tags.test.ts
  - src/rmplan/utils/tags.ts
rmfilter: []
tags: []
---

<!-- rmplan-generated-start -->
## Expected Behavior/Outcome

Users can add tags to plans for better organization and filtering. Tags are:
- Stored as an array of lowercase strings in plan metadata
- Added/removed via `rmplan set` command
- Set during plan creation via `rmplan add` and MCP `create-plan` tool
- Filterable in `rmplan list` and `rmplan ready` commands
- Displayed in plan listings and detail views
- Optionally validated against a configured allowlist in rmplan config

**States:**
- Plan has no tags: `tags: []` (default for new/existing plans)
- Plan has tags: `tags: ["frontend", "urgent", "bug"]`
- Filtering active: Shows only plans matching ANY specified tag (OR logic)
- Config has allowed tags: Only tags from the list can be added
- Config has no allowed tags: Any tag can be added

## Key Findings

**Product & User Story:**
As a developer using rmplan, I want to tag plans with labels like "frontend", "backend", "urgent", "bug" so that I can quickly filter and find related plans across my project without relying solely on status, priority, or search terms. I want the option to enforce a specific set of allowed tags across my team to maintain consistency.

**Design & UX Approach:**
- Tags follow the pattern of existing array fields (issue, docs, dependencies)
- CLI commands use `--tag` for adding and `--no-tag` for removing
- All tags normalized to lowercase for consistency
- Multiple tag filters use OR logic (show plans with ANY matching tag)
- Tags displayed inline in list views, similar to other metadata
- Empty tags silently ignored (no error)
- If config defines allowed tags, validate on add/set operations with helpful error messages
- Validation happens at all entry points (CLI and MCP)

**Technical Plan & Risks:**
- Add `tags` field to plan schema (TypeScript + JSON Schema)
- Add `tags.allowed` config option to rmplanConfigSchema
- Extend CLI commands: `add` (initial tags), `set` (modify tags), `list`/`ready` (filter by tags)
- Update MCP tools: `create-plan` parameter, `list-ready-plans` filtering
- Display tags in show/list/ready command outputs
- Tag normalization happens at input time (lowercase conversion)
- Tag validation against allowed list (if configured) with clear error messages
- Performance impact minimal (tag filtering is simple array intersection)

**Pragmatic Effort Estimate:**
- Schema changes: 45 minutes (plan schema + config schema)
- Tag validation utility: 30 minutes
- CLI commands (set, add, list, ready): 2.5 hours
- MCP tools (create-plan, list-ready-plans): 1.5 hours
- Display/formatting: 1 hour
- Testing (unit + integration): 2.5 hours
- **Total: ~8-9 hours**

## Acceptance Criteria

- [ ] Functional: Users can add tags via `rmplan set --tag frontend --tag bug <plan>`
- [ ] Functional: Users can remove tags via `rmplan set --no-tag frontend <plan>`
- [ ] Functional: Users can set initial tags via `rmplan add --tag <tag> ...`
- [ ] Functional: Users can filter plans by tags via `rmplan list --tag frontend --tag urgent` (OR logic)
- [ ] Functional: Users can filter ready plans by tags via `rmplan ready --tag backend`
- [ ] Functional: MCP `create-plan` tool accepts `tags` parameter
- [ ] Functional: MCP `list-ready-plans` tool accepts `tags` filter parameter
- [ ] Functional: Config can specify allowed tags via `tags.allowed` array
- [ ] Functional: When allowed tags configured, only those tags can be added to plans
- [ ] Functional: When no allowed tags configured, any tag can be added
- [ ] UX: All tags are normalized to lowercase on input
- [ ] UX: Tags are displayed in `rmplan show`, `rmplan list`, and `rmplan ready` outputs
- [ ] UX: Empty tag strings are silently filtered out
- [ ] UX: Attempting to add invalid tags shows helpful error with list of allowed tags
- [ ] Technical: `tags` field added to PlanSchema with `z.array(z.string())`
- [ ] Technical: `tags.allowed` field added to config schema
- [ ] Technical: `tags` field added to JSON Schema
- [ ] Technical: Tag filtering uses OR logic (plan matches if it has ANY specified tag)
- [ ] Technical: Tag validation runs at all entry points (CLI add/set, MCP create-plan)
- [ ] All new code paths are covered by tests

## Dependencies & Constraints

**Dependencies:**
- Existing plan schema infrastructure
- Existing array field patterns (issue, docs, rmfilter)
- Config loading and validation system
- planPropertiesUpdater utility for metadata updates

**Technical Constraints:**
- Must maintain backward compatibility with existing plan files
- Tags must be optional field with default empty array
- Tag normalization must be consistent across CLI and MCP interfaces
- Filtering must not significantly impact performance
- Validation must work with both main and local config files
- Plans with unrecognized tags (from before allowlist was configured) should not break

## Implementation Notes

**Recommended Approach:**

1. **Schema layer** - Add tags field to plan schemas and config schema
2. **Validation layer** - Create tag validation utility that checks against config
3. **CLI layer** - Implement in order: set command → add command → filtering commands
4. **MCP layer** - Update create-plan and list-ready-plans tools
5. **Display layer** - Add tags to show/list/ready outputs
6. **Testing layer** - Test each layer with focus on cross-interface consistency

**Potential Gotchas:**
- Tag normalization must happen at every entry point (CLI flags, MCP parameters, direct file edits)
- Tag validation must happen AFTER normalization but BEFORE updating plan
- Need to handle both the presence and absence of tags field in existing files
- Display formatting must handle overflow gracefully (many tags or long tag names)
- Filtering logic needs to work with empty tag arrays and missing tags field
- Config may not have allowed tags list (validation is optional)
- Reading plans with invalid tags should not fail (only adding new invalid tags fails)

**Tag Validation Strategy:**
```typescript
// Pseudocode
function validateTags(tags: string[], config: RmplanConfig): string[] {
  const normalized = normalizeTags(tags);
  if (config.tags?.allowed && config.tags.allowed.length > 0) {
    const invalid = normalized.filter(tag => !config.tags.allowed.includes(tag));
    if (invalid.length > 0) {
      throw new Error(`Invalid tags: ${invalid.join(', ')}. Allowed: ${config.tags.allowed.join(', ')}`);
    }
  }
  return normalized;
}
```

**Tag Normalization Points:**
- CLI: In command option parsing before validation
- MCP: In mcpCreatePlan before validation
- Validation: Normalize before checking against allowed list

**Config Schema Addition:**
```typescript
tags: z.object({
  allowed: z.array(z.string()).optional().describe('List of allowed tags. If set, only these tags can be added to plans.')
}).optional()
```

**Display Considerations:**
- List view: Show tags inline, possibly truncated with "..."
- Ready view: Include in all three formats (list, table, JSON)
- Show view: Display full tag list without truncation
<!-- rmplan-generated-end -->

## Research

### Summary

This task involves adding a `tags` field to rmplan plans to enable better organization and filtering. Tags should work like existing array fields (issue, docs, dependencies) with commands to add/remove tags and filter plans by tag. The implementation requires changes across multiple layers: schema definition, CLI commands, MCP tools, and display/filtering logic.

**Critical discoveries:**
- Tags field does not currently exist anywhere in the codebase
- Implementation follows well-established patterns for array metadata fields
- Need to support both CLI and MCP interfaces
- Filtering by tags requires changes to list/ready commands and MCP tools
- Display integration should show tags inline with other metadata

### Findings

#### Plan Metadata Architecture

**Schema Definition** (`src/rmplan/planSchema.ts`):
The plan schema uses Zod validation with ~30 metadata fields organized into categories:
- Identification: `id`, `uuid`
- Content: `title`, `goal`, `details`
- Status: `status`, `statusDescription`, `priority`
- Relationships: `parent`, `dependencies`, `discoveredFrom`, `references`
- Flags: `container`, `temp`, `simple`
- Resources: `issue`, `pullRequest`, `docs`, `rmfilter`, `changedFiles`
- Assignment: `assignedTo`, `baseBranch`
- Timestamps: `createdAt`, `updatedAt`, `compactedAt`
- Nested: `progressNotes`, `project`, `tasks`

**Existing array fields pattern:**
```typescript
// From planSchema.ts
issue: z.array(z.url()).default([]).optional()
docs: z.array(z.string()).default([]).optional()
dependencies: z.array(z.coerce.number().int().positive()).default([]).optional()
```

Tags would follow: `tags: z.array(z.string()).default([]).optional()`

**JSON Schema** (`schema/rmplan-plan-schema.json`):
Dual validation using JSON Schema Draft 7 with yaml-language-server directive in plan files. Tags need to be added here as well.

**File Format** (`src/rmplan/plans.ts` lines 539-574):
Plans use YAML frontmatter + optional markdown details:
```yaml
---
# yaml-language-server: $schema=...
[metadata fields here]
---
[optional markdown details]
```

#### CLI Command Patterns for Array Fields

**Set Command** (`src/rmplan/commands/set.ts`):

The `SetOptions` interface shows the standard pattern for array field manipulation:
```typescript
export interface SetOptions {
  planFile: string;
  
  // Array field additions
  issue?: string[];
  doc?: string[];
  rmfilter?: string[];
  
  // Array field removals (with "no" prefix)
  noIssue?: string[];
  noDoc?: string[];
  // noRmfilter doesn't exist but follows the pattern
}
```

**Implementation patterns from `planPropertiesUpdater.ts`:**

1. **Adding with duplicate checking:**
```typescript
if (options.issue && options.issue.length > 0) {
  if (!plan.issue) {
    plan.issue = [];
  }
  for (const issueUrl of options.issue) {
    if (!plan.issue.includes(issueUrl)) {
      plan.issue.push(issueUrl);
      modified = true;
    }
  }
  log(`Updated issue URLs`);
}
```

2. **Removing with change tracking:**
```typescript
if (options.noIssue && options.noIssue.length > 0) {
  if (plan.issue) {
    const originalLength = plan.issue.length;
    plan.issue = plan.issue.filter((url) => !options.noIssue!.includes(url));
    if (plan.issue.length < originalLength) {
      modified = true;
      log(`Removed ${originalLength - plan.issue.length} issue URLs`);
    }
  }
}
```

3. **Set deduplication with sorting (rmfilter pattern):**
```typescript
plan.rmfilter = Array.from(new Set([...(plan.rmfilter || []), ...options.rmfilter])).sort();
```

**Add Command** (`src/rmplan/commands/add.ts`):
Initial plan creation at lines 169-218 shows how metadata is initialized. Tags would be initialized as empty array or with provided values.

#### MCP Server Integration

**Location:** `src/rmplan/mcp/generate_mode.ts`

**Current MCP tools (7 total):**
1. `create-plan` (lines 1058-1070) - Creates new plans with metadata
2. `update-plan-tasks` (lines 951-970) - Updates plan tasks and some metadata
3. `manage-plan-task` (lines 972-991) - Add/update/remove individual tasks
4. `get-plan` (lines 1004-1014) - Retrieve full plan details
5. `list-ready-plans` (lines 1035-1056) - List plans with filtering
6. `append-plan-research` (lines 993-1002) - Add research notes
7. `update-plan-details` (lines 1004-1033) - Update plan details section

**create-plan parameters** (`createPlanParameters` lines 413-428):
Currently supports: `title`, `goal`, `details`, `priority`, `parent`, `dependsOn`, `discoveredFrom`, `assignedTo`, `issue`, `docs`, `container`, `temp`

Tags would need to be added to this parameter schema:
```typescript
tags: z.array(z.string()).optional()
```

**mcpCreatePlan implementation** (lines 772-852):
Maps parameters to PlanSchema properties at lines 786-804. Would need to include tags mapping.

**list-ready-plans parameters** (`listReadyPlansParameters` lines 387-409):
Current filters: `priority`, `limit`, `pendingOnly`, `sortBy`

Would need new parameter: `tags?: string[]` to filter by tags

#### Filtering and Display Architecture

**List Command** (`src/rmplan/commands/list.ts` lines 28-520):

**Current filtering options:**
- Status: `--status [pending|in_progress|done|cancelled|deferred|ready|blocked]`
- Assignment: `--assigned`, `--unassigned`, `--user <name>`, `--mine`
- Search: Free text search in title/goal
- Sorting: `--sort [id|title|status|priority|created|updated]`

**Display columns:**
ID, Title, Status, Workspace, Priority, Tasks, Steps, Dependencies, Notes (conditional), File (optional)

Tags would fit naturally as an additional column or inline display element.

**Ready Command** (`src/rmplan/commands/ready.ts` lines 374-576):

**Current filtering options:**
- Priority: `--priority [low|medium|high|urgent|maybe]`
- Status: `--pending-only` flag
- Assignment: `--all`, `--unassigned`, `--user <name>`
- Tasks: `--hasTasks`
- Sorting: `--sort-by [priority|id|title|created|updated]`

**Display formats:**
1. List format (detailed)
2. Table format (compact)
3. JSON format (machine-readable)

Tags filtering would need new CLI flag: `--tag <tag>` (repeatable)

**Ready Plans Logic** (`src/rmplan/ready_plans.ts`):

Core filtering function `isReadyPlan` (lines 42-61) checks:
- Status matches filter (pending or in_progress)
- All dependencies are done

Would need to add tag filtering to `filterReadyPlans` or higher-level filtering in ready.ts

**Display Utilities** (`src/rmplan/display_utils.ts`):
Provides formatting helpers for workspace paths, combined titles/goals. Could add tag formatting helper here.

#### Related Code Areas

**Plan I/O** (`src/rmplan/plans.ts`):
- `readAllPlans` (lines 55-161) - Scans and parses all plan files
- `writePlan` (lines 539-612) - Writes YAML frontmatter + details
- Caching mechanism to avoid re-scanning

**Validation** (`src/rmplan/commands/validate.ts`):
Validates plan files against schema. Tags would be automatically validated by Zod schema.

**Show Command** (`src/rmplan/commands/show.ts`):
Displays full plan details. Would need to include tags in the output.

**Plan Display** (`src/rmplan/plan_display.ts`):
Utility functions for assembling plan context summaries. Should include tags in context.

#### Test Files to Update

Key test files that would need updates:
- `src/rmplan/commands/set.test.ts` - Test tag setting/removal
- `src/rmplan/commands/list.test.ts` - Test tag filtering in list
- `src/rmplan/commands/ready.test.ts` - Test tag filtering in ready
- `src/rmplan/mcp/generate_mode.test.ts` - Test MCP tool tag support
- `src/rmplan/plans.test.ts` - Test plan I/O with tags
- `src/rmplan/planSchema.test.ts` - Test schema validation with tags

#### Implementation Strategy from Recent Similar Change

**Reference: Simple field implementation (Task #143)**
Recent PR added `simple` boolean field with these changes:
1. Added to planSchema.ts Zod schema
2. Added to JSON schema
3. Added CLI flag `--simple` in add command
4. Added CLI flags `--simple`/`--no-simple` in set command
5. Updated planPropertiesUpdater.ts for set operation
6. Tests updated for new field

Tags would follow similar pattern but with array handling instead of boolean.

### Risks & Constraints

**Architectural constraints:**
- Must maintain consistency between TypeScript schema, JSON schema, and MCP parameter schemas
- CLI and MCP interfaces must support same operations (create with tags, filter by tags, display tags)
- Changes must not break existing plan files (backward compatibility)
- Need to maintain fast filtering performance with potentially many tags

**Edge cases to handle:**
- Tag normalization (case sensitivity, whitespace, special characters)
- Maximum tag length validation
- Empty tag strings
- Duplicate tag handling
- Tag display overflow in terminal columns
- Performance with plans having many tags

**Testing challenges:**
- Need to test both CLI and MCP interfaces
- Cross-interface behavior must stay aligned (see `task-management.integration.test.ts`)
- Need to test filtering combinations (tags + priority + status, etc.)
- Display formatting edge cases (many tags, long tag names)

**Dependencies:**
- No external dependencies needed
- Changes isolated to rmplan module
- No database migration needed (file-based storage)

**Backward compatibility:**
- Existing plans without tags field will work fine (optional field with default empty array)
- New tag field will be ignored by older versions of rmplan
- JSON schema versioning not needed

### Follow-up Questions

1. **Tag normalization:** Should tags be case-sensitive? Should we normalize to lowercase or preserve case? Should we allow spaces in tags or convert to hyphens?

2. **Tag syntax:** Any restrictions on tag characters? Should we support tag hierarchies (e.g., "category:value") or keep them simple strings?

3. **Filtering behavior:** When filtering by multiple tags, should it be AND (plan must have all tags) or OR (plan must have any tag)? Or support both?

4. **Display priority:** In list/ready views with limited terminal width, how should tags be displayed? Abbreviated? Truncated? On separate line?

5. **Tag suggestions:** Should we provide tag autocomplete/suggestions based on existing tags across all plans? This would require scanning all plans and could affect performance.

6. **MCP filtering:** Should the `list-ready-plans` MCP tool support tag filtering, or should tag filtering only be available via CLI?

Completed Tasks: 1 (Add tags field to plan schemas), 2 (Add tag normalization utility function), 3 (Update planPropertiesUpdater for tag operations), 4 (Add tag options to set command), 5 (Add tag option to add command), 14 (Write tests for tag schema validation), 15 (Write tests for set command tag operations), 16 (Write tests for add command tag option).

Extended PlanSchema/Zod definitions plus the JSON schema to include a normalized \"tags\" array and introduced the corresponding tags.allowed subsection in rmplan.yml via configSchema/configLoader. Added src/rmplan/utils/tags.ts which centralizes normalizeTags/validateTags so every entry point lowercases, trims, deduplicates, and sorts tags while enforcing an optional allowlist.

Updated updatePlanProperties to understand tag/noTag, merging normalized tags through Sets, logging changes, and reusing the shared validator. Set and add commands (plus cleanup/mcp plan creation) now call this updated helper with the loaded config, and the CLI exposes new --tag/--no-tag flags. All plan creation paths seed tags: [] to keep metadata consistent, and README now documents tagging and the allowlist knob.

Regression coverage: new planSchema tests assert tag parsing, set.test.ts verifies add/remove/allowlist behaviors, and add.test.ts checks initial tagging + validation. Ran bun test for the touched suites and bun run check for types; both passed. Future work can build on this foundation to implement tag filtering in list/ready and MCP surfaces without revisiting schema plumbing.

Addressed review feedback for tasks 'Add tags field to plan schemas' and 'Add tag normalization utility function'. Regenerated schema/rmplan-config-schema.json via 'bun scripts/update-json-schemas.ts' so the JSON schema now declares the tags.allowed block that matches RmplanConfig, enabling editor validation for tag allowlists. Updated validateTags in src/rmplan/utils/tags.ts to treat any configured tags.allowed array as authoritative (including an empty array) by normalizing the allowlist, checking every proposed tag against it, and emitting a clear 'No tags are currently allowed by configuration.' error when violated. Added a regression in src/rmplan/utils/tags.test.ts that asserts tags.allowed: [] blocks additions to prevent future regressions. Validated the helpers with 'bun test src/rmplan/utils/tags.test.ts'.
