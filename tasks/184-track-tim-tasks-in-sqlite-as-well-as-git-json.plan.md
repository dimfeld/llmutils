---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: track tim tasks in sqlite as well as git json files
goal: Have plan data from all active workspaces in a single place
id: 184
uuid: 05e31645-305d-4e59-8c49-a9fbc9ce0bd7
generatedBy: agent
status: done
priority: medium
dependencies:
  - 158
references:
  "158": e17331a4-1827-49ea-88e6-82de91f993df
planGeneratedAt: 2026-02-20T10:07:38.093Z
promptsGeneratedAt: 2026-02-20T10:07:38.093Z
createdAt: 2026-02-13T08:35:46.190Z
updatedAt: 2026-02-21T05:01:42.387Z
tasks:
  - title: Add database migration v2 with plan, plan_task, and plan_dependency tables
    done: true
    description: "Add a new migration (version 2) to src/tim/db/migrations.ts with
      three tables: plan (uuid UNIQUE, project_id FK, plan_id, title, goal,
      status with CHECK, priority with CHECK, parent_uuid, epic, filename,
      timestamps), plan_task (plan_uuid FK with CASCADE, task_index, title,
      description, done, UNIQUE on plan_uuid+task_index), and plan_dependency
      (plan_uuid FK with CASCADE, depends_on_uuid, composite PK). No unique
      constraint on (project_id, plan_id) to tolerate temporary duplicates. No
      FK on parent_uuid or depends_on_uuid since referenced plans may not be
      synced yet. Add indexes: idx_plan_project_id, idx_plan_project_plan_id,
      idx_plan_parent_uuid, idx_plan_task_plan_uuid."
  - title: Create plan CRUD module (src/tim/db/plan.ts)
    done: true
    description: "Create src/tim/db/plan.ts following patterns from assignment.ts
      and workspace.ts. Define interfaces: PlanRow, PlanTaskRow,
      UpsertPlanInput. Implement synchronous functions: upsertPlan (INSERT ON
      CONFLICT(uuid) DO UPDATE, plus tasks and deps in same transaction),
      upsertPlanTasks (delete-then-insert), upsertPlanDependencies
      (delete-then-insert), getPlanByUuid, getPlansByProject, getPlanTasksByUuid
      (ordered by task_index), deletePlan (cascades via FK), getPlansNotInSet
      (for prune). All writes use db.transaction().immediate()."
  - title: Create plan sync module (src/tim/db/plan_sync.ts)
    done: true
    description: "Create src/tim/db/plan_sync.ts bridging plan files and DB CRUD.
      Implement lazy-cached sync context: on first syncPlanToDb call, resolve
      project via getRepositoryIdentity() + getOrCreateProject() and tasks dir
      via resolveTasksDir(config), cache at module level. Core function
      syncPlanToDb(plan, filePath) checks for uuid, resolves context lazily,
      resolves parent_uuid and dependency UUIDs from plan.references map first
      then readAllPlans idToUuid fallback, calls upsertPlan, wraps in try/catch.
      Accept optional idToUuid param for bulk sync. Implement
      removePlanFromDb(planUuid) for deletion. Implement
      syncAllPlansToDb(projectId, tasksDir, {prune}) for bulk sync with prune
      support (delete orphaned plans and their assignments). Export
      clearPlanSyncContext() for testing."
  - title: Hook writePlanFile to sync plans to SQLite
    done: true
    description: Modify writePlanFile in src/tim/plans.ts to call syncPlanToDb after
      the Bun.write call. Use result.data (validated plan) and absolutePath.
      Wrap in try/catch so DB failures never block file writes. Import
      syncPlanToDb from the plan_sync module.
  - title: Hook plan deletion commands (tim remove and tim cleanup-temp)
    done: true
    description: In src/tim/commands/remove.ts, after the removePlanAssignment call
      in the deletion loop, add removePlanFromDb(target.plan.uuid) with
      try/catch. In src/tim/commands/cleanup-temp.ts, add
      removePlanFromDb(plan.uuid) in the deletion loop alongside fs.unlink. Both
      use graceful error handling (warn on failure, never block).
  - title: Create tim sync command
    done: true
    description: Create src/tim/commands/sync.ts with handleSyncCommand(options,
      command). Load config, resolve tasks dir, resolve repository identity and
      project via getOrCreateProject. Call syncAllPlansToDb with prune option.
      Print summary (synced/pruned/errors). Register in tim.ts as tim sync with
      --prune and --dir options.
  - title: Write unit tests for plan CRUD module
    done: true
    description: "Create src/tim/db/plan.test.ts following patterns from
      assignment.test.ts and workspace.test.ts. Test: upsertPlan insert and
      update, upsertPlanTasks with replacement, upsertPlanDependencies,
      getPlanByUuid, getPlansByProject, getPlanTasksByUuid ordering, deletePlan
      cascade to tasks and dependencies, getPlansNotInSet for prune detection.
      Use in-memory DB with openDatabase for test isolation."
  - title: Write integration tests for plan sync and sync command
    done: true
    description: "Create src/tim/db/plan_sync.test.ts: test syncPlanToDb with valid
      plan and project context, graceful handling of missing UUID, graceful
      handling of missing DB, syncAllPlansToDb with multiple plan files, prune
      functionality. Create src/tim/commands/sync.test.ts: test sync command
      with test directory of plan files, test --prune flag. Use temp directories
      with fixture plan files."
  - title: "Address Review Feedback: Plan sync resolves repository identity from
      plan/tasks directories instead of the actual repository root, which
      mis-associates rows to the wrong project when `paths.tasks` is outside the
      git repo."
    done: true
    description: >-
      Plan sync resolves repository identity from plan/tasks directories instead
      of the actual repository root, which mis-associates rows to the wrong
      project when `paths.tasks` is outside the git repo.
      `resolvePlanSyncContext` uses `getRepositoryIdentity({ cwd:
      options.baseDir })` and `writePlanFile` always passes `baseDir` as the
      plan file directory. `tim sync` similarly uses `getRepositoryIdentity({
      cwd: tasksDir })`. In external/absolute tasks setups, this produces
      fallback repository IDs (e.g. directory basename) with null remotes,
      causing cross-project collisions and incorrect centralization.


      Suggestion: Resolve repository identity from the repository root/caller
      git context, not from tasks/plan directories. Thread repository identity
      (or git root) into sync APIs and use that consistently in both
      `writePlanFile` hook and `tim sync` command.


      Related file: src/tim/db/plan_sync.ts:94
  - title: "Address Review Feedback: `tim sync --prune` can delete plans that still
      exist on disk when files are unreadable/invalid."
    done: true
    description: >-
      `tim sync --prune` can delete plans that still exist on disk when files
      are unreadable/invalid. `syncAllPlansToDb` builds the keep-set from parsed
      UUIDs and prunes everything else. Parse failures in `readAllPlans` are
      swallowed and missing UUIDs are treated as absent, so existing files are
      pruned from SQLite anyway. This violates the prune requirement (remove
      only plans no longer on disk) and can also delete related assignments.


      Suggestion: Track read/parse failures and disable prune when any occur, or
      base prune eligibility on discovered file paths plus reliable UUID
      extraction that distinguishes parse failure from true deletion.


      Related file: src/tim/db/plan_sync.ts:314
  - title: "Address Review Feedback: New tests do not cover the two high-risk
      failure modes above."
    done: true
    description: >-
      New tests do not cover the two high-risk failure modes above. Current
      coverage assumes tasks directories inside git repos and parseable plan
      files, so wrong-project sync and unsafe prune behavior were missed.


      Suggestion: Add integration tests for external/absolute tasks directories
      (repository identity correctness) and `--prune` behavior when a plan file
      exists but cannot be parsed.


      Related file: src/tim/db/plan_sync.test.ts:1
  - title: "Address Review Feedback: Parent/dependency fallback resolution can read
      the wrong tasks directory because `syncPlanToDb` defaults to
      `loadEffectiveConfig()` without caller override, while `writePlanFile`
      does not pass config."
    done: true
    description: >-
      Parent/dependency fallback resolution can read the wrong tasks directory
      because `syncPlanToDb` defaults to `loadEffectiveConfig()` without caller
      override, while `writePlanFile` does not pass config. In non-default
      config flows (`--config`, alternate tasks roots), fallback UUID lookup can
      silently store null/incorrect parent/dependency links.


      Suggestion: Pass the effective config/tasksDir from call sites into
      `syncPlanToDb`, or resolve fallback lookup from explicit plan path context
      instead of global default config discovery.


      Related file: src/tim/db/plan_sync.ts:92
  - title: "Address Review Feedback: The prune loop in `syncAllPlansToDb` calls
      `removeAssignment` and `deletePlan` as separate statements without a
      transaction wrapper."
    done: true
    description: >-
      The prune loop in `syncAllPlansToDb` calls `removeAssignment` and
      `deletePlan` as separate statements without a transaction wrapper. The
      equivalent `removePlanFromDb` function correctly wraps both in
      `db.transaction().immediate()`. If `removeAssignment` succeeds but
      `deletePlan` throws, the assignment is deleted but the plan remains,
      leaving inconsistent data. No FK between these tables means no constraint
      violation, but it's a data consistency gap.


      Suggestion: Wrap the `removeAssignment` + `deletePlan` calls in a
      `db.transaction().immediate()` block, matching the pattern used in
      `removePlanFromDb` at line 234.


      Related file: src/tim/db/plan_sync.ts:317-329
  - title: "Address Review Feedback: The `syncPlanToDb` call in `writePlanFile` is
      wrapped in a try/catch that logs a warning."
    done: true
    description: >-
      The `syncPlanToDb` call in `writePlanFile` is wrapped in a try/catch that
      logs a warning. But `syncPlanToDb` itself already has an internal
      try/catch that swallows all errors with `warn()` and never rethrows. The
      outer catch in `writePlanFile` is dead code and creates confusion about
      which layer owns error handling.


      Suggestion: remove the outer try/catch (trusting `syncPlanToDb`'s internal
      handling) 


      Related file: src/tim/plans.ts:736-746
  - title: "Address Review Feedback: The `plan` table uses `uuid TEXT NOT NULL
      UNIQUE` without declaring an explicit PRIMARY KEY."
    done: true
    description: >-
      The `plan` table uses `uuid TEXT NOT NULL UNIQUE` without declaring an
      explicit PRIMARY KEY. SQLite creates an implicit rowid as primary key.
      This works correctly since UNIQUE constraints are valid FK targets, but
      using `uuid TEXT PRIMARY KEY` would be semantically clearer and avoid the
      unused implicit rowid.


      Suggestion: Use `uuid TEXT NOT NULL PRIMARY KEY` instead of `uuid TEXT NOT
      NULL UNIQUE`


      Related file: src/tim/db/migrations.ts:84
  - title: "Address Review Feedback: Fallback parent/dependency UUID resolution is
      wrong for plans in subdirectories."
    done: true
    description: >-
      Fallback parent/dependency UUID resolution is wrong for plans in
      subdirectories. `writePlanFile` passes `baseDir = path.dirname(file)` into
      `syncPlanToDb`, and `syncPlanToDb` uses `options.baseDir` as
      `tasksDirOverride` when loading `readAllPlans`. That scopes fallback
      lookup to the file's immediate directory, not the configured tasks root.
      Cross-folder references then resolve to `null`/missing in SQLite.


      Concrete failure: a child plan in `tasks/a/` with `parent: 1` and no
      `references` will not resolve a parent plan in `tasks/b/`, so
      `parent_uuid` and dependency rows are dropped.


      This violates the requirement to resolve fallback UUIDs from the tasks
      directory map, not the current file folder.


      Suggestion: Use the actual tasks root for fallback lookup. Thread
      `tasksDir` from call sites that already know config/path context (or
      resolve once via path resolver) and avoid defaulting to
      `path.dirname(filePath)` for UUID fallback.


      Related file: src/tim/db/plan_sync.ts:213
  - title: "Address Review Feedback: `tim remove` now deletes assignment rows twice
      via different identity resolution paths."
    done: true
    description: >-
      `tim remove` now deletes assignment rows twice via different identity
      resolution paths. It calls `removePlanAssignment(..., baseDir=planDir)`
      first, then `removePlanFromDb(...)`, and `removePlanFromDb` also deletes
      assignment in its transaction but resolves project context from
      `process.cwd()`. With external task dirs or mismatched cwd, these can
      target different projects and remove assignments from the wrong project.


      Suggestion: Remove the direct `removePlanAssignment` call from
      `handleRemoveCommand` and rely on `removePlanFromDb` for assignment+plan
      deletion, or unify both paths to the same repository identity resolution
      strategy.


      Related file: src/tim/commands/remove.ts:139
  - title: "Address Review Feedback: Coverage misses the two failure modes above."
    done: true
    description: >-
      Coverage misses the two failure modes above. Existing tests cover external
      tasks dirs and prune parse safety, but there is no test for fallback UUID
      resolution across sibling subdirectories, and no test asserting non-prune
      sync reports parse failures. These gaps allowed correctness/observability
      regressions in core sync behavior.


      Suggestion: Add integration tests for: (1) child/parent plans in different
      subfolders with missing `references` (must resolve via tasks root), and
      (2) `syncAllPlansToDb(..., { prune: false })` with at least one invalid
      plan file (must increment `errors` and warn).


      Related file: src/tim/db/plan_sync.test.ts:409
  - title: "Address Review Feedback: `tim sync` can silently skip invalid plan files
      while reporting `0 errors` when `--prune` is not set."
    done: true
    description: >-
      `tim sync` can silently skip invalid plan files while reporting `0 errors`
      when `--prune` is not set. `syncAllPlansToDb` relies on
      `readAllPlans(tasksDir, false)` and then syncs only returned plans;
      parse/validation failures are not counted in `errors` and are not warned
      here. Result: partial sync is presented as successful.


      Suggestion: Track and surface read/parse failures during bulk sync
      regardless of `prune`. Update readAllPlans to return a list of errored
      files which is builds in its catch block.

      Related file: src/tim/db/plan_sync.ts:258
  - title: "Address Review Feedback: Inconsistent file/DB deletion order between
      remove.ts and cleanup-temp.ts."
    done: true
    description: >-
      Inconsistent file/DB deletion order between remove.ts and cleanup-temp.ts.
      remove.ts does DB-then-file (line 141 then 149), cleanup-temp.ts does
      file-then-DB (line 37 then 39). Both leave inconsistent state if the
      second operation fails, but the inconsistency between the two commands
      could confuse future maintainers.


      Suggestion: Standardize the order across both commands. File-then-DB is
      arguably safer since orphan DB rows are cleaned up by `tim sync --prune`,
      while orphan files re-appear on next sync.


      Related file: src/tim/commands/remove.ts:141-149
  - title: "Address Review Feedback: `getPlansNotInSet` builds a dynamic `NOT IN
      (...)` clause with one `?` placeholder per UUID."
    done: true
    description: >-
      `getPlansNotInSet` builds a dynamic `NOT IN (...)` clause with one `?`
      placeholder per UUID. SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is
      999. With 999+ plans, this query would fail. Unlikely for a plan
      management tool but worth noting.


      Suggestion: Document the limit, or if it could be hit, batch UUIDs or use
      a temporary table for the exclusion set.


      Related file: src/tim/db/plan.ts:204-222
  - title: "Address Review Feedback: Double assignment deletion in remove.ts."
    done: true
    description: >-
      Double assignment deletion in remove.ts. `removePlanAssignment` on line
      139 deletes the assignment row. Then `removePlanFromDb` on line 141
      internally calls `removeAssignment` again (plan_sync.ts:240). The second
      call is a no-op since the row was already deleted. Not a bug, but a wasted
      DB call per plan removal.


      Suggestion: Consider having removePlanFromDb skip the removeAssignment
      call when the caller has already done it, or accept the minor
      inefficiency.


      Related file: src/tim/commands/remove.ts:139-141
changedFiles:
  - CLAUDE.md
  - README.md
  - claude-plugin/skills/using-tim/references/cli-commands.md
  - docs/database.md
  - docs/tutorials/adding-plan-schema-fields.md
  - src/tim/commands/cleanup-temp.ts
  - src/tim/commands/remove.db-cleanup-order.test.ts
  - src/tim/commands/remove.ts
  - src/tim/commands/sync.test.ts
  - src/tim/commands/sync.ts
  - src/tim/db/database.test.ts
  - src/tim/db/migrations.ts
  - src/tim/db/plan.test.ts
  - src/tim/db/plan.ts
  - src/tim/db/plan_sync.test.ts
  - src/tim/db/plan_sync.ts
  - src/tim/plans.ts
  - src/tim/tim.ts
  - tim-gui/TimGUI/PromptViews.swift
  - tim-gui/TimGUI/SessionModels.swift
  - tim-gui/TimGUITests/SessionModelTests.swift
tags: []
---

Whenever we update a tim task, also update the shared sqlite database. For now we don't need to store the plan details
since those can be edited freely by the agents, but any time we call writePlanFile we should also update the sqlite
database.

This will require adding new tables to represent plans and their tasks. Plans should be tracked internally by their
`uuid` field for foreign keys and such, with the numeric "id" used only for finding plans from user input and such.

As part of this we should also have a new maintenance command that will sync all the JSON plan data into the sqlite
database, and optionally delete plans from SQLite that no longer exist in the JSON.

## Research

### Overview

This feature adds SQLite-backed storage for plan metadata and tasks alongside the existing YAML/JSON plan files. The goal is to have a centralized queryable store of plan data across all active workspaces, since each workspace has its own copy of plan files on disk. The SQLite database already exists (`tim.db`) and stores projects, workspaces, assignments, permissions, and locks. This feature extends it with `plan` and `plan_task` tables.

### Critical Discoveries

1. **`writePlanFile` is the single write bottleneck**: All plan modifications flow through `writePlanFile()` in `src/tim/plans.ts` (70+ call sites across the codebase). This is the natural hook point for DB sync. The function validates the plan via Zod, cleans up defaults, and writes YAML frontmatter to disk.

2. **Project context is needed for DB operations**: The database scopes data by `project_id`. Resolving a project requires `getRepositoryIdentity()` (which calls `getGitRoot` + `git remote get-url origin`) — an async operation. The existing pattern in `removePlanAssignment` (in `src/tim/assignments/remove_plan_assignment.ts`) shows how to gracefully resolve project context and handle failures.

3. **UUIDs are auto-generated on first read**: When `readPlanFile()` encounters a plan without a UUID, it generates one and writes it back. This means every plan that flows through `writePlanFile` should have a UUID. The `uuid` field is the stable identifier across renumbering operations.

4. **bun:sqlite is synchronous**: All existing DB operations are synchronous (matching bun:sqlite's native API). The `writePlanFile` function is async (file I/O), so adding a sync DB call after the file write is straightforward.

5. **Migration system is simple and linear**: Migrations are in `src/tim/db/migrations.ts` as an array of `{version, up}` objects. Currently at version 1. Adding version 2 with the new tables follows the established pattern.

6. **Plan details are excluded**: Per the project description, the `details` field (which can be large markdown content) is not stored in SQLite. This keeps the DB lightweight.

### Notable Files and Patterns

**Database Layer (`src/tim/db/`)**:
- `database.ts`: Singleton `getDatabase()` with WAL mode, foreign keys, busy_timeout=5000ms. `openDatabase()` runs migrations and JSON import on first open.
- `migrations.ts`: Linear migration array. `runMigrations()` creates `schema_version` table, iterates migrations, updates version. All in `db.transaction().immediate()`.
- `sql_utils.ts`: Exports `SQL_NOW_ISO_UTC` for ISO-8601 UTC timestamps in DEFAULT clauses.
- `project.ts`: `getOrCreateProject()` uses INSERT OR IGNORE + SELECT pattern. `getProject()` fetches by `repository_id` string.
- `assignment.ts`: Already tracks `plan_uuid` and `plan_id` per project. Uses composite unique `(project_id, plan_uuid)`. The `Assignment` interface has `plan_uuid TEXT NOT NULL` and optional `plan_id INTEGER`.
- `workspace.ts`: `recordWorkspace()` uses INSERT ON CONFLICT UPDATE with COALESCE for partial updates.

**Plan File System (`src/tim/plans.ts`)**:
- `writePlanFile(filePath, input, options?)`: Validates, normalizes, strips defaults, writes YAML frontmatter. Returns `Promise<void>`. No knowledge of DB.
- `readPlanFile(filePath)`: Reads YAML frontmatter, validates, auto-generates UUID if missing.
- `readAllPlans(directory)`: Scans for `**/*.{plan.md,yml,yaml}`, returns `Map<id, PlanSchema & {filename}>` plus `uuidToId`/`idToUuid` maps, `maxNumericId`, and duplicate tracking.
- `setPlanStatus(planFilePath, newStatus)`: Reads, updates status, calls `writePlanFile`.
- `clearPlanCache()`: Invalidates the in-memory plan cache.

**Plan Schema (`src/tim/planSchema.ts`)**:
- `PlanSchema` type: Core fields include `id` (number), `uuid` (string, optional), `title`, `goal`, `details`, `status`, `priority`, `parent`, `dependencies` (number[]), `epic` (boolean), `tasks` (array of `{title, description, done}`), `createdAt`, `updatedAt`, `filename` (added by readAllPlans).
- `TaskSchema`: `{title: string, description: string, done: boolean}` with passthrough for extra fields.
- Status values: `pending | in_progress | done | cancelled | deferred`.
- Priority values: `low | medium | high | urgent | maybe`.

**Plan State Utilities (`src/tim/plans/plan_state_utils.ts`)**:
- `normalizePlanStatus()`: Validates/normalizes status strings.
- `isPlanActionable()`, `isPlanComplete()`: Status classification helpers.

**Repository Identity Resolution (`src/tim/assignments/workspace_identifier.ts`)**:
- `getRepositoryIdentity()`: Returns `{repositoryId, remoteUrl, gitRoot}`. Uses `deriveRepositoryName()` from git remote URL. This is the established pattern for getting the `repositoryId` needed to look up the project in the DB.

**Existing Assignment Pattern (`src/tim/assignments/remove_plan_assignment.ts`)**:
- Shows the canonical pattern: `getRepositoryIdentity() → getDatabase() → getProject() → DB operation`, wrapped in try/catch with warn-on-failure semantics. This is the model we should follow for the plan sync.

**CRUD Module Patterns**:
- All write operations use `db.transaction().immediate()`.
- Selective updates use `'field in options'` pattern to avoid overwriting unset fields.
- All tables have `created_at`/`updated_at` with `SQL_NOW_ISO_UTC` defaults.
- Functions are synchronous (bun:sqlite is sync).
- Interfaces define both raw DB row types and higher-level domain types.

### Architectural Considerations

1. **Performance of writePlanFile hook**: Adding a DB sync to every `writePlanFile` call means an async `getRepositoryIdentity()` call (git operations) on every write. This should be cached at the module level to avoid repeated git calls. The first call resolves and caches; subsequent calls reuse. The actual DB write is synchronous and fast.

2. **Bulk operations**: Commands like `renumber`, `validate --fix`, and `import` call `writePlanFile` many times in sequence. For these, we should either:
   - Accept the per-write sync overhead (DB writes are fast, git resolution is cached)
   - Or provide a way to batch/defer syncs (adds complexity, may not be needed)

3. **Test isolation**: Tests create temporary directories and don't necessarily have a DB. The sync should gracefully no-op when the DB isn't available or when the plan lacks a UUID.

4. **Dependency tracking**: Plan dependencies are stored as numeric IDs in the YAML (`dependencies: [5, 12]`). The plan also has a `references` map (`{5: "uuid-of-5", 12: "uuid-of-12"}`). For the DB, we should store dependencies by UUID (from the references map when available, otherwise we'd need to look up the UUID by plan_id).

5. **Parent-child relationships**: The `parent` field is a numeric plan ID. Similar to dependencies, we should store `parent_uuid` in the DB, resolved via the `references` map.

6. **Assignment table overlap**: The `assignment` table already stores `plan_uuid`, `plan_id`, and `status`. With the new `plan` table, there's some data overlap. The assignment table tracks workspace claims; the plan table tracks plan content. They serve different purposes but share some fields. We should consider whether to add a FK from assignment to plan, but this could cause issues if assignments exist for plans not yet synced.

### Expected Behavior/Outcome

- Every time a plan file is written via `writePlanFile`, the plan's metadata and tasks are upserted into the SQLite database.
- The `plan` table stores: uuid, project_id, plan_id (numeric), title, goal, status, priority, parent_uuid, epic flag, filename, and timestamps.
- The `plan_task` table stores: plan_uuid (FK), task_index, title, description, done flag.
- A `plan_dependency` table stores: plan_uuid, depends_on_uuid.
- A new `tim sync` command reads all plan files and bulk-syncs them to the DB, with an option to prune DB entries for plans that no longer exist on disk.
- DB sync failures are logged as warnings but never block the plan file write.

### Key Findings

**Product & User Story**: As a developer using tim across multiple workspaces, I want plan data centralized in SQLite so I can query plan status, tasks, and relationships without reading individual YAML files from potentially different workspace directories.

**Design & UX Approach**: The sync is transparent — users don't need to do anything differently. `writePlanFile` automatically keeps the DB in sync. The `tim sync` command is available for manual bulk synchronization and cleanup.

**Technical Plan & Risks**:
- Risk: Adding async git resolution to every `writePlanFile` call could slow down bulk operations. Mitigation: Cache the project context at module level.
- Risk: DB sync failures could cause confusing partial state. Mitigation: Wrap in try/catch, log warnings, never block file writes.
- Risk: Tests that call `writePlanFile` may fail if they don't have a DB. Mitigation: Graceful no-op when DB unavailable.

**Pragmatic Effort Estimate**: Medium. The core work is the migration, CRUD module, sync hook, and sync command. The patterns are well-established in the existing codebase.

### Acceptance Criteria

- [ ] New `plan`, `plan_task`, and `plan_dependency` tables are created via migration v2
- [ ] Every `writePlanFile` call syncs plan metadata and tasks to SQLite
- [ ] Plan UUID is used as the primary key for cross-table references
- [ ] `tim sync` command reads all plans from the tasks directory and bulk-upserts to DB
- [ ] `tim sync --prune` removes DB entries for plans no longer on disk
- [ ] `tim remove` and `tim cleanup-temp` delete plan rows from SQLite
- [ ] DB sync failures are logged as warnings, never blocking file writes
- [ ] Existing tests continue to pass without modification
- [ ] New tests cover CRUD operations, sync hook, and sync command
- [ ] All new code paths are covered by tests

### Dependencies & Constraints

- **Dependencies**: Depends on plan 158 (already listed in frontmatter). Relies on existing database infrastructure (migrations, project table, getDatabase singleton).
- **Technical Constraints**: Must not break existing `writePlanFile` behavior or slow it down significantly. Must handle missing DB gracefully (tests, non-standard environments). bun:sqlite synchronous API means DB operations are blocking but fast.

### Implementation Notes

**Recommended Approach**: Hook into `writePlanFile` using a lazy-cached project context pattern. On the first `syncPlanToDb` call, resolve the project context via `getRepositoryIdentity()` + `getOrCreateProject()` and cache it at module level. Subsequent calls reuse the cache. No explicit `setPlanSyncContext()` call from command initialization is needed — callers of `writePlanFile` don't need to change at all.

**Potential Gotchas**:
- `writePlanFile` is called with `skipUpdatedAt: true` during validation and UUID generation. These calls should still sync to DB (the plan data is valid, it's just not a user-initiated update).
- The `references` field maps numeric plan IDs to UUIDs. When resolving parent_uuid and dependency UUIDs, use the references map first, falling back to looking up UUIDs from the plan cache or DB.
- Plans without UUIDs (which shouldn't happen after readPlanFile, but could in edge cases) should be skipped for DB sync.
- The `readAllPlans` function provides `uuidToId` and `idToUuid` maps — useful for the sync command to resolve dependencies.

## Implementation Guide

### Step 1: Add Database Migration (v2)

Add a new migration to `src/tim/db/migrations.ts` at version 2 with three new tables:

**`plan` table**:
```sql
CREATE TABLE plan (
  uuid TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL,
  title TEXT,
  goal TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'in_progress', 'done', 'cancelled', 'deferred')),
  priority TEXT
    CHECK(priority IN ('low', 'medium', 'high', 'urgent', 'maybe') OR priority IS NULL),
  parent_uuid TEXT,
  epic INTEGER NOT NULL DEFAULT 0,
  filename TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ({SQL_NOW_ISO_UTC}),
  updated_at TEXT NOT NULL DEFAULT ({SQL_NOW_ISO_UTC})
);
CREATE INDEX idx_plan_project_id ON plan(project_id);
CREATE INDEX idx_plan_project_plan_id ON plan(project_id, plan_id);
CREATE INDEX idx_plan_parent_uuid ON plan(parent_uuid);
```

**`plan_task` table**:
```sql
CREATE TABLE plan_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_uuid TEXT NOT NULL REFERENCES plan(uuid) ON DELETE CASCADE,
  task_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  UNIQUE(plan_uuid, task_index)
);
CREATE INDEX idx_plan_task_plan_uuid ON plan_task(plan_uuid);
```

**`plan_dependency` table**:
```sql
CREATE TABLE plan_dependency (
  plan_uuid TEXT NOT NULL REFERENCES plan(uuid) ON DELETE CASCADE,
  depends_on_uuid TEXT NOT NULL,
  PRIMARY KEY(plan_uuid, depends_on_uuid)
);
```

Note: `depends_on_uuid` intentionally has no FK constraint because the depended-on plan may not be synced yet. `parent_uuid` on the plan table also has no FK for the same reason. The `plan` table has no unique constraint on `(project_id, plan_id)` because duplicate numeric IDs can temporarily exist when plans are added from multiple computers — the `renumber` command resolves these, and the DB should tolerate the interim state.

Follow the existing migration pattern: add a new entry to the `migrations` array with `version: 2` and the SQL as the `up` string.

### Step 2: Create Plan CRUD Module

Create `src/tim/db/plan.ts` following the patterns in `src/tim/db/assignment.ts` and `src/tim/db/workspace.ts`.

**Interfaces to define**:
- `PlanRow`: Raw DB row type (uuid, project_id, plan_id, title, goal, status, priority, parent_uuid, epic, filename, created_at, updated_at)
- `PlanTaskRow`: Raw task row (id, plan_uuid, task_index, title, description, done)
- `UpsertPlanInput`: Input for upserting a plan from `PlanSchema` data

**Functions to implement**:

1. `upsertPlan(db, projectId, plan, filename)`: Insert or update a plan row. Use `INSERT ... ON CONFLICT(uuid) DO UPDATE` pattern. Should also handle tasks and dependencies in the same transaction.

2. `upsertPlanTasks(db, planUuid, tasks)`: Replace all tasks for a plan. Delete existing tasks, then insert new ones. This is simpler and safer than trying to diff individual tasks. Run inside the upsertPlan transaction.

3. `upsertPlanDependencies(db, planUuid, dependencyUuids)`: Replace all dependencies. Delete existing, insert new.

4. `getPlanByUuid(db, uuid)`: Fetch a plan row by UUID.

5. `getPlansByProject(db, projectId)`: Fetch all plans for a project.

6. `getPlanTasksByUuid(db, planUuid)`: Fetch all tasks for a plan, ordered by task_index.

7. `deletePlan(db, uuid)`: Delete a plan (cascades to tasks and dependencies).

8. `getPlansNotInSet(db, projectId, uuids)`: Get plans in DB that are NOT in the provided UUID set. Used by the prune feature of the sync command.

All functions should be synchronous (matching bun:sqlite patterns). Use `db.transaction().immediate()` for write operations.

For `upsertPlan`, the transaction should:
1. INSERT OR REPLACE the plan row
2. DELETE all existing tasks for the plan UUID, then INSERT new tasks
3. DELETE all existing dependencies, then INSERT new dependencies

For resolving `parent_uuid` and dependency UUIDs from numeric IDs: Use the plan's `references` map first (`plan.references?.[numericId]`). If not available, fall back to `readAllPlans` (which has its own built-in cache) to get the `idToUuid` map. The `syncPlanToDb` function should accept an optional `idToUuid` map parameter so the bulk sync can pass it in directly; when not provided, the per-write hook calls `readAllPlans` which uses its existing cache.

### Step 3: Create Plan Sync Module

Create `src/tim/db/plan_sync.ts` — this module bridges the plan file system and the DB CRUD layer.

**Lazy-cached sync context**: On first call to `syncPlanToDb`, resolve the project via `getRepositoryIdentity()` (from `src/tim/assignments/workspace_identifier.ts`) and `getOrCreateProject()`, and resolve the tasks directory via `resolveTasksDir(config)`. Cache all of this (`projectId`, `repositoryId`, `tasksDir`) at module level. Subsequent calls skip the async operations entirely. Export a `clearPlanSyncContext()` for testing. The config object can be passed as an optional parameter to `syncPlanToDb`; when not provided, use `loadEffectiveConfig()` lazily. Most callers already have a config available.

**Core sync function**:
```typescript
export async function syncPlanToDb(
  plan: PlanSchemaInput,
  filePath: string
): Promise<void>
```

This function:
1. Checks if the plan has a uuid — if not, returns early.
2. Resolves sync context lazily (first call does `getRepositoryIdentity` + `getOrCreateProject` + `resolveTasksDir` and caches; subsequent calls use cache).
3. Gets the database via `getDatabase()`.
4. Resolves parent UUID and dependency UUIDs: first from `plan.references` map, then falling back to `readAllPlans(cachedTasksDir)` (which has built-in caching) to get the `idToUuid` map. Accepts an optional `idToUuid` parameter so the bulk sync can pass it in directly, avoiding redundant `readAllPlans` calls.
5. Calls `upsertPlan()` with the resolved data.
6. Wraps everything in try/catch, logging warnings on failure via `debugLog` or `warn`.

The function should extract the filename (just the basename) from the full file path for storage.

**Bulk sync function** (for the sync command):
```typescript
export async function syncAllPlansToDb(
  projectId: number,
  tasksDir: string,
  options?: { prune?: boolean }
): Promise<{ synced: number; pruned: number; errors: number }>
```

This function:
1. Calls `readAllPlans(tasksDir)` to get all plans.
2. For each plan, calls the DB upsert with full dependency/parent resolution (using the `uuidToId`/`idToUuid` maps from readAllPlans).
3. If `prune` is true, calls `getPlansNotInSet()` with the UUIDs from disk, then deletes orphaned plan DB entries and their corresponding assignment rows (via `removeAssignment`).
4. Returns statistics.

### Step 4: Hook writePlanFile

Modify `writePlanFile` in `src/tim/plans.ts` to call `syncPlanToDb` after the file write succeeds.

After the `await Bun.write(absolutePath, fullContent)` line, add:
```typescript
try {
  await syncPlanToDb(result.data, absolutePath);
} catch {
  // DB sync failures are non-fatal
}
```

Import `syncPlanToDb` from `../db/plan_sync.js` (or wherever it lives — keep it within the `src/tim/db/` directory for consistency).

The sync call uses `result.data` (the validated plan data) rather than `input` to ensure the DB gets the same normalized data that was written to disk.

### Step 5: Hook Plan Deletion Commands

Create a helper `removePlanFromDb(planUuid)` in `plan_sync.ts` that resolves project context lazily (same as `syncPlanToDb`) and calls `deletePlan(db, uuid)`. Follow the same graceful error handling pattern (try/catch with warn).

**`tim remove`** (`src/tim/commands/remove.ts`): After the existing `removePlanAssignment` call (line 138), add a call to `removePlanFromDb(target.plan.uuid)`. The `remove` command already reads the plan (has `target.plan` with uuid), so the uuid is readily available.

**`tim cleanup-temp`** (`src/tim/commands/cleanup-temp.ts`): This command deletes temp plan files directly via `fs.unlink` without going through `remove`. Add a `removePlanFromDb(plan.uuid)` call before or after each `fs.unlink` in the deletion loop.

### Step 6: Create the `tim sync` Command

Add a new command `sync` in `src/tim/commands/sync.ts`:

```typescript
export async function handleSyncCommand(options: {
  prune?: boolean;
  dir?: string;
}, command: Command): Promise<void>
```

The command:
1. Loads the effective config.
2. Resolves the tasks directory.
3. Resolves the repository identity and project (creating if needed via `getOrCreateProject`).
4. Calls `syncAllPlansToDb()`.
5. Prints a summary: "Synced N plans. Pruned M plans. N errors."

Register it in `src/tim/tim.ts`:
```typescript
program
  .command('sync')
  .description('Sync all plan files to the SQLite database')
  .option('--prune', 'Remove DB entries for plans that no longer exist on disk')
  .option('--dir <directory>', 'Directory to sync (defaults to configured task directory)')
  .action(async (options, command) => {
    const { handleSyncCommand } = await import('./commands/sync.js');
    await handleSyncCommand(options, command).catch(handleCommandError);
  });
```

### Step 7: Write Tests

**Unit tests for CRUD module** (`src/tim/db/plan.test.ts`):
- Test upsertPlan: insert new plan, update existing plan
- Test upsertPlanTasks: insert tasks, replace tasks on re-upsert
- Test upsertPlanDependencies: insert deps, replace deps
- Test getPlanByUuid, getPlansByProject
- Test deletePlan cascades to tasks and dependencies
- Test getPlansNotInSet for prune detection
- Follow patterns from `src/tim/db/assignment.test.ts` and `src/tim/db/workspace.test.ts`

**Integration tests for sync** (`src/tim/db/plan_sync.test.ts`):
- Test syncPlanToDb with a valid plan and project context
- Test syncPlanToDb gracefully handles missing UUID
- Test syncPlanToDb gracefully handles missing DB
- Test syncAllPlansToDb with multiple plan files
- Test prune functionality (add plans to DB, remove some files, sync with prune, verify removed)

**Integration tests for the sync command** (`src/tim/commands/sync.test.ts`):
- Test the command with a test directory of plan files
- Test --prune flag behavior

### Step 8: Manual Testing

1. Create a few test plans: `tim add "Test Plan 1"`, `tim add "Test Plan 2" --depends-on 1`
2. Run `tim sync` and verify plans appear in DB: `sqlite3 ~/.config/tim/tim.db "SELECT * FROM plan"`
3. Modify a plan via `tim set 1 --status in_progress` and verify DB updated
4. Mark a task done via `tim done 1` and verify DB task updated
5. Delete a plan file and run `tim sync --prune`, verify it's removed from DB
6. Run existing tests to confirm no regressions: `bun test`

## Current Progress
### Current State
- All tasks complete. Plan is fully implemented.

### Completed (So Far)
- Task 1: Database migration v2 with plan, plan_task, plan_dependency tables
- Task 2: Plan CRUD module (src/tim/db/plan.ts) with upsertPlan, getPlanByUuid, getPlansByProject, getPlanTasksByUuid, deletePlan, getPlansNotInSet
- Task 3: Plan sync module (src/tim/db/plan_sync.ts) with syncPlanToDb, removePlanFromDb, syncAllPlansToDb, clearPlanSyncContext
- Task 4: Hook writePlanFile to sync plans to SQLite (src/tim/plans.ts:736-746)
- Task 5: Hook plan deletion commands — removePlanFromDb added to remove.ts and cleanup-temp.ts
- Task 6: Create tim sync command (src/tim/commands/sync.ts, registered in tim.ts:514-522)
- Task 7: Unit tests for plan CRUD module (src/tim/db/plan.test.ts) and integration tests for sync (src/tim/db/plan_sync.test.ts)
- Task 8: Integration tests for sync command (src/tim/commands/sync.test.ts)
- Task 9: Repository identity now resolved from process.cwd() instead of plan/tasks dir
- Task 10: Prune skips when any plan files fail to parse (safety guard)
- Task 11: Tests for external tasks directories and prune-with-parse-failure confirmed present and passing (3 tests across plan_sync.test.ts and sync.test.ts)
- Task 12: Fallback UUID resolution uses plan path context (baseDir/tasksDir override)
- Task 13: Prune loop already wrapped in transaction (was fixed in prior commit)
- Task 14: Dead try/catch in writePlanFile already removed (was fixed in prior commit)
- Task 15: Migration already uses PRIMARY KEY (was fixed in prior commit)
- Task 16: Fallback UUID resolution now uses `context.tasksDir` instead of `path.dirname(filePath)` for cross-subdirectory resolution
- Task 17: Removed `removePlanAssignment` call from `handleRemoveCommand`; `removePlanFromDb` handles both plan+assignment deletion in one transaction
- Task 18: Integration tests added for sibling-subdirectory resolution and non-prune parse error reporting
- Task 19: `readAllPlans` now returns `erroredFiles` array; `syncAllPlansToDb` counts and warns about parse failures; redundant prune rescan replaced with `erroredFiles` check
- Task 20: Standardized file/DB deletion order to file-then-DB in `remove.ts` (already correct in `cleanup-temp.ts`)
- Task 21: `getPlansNotInSet` rewritten to use temp table instead of dynamic `NOT IN (...)`, avoiding SQLite variable limit
- Task 22: Resolved by Task 17 — double assignment deletion eliminated by removing `removePlanAssignment` call

### Remaining
- None

### Next Iteration Guidance
- None — all tasks complete

### Decisions / Changes
- Context caching is keyed by git root to prevent cross-project data corruption
- Dependency UUIDs are deduplicated after resolution to prevent PK violations
- Prune UUID set built from `allPlans.uuidToId.keys()` to handle duplicate numeric IDs correctly
- `deletePlan` uses direct DELETE (no transaction wrapper) matching `removeAssignment` pattern
- `removePlanFromDb` wraps deletePlan + removeAssignment in a single transaction
- Helper functions renamed to `coercePlanStatus`/`coercePlanPriority` to avoid confusion with existing `normalizePlanStatus`
- `syncPlanToDb` accepts a `baseDir` option for resolving project context from the plan file location
- Sync command uses `pluralize` helper for clean summary output
- Repository identity resolution changed from `baseDir` to `process.cwd()` for correctness with external tasks paths
- Fallback UUID resolution in `syncPlanToDb` now uses `context.tasksDir` (from resolved sync context) instead of `options.baseDir ?? path.dirname(filePath)` — ensures cross-subdirectory lookups work
- Prune safety now uses `readAllPlans.erroredFiles` instead of a redundant Glob rescan — eliminates double-counting and redundant I/O
- `readAllPlans` returns `erroredFiles: string[]` tracking files that failed to parse (excluding NoFrontmatterError)
- `remove.ts` deletion order standardized to file-then-DB (orphan DB rows cleaned by `tim sync --prune`)
- `getPlansNotInSet` uses temp table for UUID exclusion to avoid `SQLITE_MAX_VARIABLE_NUMBER` limit

### Lessons Learned
- `readAllPlans` drops duplicate numeric IDs from its plans Map (keeps last one). When iterating all plans for bulk sync, must also process `allPlans.duplicates` to capture plans that lost the ID collision. The `uuidToId` map retains all UUIDs regardless.
- Single-statement DELETEs in SQLite don't need explicit transaction wrappers since FK cascades happen within the implicit transaction
- When a function resolves git identity or other path-dependent context, always use the process working directory (caller's git context) rather than the target file's directory — they diverge when tasks paths point outside the repo
- When adding error tracking to a function that already has a downstream consumer with its own error counting (like prune safety), avoid double-counting by reusing the upstream error data rather than re-deriving it. The prune safety rescan was redundant with `readAllPlans(... false)` which already did a fresh scan.
- Use exact assertions (`toBe(1)`) instead of range assertions (`toBeGreaterThan(0)`) in tests where the expected count is known — range assertions mask off-by-one and double-counting bugs
- When multiple code paths delete the same DB row via different identity resolution strategies, consolidate to a single path — having `removePlanFromDb` own both plan+assignment deletion avoids wrong-project targeting with external task dirs

### Risks / Blockers
- None
