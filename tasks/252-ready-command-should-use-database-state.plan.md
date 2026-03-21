---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: ready command should use database state
goal: ""
id: 252
uuid: 33f4731f-f5f6-4b0a-91a9-4c1bbb7b78fe
generatedBy: agent
status: pending
priority: medium
planGeneratedAt: 2026-03-21T08:28:47.931Z
promptsGeneratedAt: 2026-03-21T08:28:47.931Z
createdAt: 2026-03-21T08:06:15.269Z
updatedAt: 2026-03-21T08:28:47.932Z
tasks:
  - title: Extract loadPlansFromDb to shared module and fix parent field
    done: false
    description: Move loadPlansFromDb from src/tim/commands/list.ts to
      src/tim/plans_db.ts. Export the function and PlansLoadResult type. Update
      list.ts to import from the new module. Fix the parent field by resolving
      row.parent_uuid to numeric plan ID using the planUuidToId map.
  - title: Add --local flag to tim ready CLI registration
    done: false
    description: In src/tim/tim.ts add --local option to the ready command registration.
  - title: Update handleReadyCommand to use DB by default
    done: false
    description: In src/tim/commands/ready.ts replace readAllPlans with
      DB-with-fallback pattern. Add local to options interface. Move
      getRepositoryIdentity before plan loading.
  - title: Update MCP list_ready_plans tool to use DB by default
    done: false
    description: In src/tim/tools/list_ready_plans.ts use loadPlansFromDb with
      fallback to readAllPlans.
  - title: Update existing tests and add DB-path tests
    done: false
    description: Add local:true to existing tests. Add new tests that sync plans to
      DB first then test default DB path, fallback, and epic filtering with
      parent field.
  - title: Run formatting type checking and tests
    done: false
    description: Run bun run format, bun run check, and relevant test files. Fix any
      failures.
tags: []
---

In the same way that `tim list` uses database state by default, `tim ready` should do the same
unless a `--local` flag is provided.

## Research

### Problem Overview

`tim list` defaults to loading plans from SQLite (via `loadPlansFromDb()`) and only falls back to local files when
`--local` is passed or the DB returns no plans. In contrast, `tim ready` always reads from local YAML files via
`readAllPlans(tasksDir)` and only touches the DB for assignment data. This inconsistency means `tim ready` may show
stale data when plans have been synced to the DB but local files have diverged, and it cannot benefit from the
performance advantages of DB queries.

### Key Findings

**Product & User Story**
- As a user, I want `tim ready` to use the same data source as `tim list` by default (SQLite), so the commands
  are consistent and I get accurate results based on synced plan state.
- When I pass `--local`, it should fall back to reading YAML files from disk, matching `tim list`'s behavior.

**Design & UX Approach**
- No visible UX change aside from adding the `--local` CLI flag. Output format remains identical.
- The fallback behavior (DB returns empty → read local files) matches `tim list`'s pattern for backwards compatibility.

**Technical Plan & Risks**
- Low risk: the pattern is well-established in `list.ts` and can be directly replicated.
- The `loadPlansFromDb()` function in `list.ts` (lines 98-190) is a private function inside `list.ts`. It needs to
  be extracted to a shared location so `ready.ts` can reuse it, OR duplicated/adapted within `ready.ts`.
- The `isReadyPlan()` function in `ready_plans.ts` operates on `Map<number, PlanSchema>`, which is exactly what
  `loadPlansFromDb()` returns. No changes needed to the readiness logic itself.
- The MCP tool `list_ready_plans.ts` also always reads from local files. It should be updated for consistency.

**Pragmatic Effort Estimate**
- Small scope: ~2-3 files modified, mostly mechanical refactoring following an established pattern.

### File Analysis

#### `src/tim/commands/ready.ts` — Main command handler
- `handleReadyCommand()` (line 368): Entry point. Currently calls `readAllPlans(tasksDir)` at line 408.
- Lines 414-439: Enriches plans with assignment data from DB (workspaces, users, status overrides).
- Lines 441-506: Filters for readiness, priority, user, workspace, tags, epic.
- `loadAssignmentsLookup()` (line 564): Already uses DB for assignments — only plan loading is file-based.

#### `src/tim/commands/list.ts` — Reference implementation
- `loadPlansFromDb()` (lines 98-190): Loads plans from SQLite, assembling `PlanWithFilename` objects from
  `PlanRow` + tags + tasks + dependencies. Returns `{ plans: Map<number, PlanWithFilename>, duplicates }`.
- `handleListCommand()` (lines 209-220): The `--local` branching pattern:
  ```
  if (useLocalFiles) {
    ({ plans, duplicates } = await readAllPlans(searchDir));
  } else {
    ({ plans, duplicates } = loadPlansFromDb(searchDir, repository.repositoryId));
    if (plans.size === 0) {
      ({ plans, duplicates } = await readAllPlans(searchDir));
    }
  }
  ```

#### `src/tim/ready_plans.ts` — Readiness logic
- `isReadyPlan()` (line 65): Works on `Map<number, PlanSchema>` — fully compatible with both file-loaded and
  DB-loaded plans.
- `filterAndSortReadyPlans()` (line 165): Same — works on any `Map<number, T extends PlanSchema>`.

#### `src/tim/tools/list_ready_plans.ts` — MCP tool
- `listReadyPlansTool()` (line 30): Always reads from files via `readAllPlans()`. Should also be updated
  to use DB by default for consistency.

#### `src/tim/db/plan.ts` — DB queries
- `getPlansByProject()` (line 300): Returns all `PlanRow[]` for a project.
- `getPlanTasksByProject()` (line 312): Returns all task rows for a project.
- `getPlanDependenciesByProject()` (line 326): Returns all dependency rows.
- `getPlanTagsByProject()` (line 346): Returns all tag rows.

#### `src/tim/tim.ts` — CLI registration
- `ready` command registered at lines 779-810. No `--local` option currently.

### Existing Patterns to Follow

1. **DB-with-fallback pattern** from `list.ts:209-220` — try DB first, fall back to files if empty.
2. **`loadPlansFromDb()` from `list.ts:98-190`** — assembles `PlanWithFilename` from DB rows. This function
   should be extracted to a shared module rather than duplicated.
3. **`ListPlansLoadResult` type** — `{ plans: Map<number, PlanWithFilename>, duplicates: Record<number, string[]> }`.
   The ready command doesn't use `duplicates` but can simply ignore it.

### Dependencies & Constraints
- **Dependencies**: Relies on `loadPlansFromDb()` being extractable from `list.ts` (or being duplicated).
- **Technical Constraints**: The `PlanWithFilename` type includes `filename` which is used by display functions.
  DB-loaded plans compute this from `path.join(searchDir, row.filename)`, which is fine.

## Expected Behavior/Outcome

- `tim ready` defaults to loading plans from SQLite, matching `tim list` behavior.
- When `--local` is passed, plans are loaded from YAML files on disk (current behavior).
- If DB returns no plans, automatically falls back to reading local files (same as `tim list`).
- All existing filtering (priority, user, workspace, tags, epic, pending-only) works identically with DB-loaded plans.
- The MCP `list-ready-plans` tool also uses DB state by default.
- Output format is unchanged regardless of data source.

## Acceptance Criteria

- [ ] `tim ready` loads plans from SQLite by default.
- [ ] `tim ready --local` loads plans from local YAML files.
- [ ] Fallback to local files when DB returns empty set.
- [ ] All existing filters (priority, user, workspace, tags, epic, pending-only, has-tasks) work correctly with DB-loaded plans.
- [ ] MCP `list-ready-plans` tool uses DB state by default.
- [ ] Existing tests updated and new tests added for DB-based loading path.
- [ ] All new code paths are covered by tests.

## Implementation Guide

### Step 1: Extract `loadPlansFromDb()` to a shared module

The `loadPlansFromDb()` function in `src/tim/commands/list.ts` (lines 98-190) is currently private to `list.ts`.
Extract it to a shared module that both `list.ts` and `ready.ts` can import.

**Recommended location**: `src/tim/plans_db.ts` (sibling to `plans.ts` which handles file-based loading).

1. Create `src/tim/plans_db.ts` with the `loadPlansFromDb()` function and the `ListPlansLoadResult` type
   (or rename to something more generic like `PlansLoadResult`).
2. Update `src/tim/commands/list.ts` to import from the new module instead of defining it locally.
3. The function signature stays: `loadPlansFromDb(searchDir: string, repositoryId: string): PlansLoadResult`.
4. Fix the `parent` field: `loadPlansFromDb()` already builds a `planUuidToId` map. Use it to resolve
   `row.parent_uuid` → numeric plan ID and set the `parent` field on each assembled `PlanWithFilename`.
   This fixes `--epic` filtering for both `tim list` and `tim ready` when using DB mode.

Also extract the `PlanWithFilename` type if it isn't already shared — check if it's defined in `list.ts` or
in a shared types file.

### Step 2: Add `--local` flag to `tim ready` CLI registration

In `src/tim/tim.ts`, add the `--local` option to the `ready` command registration (around line 806):

```
.option('--local', 'Read plan data from local files instead of SQLite')
```

This matches the existing `--local` option on `tim list` (line 748).

### Step 3: Update `handleReadyCommand()` to use DB by default

In `src/tim/commands/ready.ts`, modify `handleReadyCommand()` starting at line 405:

1. Add `local` to the options type/interface.
2. Replace the current `readAllPlans(tasksDir)` call with the DB-with-fallback pattern:
   ```
   const useLocalFiles = options.local === true;
   let rawPlans: Map<number, PlanWithFilename>;
   if (useLocalFiles) {
     ({ plans: rawPlans } = await readAllPlans(tasksDir));
   } else {
     ({ plans: rawPlans } = loadPlansFromDb(tasksDir, repository.repositoryId));
     if (rawPlans.size === 0) {
       ({ plans: rawPlans } = await readAllPlans(tasksDir));
     }
   }
   ```
3. Note: `getRepositoryIdentity()` is already called at line 410, so `repository.repositoryId` is available.
   However, you may need to reorder slightly — currently `readAllPlans` is called before `getRepositoryIdentity()`.
   Move the `getRepositoryIdentity()` call before the plan loading so `repositoryId` is available for the DB path.

### Step 4: Update MCP `list_ready_plans.ts` tool

In `src/tim/tools/list_ready_plans.ts`, update `listReadyPlansTool()` to use DB by default:

1. Import `loadPlansFromDb` from the new shared module.
2. Need access to `repositoryId` — check how other MCP tools get this from the `ToolContext`. The context
   likely has `config` and `gitRoot`. Use `getRepositoryIdentity()` with the git root.
3. Apply the same DB-with-fallback pattern. Note: the MCP tool uses `clearPlanCache()` before reading —
   this is only needed for the file-based path now.

### Step 5: Update existing tests

In `src/tim/commands/ready.test.ts`:

1. The existing tests create plans as YAML files on disk. These tests effectively test the `--local` path.
   Add `local: true` to the options in existing tests so they continue to pass unchanged, OR:
2. Better approach: Add DB sync in the test setup so that DB-based tests work naturally. The test already
   has access to `getDatabase()` and `getOrCreateProject()`. Sync the file-based plans to DB using
   `syncPlanToDb()` or `syncAllPlansToDb()`.
3. Add new test cases that specifically test:
   - Default behavior (DB path) loads from DB.
   - `--local` flag forces file-based loading.
   - Fallback when DB is empty.
   - Readiness filtering works correctly with DB-loaded plans.

### Step 6: Format and verify

1. Run `bun run format` to ensure code formatting.
2. Run `bun run check` for type checking.
3. Run `bun run test-cli src/tim/commands/ready.test.ts` to verify tests pass.
4. Run `bun run test-cli src/tim/ready_plans.test.ts` to verify core readiness logic still works.

### Manual Testing Steps

1. `tim ready` — should show ready plans from DB (verify by comparing with `tim ready --local`).
2. `tim ready --local` — should show ready plans from local files (same as current behavior).
3. `tim ready --priority high` — filtering works with DB source.
4. `tim ready --here` — workspace filtering works with DB source.
5. `tim ready --format json` — JSON output works with DB source.
6. In a repo with no DB sync, `tim ready` should fall back to local files seamlessly.

### Rationale

- **Extracting `loadPlansFromDb()`** rather than duplicating avoids code divergence between `list` and `ready`.
- **DB-with-fallback** ensures backwards compatibility for repos that haven't synced to SQLite yet.
- **Updating MCP tool** ensures consistency across all interfaces (CLI, MCP, web).
- **Not changing readiness logic** — `isReadyPlan()` and `filterAndSortReadyPlans()` are data-source-agnostic
  and work identically with DB-loaded plans.

### Potential Gotchas

- The `ready` command's enrichment loop (lines 414-439) adds assignment data. With DB-loaded plans, the
  `assignedTo` field may already be populated from the DB row. Make sure the assignment overlay logic still
  works correctly and doesn't double-apply.
- `PlanWithFilename` from `loadPlansFromDb()` already includes `filename`. The ready command's display functions
  need the filename for verbose mode — verify this works.
- **`parent` field missing in `loadPlansFromDb()`**: The current `loadPlansFromDb()` in `list.ts` does NOT
  populate the `parent` field (a plan ID number). The DB stores `parent_uuid` but doesn't resolve it back
  to a numeric plan ID. This means `--epic` filtering via `isUnderEpic()` is broken for DB-loaded plans in
  both `tim list` and `tim ready`. This will be fixed as part of this plan by resolving `parent_uuid` → plan ID
  using the `planUuidToId` map that `loadPlansFromDb()` already builds.
