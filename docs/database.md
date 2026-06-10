### bun:sqlite Transaction Patterns

- All DB functions are **synchronous** (matching bun:sqlite's native API)
- `db.transaction()` returns an object with `.immediate()`, `.deferred()`, `.exclusive()` methods — it does NOT return a function directly
- Use `.immediate()` for all write transactions consistently: `db.transaction().immediate(() => { ... })`
- Inner `db.transaction().immediate()` calls within an existing transaction automatically use savepoints — no special handling needed for nesting
- Single-statement DELETEs (and other single-statement writes) don't need transaction wrappers since individual SQL statements are already atomic in SQLite

### Schema Migrations

- `ALTER TABLE ADD COLUMN` in SQLite supports inline `REFERENCES other_table(col) ON DELETE ...`, so adding an FK with delete behavior does not require a table rebuild.
- `CHECK` constraints on an added column **do** require a table rebuild. For enum-like validation on a newly-added nullable column, prefer write-path validation in the DB helper layer — it's less invasive and catches bad data at the same moment.
- **Table-rebuild migrations must build the `*_new` table to match the CURRENT table shape (all current columns), not an old historical shape.** When a migration alters a CHECK constraint (e.g. adding a status enum value), it can only do so by rebuilding the table — but it's easy to copy an outdated column list from an earlier migration's rebuild as a starting template. Doing so silently drops or renames columns added by intervening migrations and fails against real migrated DBs. Base the `*_new` table on the table's present-day definition (current column count), then copy rows and rename. The v6→v41 status-enum migrations are the precedent; v41's first draft had to be corrected from a stale `filename`-column shape to the current 32-column shape.
- Nullable back-compat columns (e.g. `side` defaulting to `'RIGHT'` on read when NULL) are fine, but keep the read-path fallback in one place and throw on unexpected non-null values so data corruption doesn't hide.
- **Even an index-only migration has obligations beyond the `CREATE INDEX`.** Adding a migration that only creates an index still bumps the schema version, so the schema-version tests (expected version number, migration count) must be updated in lockstep. Additionally, write the migration defensively for synthetic migration fixtures: test fixtures that simulate an old DB shape may not include every production table, so a `CREATE INDEX` against an assumed-present table can fail there. Guard with `CREATE INDEX IF NOT EXISTS` and/or verify the target table exists before indexing rather than assuming the full production schema.

### Cross-Table Integrity

- Integrity constraints that span multiple tables (e.g. "this submission belongs to the same review as these issues", or "don't stamp an issue that's already claimed by another submission") cannot be expressed as a composite FK in SQLite. Enforce them in the DB helper layer with an explicit pre-check inside the same transaction as the write, not in the caller — callers forget.

### Partial-Update Validation

- Validating partial-update patches against a zod schema requires loading the pre-state and merging with the patch before validation. Validating only the patch fragment allows partial updates to create invalid merged states (e.g. updating `line` alone to a value lower than the existing `start_line`, inverting the range). See `validatePatch` in `src/routes/.../review_issue_editor_utils.ts` for the pattern.

### SQL Security

- Always use parameterized queries (`?` placeholders), even for values that have been validated as integers or other safe types. This maintains consistent security patterns and prevents accidental injection if validation is later removed.

### Shared Utilities

- `SQL_NOW_ISO_UTC` in `src/tim/db/sql_utils.ts` provides the canonical SQL expression for generating ISO-8601 UTC timestamps — always import from there instead of duplicating the `strftime` call

### Data Import / Migration

- Import functions should preserve legacy field values (status, timestamps, etc.) rather than applying defaults that lose data
- The `shouldRunImport`/`markImportCompleted` pattern uses a persistent `import_completed` flag in `schema_version`, not record counts, to prevent redundant filesystem scans on subsequent opens
- One-time migration on DB creation is sufficient — re-importing legacy data on every command invocation can overwrite newer DB state
- Hierarchical imports (parent + children from a single GitHub issue) are written to the DB atomically in a single transaction via `writeImportedPlansToDbTransactionally()`. File writes happen after the transaction with `skipDb: true`. The plan snapshot is refreshed after each successful import so subsequent imports in the same batch see newly created plans

### Querying / Listing Patterns

- When migrating from filesystem scanning to DB queries for listings, ensure cleanup operations also update DB state — otherwise deleted entries reappear in listings
- Filter criteria for DB-backed listings must not rely on fields set by unrelated operations (e.g., `last_git_root` is set by workspace/lock flows but shouldn't make a project appear in external storage listings). Use explicit marker fields instead

### Workspace Lock Design

- Stale lock detection requires both PID liveness check AND age-based timeout (24h default) to handle PID recycling edge cases — checking only PID liveness is insufficient
- Stale locks are cleaned up on read (`getLockInfo`, `isLocked`), not just on acquisition
- Stale lock cleanup uses targeted deletes (`releaseSpecificWorkspaceLock`) matching `workspace_id + pid + started_at` to avoid TOCTOU races where a replacement lock could be deleted
- Invalid `started_at` values (producing `NaN` lock age) are treated as stale, matching the DB layer behavior
- Cleanup handlers (`process.on` exit/SIGINT) are properly unregistered on `releaseLock` using a Map keyed by workspace path — prevents listener leaks
- Lock storage is fully DB-backed

### ON CONFLICT / Upsert Patterns

- `ON CONFLICT DO UPDATE SET col = excluded.col` will overwrite existing values with whatever was passed — including `NULL` when the caller provides sparse input. Use `COALESCE(excluded.col, col)` for columns that should preserve their existing value when the new value is null. This is especially important for `recordWorkspace`-style functions that may be called from multiple processes with different subsets of fields populated.
- **COALESCE prevents clearing nullable fields**: The `COALESCE(excluded.col, col)` pattern is only appropriate when null means "not provided." For update functions that need to support explicitly clearing a nullable column to NULL, use conditional field building instead — build the SET clause dynamically, only including columns present in the input (use `'field' in input` to distinguish "omitted" from "explicitly null"). See `updateReview()` in `src/tim/db/review.ts` for the pattern.
- When calling `getOrCreateProject()` followed by `updateProject()`, compare existing field values against the new values before updating. Skipping the update when all fields match avoids unnecessary `updated_at` timestamp bumps that make projects appear modified when they weren't.
- When adding a provenance/source column to a junction table, include it in the primary key so both sources can coexist for the same entity pair. `INSERT OR IGNORE` with a single-column key won't allow inserting a second row with a different source — the first source wins silently.
- Multi-step DB mutations (e.g., upsert + clear child rows + update related rows) should be wrapped in a single transaction for atomicity, even if each individual statement seems independent. This prevents partial state from being visible to concurrent readers or from persisting if a later step fails.
- **Match ordering semantics within a module**: When adding SQL dedup logic (e.g., correlated subqueries for "latest per group"), ensure the ordering matches the module's existing convention. If the module defines "latest" as `ORDER BY created_at DESC`, don't use `MAX(id)` — ID ordering and timestamp ordering can diverge when records are inserted out of chronological order or across time zones.

### Plan SQLite Sync

Plan metadata, tasks, and dependencies are mirrored in SQLite alongside the YAML plan files. This enables centralized querying across workspaces without reading individual files from disk.

**Tables** (migration v2, extended through v41):

- `plan`: Core metadata (uuid PRIMARY KEY, project_id FK, plan_id, title, goal, details, status, priority, parent_uuid, epic, filename, timestamps). The `status` column is constrained by a `CHECK(status IN (...))` listing the valid plan statuses: `pending`, `in_progress`, `needs_review`, `reviewed`, `done`, `cancelled`, `deferred`. `reviewed` (sits between `needs_review` and `done`) was added in migration v41, which rebuilds both `plan` and `plan_canonical` to expand the CHECK constraint (SQLite cannot alter a CHECK in place). It counts as work-complete for dependency/stacked calculations but is not terminal. Additional columns added in later migrations: `assigned_to`, `simple`, `tdd`, `discovered_from`, `base_branch`, `base_plan_uuid` (TEXT, nullable, soft reference to another plan for stacked PR branch resolution), `base_commit` (TEXT), `base_change_id` (TEXT), `issue` (JSON), `pull_request` (JSON), `branch`, `temp` (INTEGER), `docs` (JSON array), `changed_files` (JSON array), `plan_generated_at` (TEXT), `review_issues` (JSON array of objects), `docs_updated_at` (TEXT), `lessons_applied_at` (TEXT). No unique constraint on `(project_id, plan_id)` to tolerate temporary duplicate numeric IDs. `base_commit` and `base_change_id` are DB-managed fields for stacked PR base tracking — they are not imported from plan files during file→DB sync.
- `plan_task`: Tasks per plan (plan_uuid FK with CASCADE, task_index, title, description, done). UNIQUE on `(plan_uuid, task_index)`.
- `plan_dependency`: Dependencies by UUID (plan_uuid FK with CASCADE, depends_on_uuid, composite PK). No FK on `depends_on_uuid` since the referenced plan may not be synced yet.

**CRUD module** (`src/tim/db/plan.ts`):

- `nonSyncedUpsertPlan(db, projectId, input)`: explicit sync-bypass INSERT ON CONFLICT(uuid) DO UPDATE helper, replacing tasks and dependencies in the same transaction. Runtime plan mutations must use `src/tim/sync/write_router.ts`; this helper is reserved for file-to-DB sync internals, legacy cleanup paths, and tests.
- `getPlanByUuid`, `getPlansByProject`, `getPlanTasksByUuid`, `deletePlan`, `getPlansNotInSet`
- `getPlansNotInSet` uses a temporary table for the UUID exclusion set instead of a dynamic `NOT IN (?)` clause, avoiding SQLite's `SQLITE_MAX_VARIABLE_NUMBER` limit (default 999)
- All functions are synchronous, write operations use `db.transaction().immediate()`

**Sync module** (`src/tim/db/plan_sync.ts`):

- `syncPlanToDb(plan, filePath, options?)`: Upserts a single plan to DB. Uses lazy-cached project context (keyed by git root) resolved via `getRepositoryIdentity()` + `getOrCreateProject()`. Accepts optional `idToUuid` map for bulk operations. Options: `throwOnError` (propagate errors instead of logging warnings), `cwdForIdentity` (override CWD for repository identity resolution).
- `removePlanFromDb(planUuid, options?)`: Deletes plan and its assignment in a single transaction. Supports `throwOnError: true` to propagate DB deletion failures to the caller (used by `cleanup-temp` to keep the DB row intact when file deletion succeeds but DB deletion fails).
- `clearPlanSyncContext()`: Resets cached context for testing.
- DB sync failures are logged as warnings, never blocking plan file writes.
- Stale write protection: when a plan includes `updatedAt`, direct DB upserts are skipped if that timestamp is older than the existing row's `updated_at`. `tim sync --force` disables this guard. All file→DB sync paths (including `syncMaterializedPlan`) rely on this guard — `force: true` is reserved for explicit user-initiated sync operations, never used in generic resolution or workspace reuse paths. **Important**: any sync path that modifies data must refresh `updatedAt` to a current timestamp before calling `nonSyncedUpsertPlan()`, otherwise the stale-write guard may cause subsequent syncs to silently skip updates.

**Context caching**: The sync module caches project context per git root to avoid repeated `getRepositoryIdentity()` calls. Concurrent context resolution for the same git root is deduplicated via a shared promise.

**Repository identity**: `getRepositoryIdentity()` is always called from `process.cwd()` (the caller's git context), never from the plan file directory. This prevents mis-associating plans to the wrong project.

**UUID resolution**: When resolving parent/dependency UUIDs from numeric IDs, the sync module queries the DB's plan ID→UUID mapping directly. The `plan.references` field is no longer used for resolution.

**Deletion ordering**: Plan deletion commands (`tim remove`, `tim cleanup-temp`) use file-then-DB order: delete the plan file first, then remove the DB row. `removePlanFromDb` handles both plan and assignment deletion in a single transaction, so callers do not need to call `removePlanAssignment` separately.

**Error handling layers**: `syncPlanToDb` has a single try/catch that logs warnings and never rethrows by default. The `throwOnError: true` option enables error propagation for callers that need correctness guarantees (e.g., `syncMaterializedPlan`). The `cwdForIdentity` option overrides the working directory used by `getRepositoryIdentity()` during context resolution. Callers (e.g., `writePlanFile`) trust the default behavior and do not add redundant outer error handling.

### Plan Materialization

Plan materialization writes plan files from DB data to disk at well-known paths, enabling agents to edit plans as files while the DB remains the source of truth. Module: `src/tim/plan_materialize.ts`.

**File layout**: All materialized plans live at `{repoRoot}/.tim/plans/{planId}.plan.md`. Each file contains a `materializedAs` YAML frontmatter field (`'primary' | 'reference'`) to distinguish explicitly materialized plans from related-plan snapshots. `ensureMaterializeDir()` creates the directory and writes a `.gitignore` with `*.plan.md` to prevent accidental commits.

**Shadow copies**: When a primary plan is materialized, an identical hidden shadow copy is written alongside at `.tim/plans/.{planId}.plan.md.shadow`. The shadow records the exact state written during materialization and is used during sync to detect which fields the user actually changed (vs. round-tripped unchanged). Reference files do not get shadow copies. Shadow files use the same YAML+markdown format as plan files and are parsed by `readShadowPlanFile()` — a side-effect-free parser that avoids the UUID auto-generation behavior of `readPlanFile()`.

**Core functions**:

- `materializePlan(planId, repoRoot, options?)`: Queries plan from DB, converts via `planRowToSchemaInput()`, writes both the plan file and shadow copy using `generatePlanFileContent()` (a single serialization pass). Sets `materializedAs: 'primary'`. Returns the file path.
- `materializeRelatedPlans(planId, repoRoot, options?)`: Materializes parent, children, siblings, and dependency plans as `.plan.md` files with `materializedAs: 'reference'`. Skips existing primary files to preserve user edits; overwrites existing reference files with fresh DB content. No shadow copies for references.
- `syncMaterializedPlan(planId, repoRoot, options?)`: Skips reference files (they are read-only snapshots). For primary files: (1) reads shadow file if present, (2) reads current file, (3) uses `diffPlanFields()` to detect changed fields — skips DB sync if nothing changed, (4) if changes detected, reads current DB state and calls `mergePlanWithShadow()` to overlay only changed fields from the file onto the DB state, (5) syncs the merged result via `syncPlanToDb()`, (6) re-materializes the plan (updating both file and shadow to reflect merged DB state). When shadow is missing or corrupt, falls back to full-overwrite behavior. When `force: true`, bypasses merge and syncs the file plan directly. Options include `skipRematerialize` to avoid double re-materialization when called from `withPlanAutoSync()`.
- `readMaterializedPlanRole(filePath)`: Side-effect-free frontmatter reader that returns the `materializedAs` role without triggering DB writes or UUID generation.
- `withPlanAutoSync(planId, repoRoot, fn)`: Auto-sync wrapper for commands that modify plans while agents may be editing the materialized file. Syncs file→DB before `fn()` (with `skipRematerialize`), re-materializes DB→file after. Uses try/finally with error suppression in the finally block to prevent re-materialization errors from masking `fn()` errors.

**Shadow diff and merge**:

- `diffPlanFields(shadow, current)`: Compares all user-editable fields between shadow and current file plans using `Bun.deepEquals()`. Returns `{ changedFields: Set<string>, hasChanges: boolean }`. Compared fields: title, goal, details, status, priority, parent, branch, simple, tdd, discoveredFrom, assignedTo, baseBranch, basePlan, temp, epic, planGeneratedAt, dependencies, issue, pullRequest, docs, changedFiles, tags, tasks, reviewIssues. Excludes: id, uuid, createdAt, updatedAt, materializedAs, references.
- `mergePlanWithShadow(dbPlan, shadowPlan, filePlan)`: Starts from `dbPlan`, overlays only the fields that differ between `shadowPlan` and `filePlan`. This preserves DB-side changes (e.g., from web UI) to fields the user didn't edit in the file. When shadow is null, returns `filePlan` unchanged (full overwrite for backward compatibility).

**Path helpers**: `getMaterializedPlanPath(repoRoot, planId)`, `getShadowPlanPath(repoRoot, planId)`, `getShadowPlanPathForFile(planFilePath)`.

**CLI entry points**: `tim materialize <planId>` writes the working copy, `tim sync <planId>` syncs a single materialized file back to DB, `tim sync` (no args) scans `.tim/plans/` for all `*.plan.md` files and syncs them all (supports `--verbose` for progress output), and `tim cleanup-materialized` removes stale files.

**`skipDb` / `skipFile` options on `writePlanFile()`**: `skipDb` prevents the DB write; used by materialization to avoid circular sync when writing a file that was just read from the DB. `skipFile` prevents the file write; used when only the DB needs updating. When `filePath` is null, file writing is automatically skipped.

**UUID safety**: `syncMaterializedPlan()` extracts the UUID from raw file YAML before calling `readPlanFile()`, because `readPlanFile()` auto-generates UUIDs for files missing them (which would corrupt a materialized file with a wrong UUID).

**`readPlanFile()` write side effect**: `readPlanFile()` is not a pure read operation. When a plan file is missing a UUID, it auto-generates one and persists it back to disk via `writePlanFile()`, which also triggers a DB insert. Callers that need read-only behavior (e.g., reading plan files for comparison or diffing) should use `readShadowPlanFile()` instead — it parses the same YAML+markdown format but has no side effects.

### DB-First Plan Resolution and Writing

The plan system uses DB-first access: the SQLite database is the source of truth for plan data, with files as optional materialized views.

**Plan resolution** (`src/tim/plans.ts`):

- `resolvePlanByNumericId(planId: number, repoRoot, options?)`: Strictly-typed resolver for numeric plan IDs. Returns `{ plan: PlanSchema, planPath: string | null }` where `planPath` is the materialized file path (via `getMaterializedPlanPath()`) if one exists on disk, or `null` for DB-only plans. Throws `PlanNotFoundError` if the plan is not found in the DB — no file fallback. Options: `context` (pre-resolved `ProjectContext`).
- `resolvePlanByUuid(uuid: string, repoRoot, options?)`: Strictly-typed resolver for plan UUIDs. Validates UUID format up front and rejects numeric strings/file paths. Not project-scoped (unlike the numeric variant). Used by internal consumers — no CLI command accepts a UUID positional.
- `parsePlanIdentifier(planArg: string | number)`: Small dispatcher that returns `{ planId?, uuid? }` for the handful of call sites (e.g. MCP identifier tools) that genuinely accept either form. Those sites then dispatch to the appropriate resolver.
- `parsePlanIdFromCliArg(arg: string): number` / `parseOptionalPlanIdFromCliArg(arg: string | undefined): number | undefined`: Boundary parsers used in Commander `.action` handlers. CLI commands call these once and pass `number` (or `number | undefined`) onward — handler signatures across `src/tim/commands/**` are strictly numeric.
- When a Commander option uses `parsePlanIdOption` as its argument coercer, the option value is already `number | undefined` by the time the command body sees it. Do not add defensive `typeof !== 'number'` / `Number.isNaN` / `Number.isInteger` checks in the command body — those branches are unreachable and inconsistent with the rest of the codebase. Keep only the domain validations (target exists, self-reference, etc.).
- `PlanNotFoundError` (`src/tim/plans.ts`): Custom error class for plan-not-found conditions. Use `instanceof PlanNotFoundError` to check errors — avoids false positives from broad string matching against unrelated "not found" messages.
- `resolvePlan()` in `plan_display.ts` delegates to the split resolvers. Returns nullable `planPath` — callers must handle `null`.

**Plan writing** (`src/tim/plans.ts`):

- `writePlanToDb(input, options?)`: Validates, normalizes (fancy quotes, deprecated fields), and writes a plan to the DB in a single transaction (`nonSyncedUpsertPlan` + `upsertPlanTasks` + `upsertPlanDependencies` + `upsertPlanTags`). Returns the validated `PlanSchema`. Accepts optional `ProjectContext` to avoid redundant queries.
- `writePlanFile(filePath, input, options?)`: DB-first write function. `filePath` can be `string | null` — when null, only the DB is written (file write is skipped). When `filePath` is null, either `cwdForIdentity` or `context` must be provided (throws otherwise) so the correct project can be resolved for the DB write. Options: `skipFile` (skip file write), `skipDb` (skip DB write, used by materialization to avoid circular sync), `skipUpdatedAt`, `cwdForIdentity`, `context`.

**Project context** (`src/tim/plan_materialize.ts`):

- `resolveProjectContext(repoRoot, repository?)`: Returns `ProjectContext` with `projectId`, `rows`, `planIdToUuid`/`uuidToPlanId` maps, `duplicatePlanIds`, and `maxNumericId` (highest plan ID in DB). Caches results per repo root. Used by `resolvePlanByNumericId()`, `writePlanToDb()`, and `generateNumericPlanId()`.

**ID generation** (`src/tim/id_utils.ts`):

- `generateNumericPlanId(tasksDir, options?)`: Uses `resolveProjectContext().maxNumericId` from the DB. The `tasksDir` parameter is a legacy artifact that will be removed in a future cleanup.

### Plan Loading from DB

`src/tim/plans_db.ts` provides `loadPlansFromDb(searchDir, repositoryId)` — a shared function that assembles `PlanWithFilename` objects from DB rows (plans, tasks, tags, dependencies) for a given project. Returns `PlansLoadResult` with `plans: Map<number, PlanWithFilename>` and `duplicates`. Uses `planRowToSchemaInput()` to convert DB rows to `PlanSchema` objects with full field coverage.

**`planRowToSchemaInput(row, tasks, deps, tags, uuidToPlanId?)`** converts a single plan's DB data to `PlanSchema`. Handles all fields including JSON-stored columns (`issue`, `pullRequest`, `docs`, `changedFiles`, `reviewIssues`). Resolves `parent_uuid`, `base_plan_uuid`, and dependency UUIDs back to numeric plan IDs — if a `uuidToPlanId` map is provided it uses that, otherwise it queries the DB for needed UUIDs. This shared converter is used by both `loadPlansFromDb()` (bulk loading) and `resolvePlanByNumericId()` (single-plan resolution).

**`planRowForTransaction(row, uuidToPlanId)`** is a convenience wrapper that fetches tasks, dependencies, and tags from the DB for a given plan row, then delegates to `planRowToSchemaInput()`. Used by commands that need to resolve a plan within a DB transaction (e.g., `add`, `set`, `create_plan`). **`invertPlanIdToUuidMap(planIdToUuid)`** converts a `Map<number, string>` (planId→UUID) to the `Map<string, number>` (UUID→planId) format expected by `planRowToSchemaInput`. Both are exported from `plans_db.ts` to avoid duplication across command modules.

Used by `tim list`, `tim ready`, `tim show` (for `--next-ready` dependency resolution), and the MCP `list-ready-plans` tool. All commands use DB-only access.

### Parent Cascade (DB-First)

Parent completion and status cascading is handled by `src/tim/plans/parent_cascade.ts`, a consolidated module replacing the previous two separate implementations in `mark_done.ts` and `commands/agent/parent_plans.ts`.

**Key functions**:

- `checkAndMarkParentDone(config, plan, options?)`: Queries `getPlansByParentUuid()` to find all children of the parent, checks their statuses from DB. If all children are work-complete (`done`, `needs_review`, `reviewed`, `cancelled`, or `deferred`) and the parent isn't already cancelled or deferred, marks the parent using `getCompletionStatus(config)` (defaults to `needs_review`) via `writePlanFile()` with auto-materialization. Recursively checks grandparent.
- `markParentInProgress(config, plan, options?)`: Sets parent status to `in_progress` if currently `pending`. Uses DB queries to look up parent by UUID.

**`ParentCascadeOptions`**: Both functions accept optional callbacks (`onParentMarkedDone`, `onParentMarkedInProgress`) for logging, allowing CLI and agent code to provide different output behavior.

**Pattern**: Parent cascade operations must run _after_ writing the child's updated status to the DB. The functions use `withPlanAutoSync()` internally when the parent has a materialized file, ensuring file↔DB consistency.

### MCP Tool DB-First Patterns

MCP tools that modify plans follow a consistent DB-first pattern using `withPlanAutoSync()`:

**Read-modify-write tools** (`manage_plan_task`, `update_plan_tasks`, `update_plan_details`):

1. Resolve plan via `resolvePlan()` (DB-first) for initial ID extraction
2. Wrap modification in `withPlanAutoSync(planId, repoRoot, async () => { ... })`
3. Inside the wrapper: re-resolve from DB, modify in-memory, write back via `writePlanToDb()` or `writePlanFile()`
4. Auto-sync handles file→DB before and DB→file after

**Create tool** (`create_plan`):

- Writes new plan directly to DB via atomic transaction (`nonSyncedUpsertPlan` + `upsertPlanTasks` + parent update in single `db.transaction().immediate()`)
- Generates numeric ID from `reserveNextPlanId()` (DB-backed)
- Syncs parent materialized file before transaction, re-materializes after (async I/O outside synchronous transaction)
- No tasks directory required

**Read-only tools** (`get_plan`, `list_ready_plans`):

- `get_plan` uses DB-first `resolvePlan()`
- `list_ready_plans` is DB-only

### CLI Command DB-First Patterns

All CLI commands use DB-first access — the SQLite database is the source of truth, with files as optional materialized views.

**`tim add`**: Creates new plans directly in the DB without requiring a tasks directory or output file. Generates numeric IDs from `resolveProjectContext().maxNumericId`. Parent updates (adding child to parent's dependencies) happen atomically in the same DB transaction. When the `--edit` flag is used, the plan is materialized to `.tim/plans/{planId}.plan.md`, opened in `$EDITOR`, synced back to DB, then the temporary materialized file is cleaned up.

**`tim edit`**: Materializes the plan from DB to `.tim/plans/{planId}.plan.md`, opens `$EDITOR`, syncs the edited file back to DB via `syncMaterializedPlan()`, then cleans up the materialized file. Pre-existing materialized files are preserved (only temp files created by the edit command are deleted). The editor's exit code is checked before syncing — non-zero exit skips the sync.

**`tim set`**: Loads plan from DB via `resolvePlanByNumericId()`, applies metadata changes in-memory, writes to DB via `writePlanToDb()`. Multi-plan updates (parent/child cascading, dependency changes) use DB transactions for atomicity. Re-materializes the plan file if one exists on disk. Uses `checkAndMarkParentDone()` from `parent_cascade.ts` for parent status cascading.

**`tim done` / `mark_done.ts`**: Loads plan from DB, marks tasks as done, updates `changedFiles` from Git, writes to DB via `writePlanToDb()`. When all tasks are complete, sets plan status to `getCompletionStatus(config)` (defaults to `needs_review`). Assignments and workspace locks are preserved for `needs_review` plans (only released on actual `done`). Re-materializes if a materialized file exists. Parent cascade (`checkAndMarkParentDone()`) runs after the child's status is written to DB.

**`tim set-task-done` / `tim add-task`**: Both use `resolvePlanByNumericId()` from `plans.ts` to resolve plans by numeric ID or UUID. Writes go through `writePlanFile()` (DB-first, then optional file materialization).

**`tim list` / `tim ready`**: DB-only via `loadPlansFromDb()`. All filtering, sorting, and display logic operates on DB-loaded plans. No `--local` file-scanning fallback. Filenames in JSON/structured output are checked with `fs.existsSync()` before inclusion — DB-only plans get empty filenames instead of bogus synthesized paths, matching the MCP `list_ready_plans` behavior.

**`tim show`**: Resolves plans from DB via `resolvePlanByNumericId()`. When `--next-ready` is used, finds the next ready dependency using `loadPlansFromDb()` and DB-backed readiness checks, falling back to the parent plan when all dependencies are complete. Plan context display assembled from DB data; `planPath` may be null for DB-only plans.

**`tim generate` / `tim chat`**: Resolve plans from DB via `resolvePlanByNumericId()`. Both commands derive the repo root from the loaded config via `resolveRepoRoot()`, which correctly handles `--config` for cross-repo plan resolution. The repo root is computed once and shared between plan resolution and workspace setup. Plans are materialized into the workspace at `.tim/plans/{planId}.plan.md` via `setupWorkspace()` (which accepts a `planId` option). The executor edits the materialized file during execution. After the executor finishes, `syncPlanToDb()` syncs the edited file back to DB. Post-execution sync targets the actual file the executor edited, including reused legacy backing files when present.

**`tim agent`**: Uses DB-backed plan discovery functions from `plan_discovery.ts` for all plan resolution modes (`--next-ready`, `--latest`, `--next`, `--current`, direct argument). `resolvePlanByNumericId()` resolves the plan, then materializes into the workspace via `setupWorkspace()`. Taskless plans are prepared by adding one task derived from the plan title/goal/details, then continue through normal batch execution. `batch_mode.ts` uses `setPlanStatusById()` for DB-first completion status updates with `getCompletionStatus(config)` (defaults to `needs_review`). Completion side effects (assignment removal via `removePlanAssignment()`, parent cascade via `checkAndMarkParentDone()`) are deferred until after final review confirms the plan is still complete — if review reopens the plan by appending tasks, these side effects are skipped. When `planAutocompleteStatus: 'done'`, assignment removal runs; for `needs_review`, assignments and workspace locks are preserved. Batch mode resets status to `in_progress` when review appends tasks and the user declines to continue. When reusing a workspace branch, existing materialized files are synced back to DB before re-materializing to prevent data loss from unsynced edits.

**`tim review`**: When no plan is specified, auto-detects the plan via `autoSelectPlanForReview()`: extracts plan ID from the current branch name using `/^(\d+)-/` pattern and resolves via `resolvePlanByNumericId()`. If found, validates any existing materialized file's ID before reusing, and materializes fresh from DB to avoid stale file overwrites. When a plan is explicitly specified via `tim review <planId>`, uses `resolvePlanByNumericId()`. Write operations (`resolveReviewPlanForWrite()`) use `resolveRepoRoot()` with `configPath` threading for correct cross-repo resolution. `gatherPlanContext()` in `context_gathering.ts` uses `resolvePlanByNumericId()` for plan resolution and `loadPlansFromDb()` for hierarchy (parent chain, completed children), returning `repoRoot` and `gitRoot` in `PlanContext` so callers don't re-derive them from CWD. For `--autofix` flows, `ensureReviewPlanFilePath()` materializes DB-only plans before invoking the executor, memoizing to avoid redundant materialization. After the autofix executor edits the materialized file, `syncPlanToDb(force: true)` syncs changes back to DB (force is intentional since the executor just wrote the latest state). Both explicit `tim review 123 --autofix` and branch-name auto-selected DB-only plans are covered.

`tim review` also supports **planless review targets** that touch no plan rows. `resolveReviewTarget()` (`review_target.ts`) returns a `ReviewTarget` union of `plan` | `current` | `branch` | `pr`. `--current` reviews the current worktree in place, `--branch <branch>` prepares a managed workspace on the requested branch, and `--pr <pr-url-or-number>` validates the PR against the current repository and prepares its head branch in a workspace. No-arg `tim review` still tries branch-name plan auto-selection first, then falls back to a `current`-worktree planless target; it never auto-selects a linked PR or plan from PR status. Planless targets are intentionally ephemeral: they perform no plan writes, no saved issues, no incremental review metadata, no plan-status/assignment/notification updates, and require no `plan_pr` link. Plan-owned options (`--save-issues`, `--issues`, `--task-index`, `--task-title`, `--create-cleanup-plan`, `--cleanup-*`, `--incremental`, `--since-last-review`) are rejected before any workspace or process allocation with a message that the option requires a plan-backed review target.

**`tim description`**: Uses `gatherPlanContext()` for DB-first plan resolution and hierarchy loading. Derives `gitRoot` from the returned `PlanContext` rather than re-computing from CWD, ensuring correct behavior under `--config` for cross-repo scenarios.

**`tim finish`**: Resolves the plan from DB via `resolvePlanByNumericId()`. Determines what finalization work is needed based on `docsUpdatedAt`/`lessonsAppliedAt` fields and config. If executor work is needed (docs or lessons), sets up workspace and headless adapter, runs the applicable steps, and sets the respective timestamp fields on success. If no executor work is needed, skips workspace/headless setup entirely. Always sets plan status to `done` at the end. DB-only plans are materialized lazily inside the headless callback (after workspace setup) to avoid stale files.

**`tim update-docs` / `tim update-lessons`**: Both commands accept `configPath` in their options and use `resolveRepoRoot()` with it to derive the correct repo root. The resolved `repoRoot` is used as the executor's `baseDir`, ensuring cross-repo invocations (via `--config`) run the LLM against the correct working tree. The exported helper functions (`runUpdateDocs()`, `runUpdateLessons()`) also accept `configPath` in their options so direct callers (e.g., review autofix) can thread `--config` through correctly.

**`tim validate`**: Loads all plans from DB via `loadPlansFromDb()` with a file overlay for YAML-specific validation (schema compliance, formatting). DB-only plans are schema-validated and participate in all fix passes. File-based validation concerns previously handled by the command (missing UUIDs, missing parent references) are now enforced by the DB schema and sync layer. Circular dependency detection remains as a graph-level check. When `--fix` auto-fixers operate on plans with backing files, they use `readPlanFile()`/`writePlanFile()`. For DB-only plans, fixers route through `writePlanToDb()` directly — no synthetic task files are created. The `references` YAML-only field is skipped for DB-only plans since it is not persisted in the DB. Fix functions in `references.ts` (`detectMissingUuids`, `detectReferenceIssues`, `fixReferenceMismatches`) handle DB-only plans: parent/dependency ID mismatches are fixed, but `references` map updates are skipped. DB-only validate fixes preserve existing DB `filename` metadata. The `--dir` flag validates plans within a specific repository context.

**`tim renumber`**: DB-first — loads plans from DB, wraps multi-plan ID changes in a single DB transaction with snapshot-based rollback. After renumbering, stale materialized files at `.tim/plans/{oldId}.plan.md` are cleaned up and re-materialized with new IDs. Legacy backing files (if they exist) are also renamed using `getLegacyAwareSearchDir()` for path resolution. DB filenames use `path.relative(searchDir, ...)` to preserve subdirectory information. The ID→UUID map used for DB writes includes ALL project plans (not just the changed set) to ensure `toPlanUpsertInput()` can resolve parent/dependency UUID references.

**Plan discovery** (`src/tim/plans/plan_discovery.ts`): DB-backed plan discovery functions. `findNextReadyDependencyFromDb()` finds the next ready dependency for a plan. `findLatestPlanFromDb()` finds the most recently updated plan. `findNextPlanFromDb()` finds the next plan after a given plan ID. All use `loadPlansFromDb()` and DB queries. Shared in-memory collection helpers `findNextPlanFromCollection()` and `findNextReadyDependencyFromCollection()` are exported for callers that already have loaded plans (e.g., `show.ts`), avoiding redundant DB queries. All discovery functions use a unified priority scale: `{ urgent: 5, high: 4, medium: 3, low: 2, maybe: 1 }`. BFS traversal includes both dependency and child plan edges. `getDirectDependencies()` in `dependency_traversal.ts` provides the shared dependency edge lookup used by plan discovery.

**Repo root resolution** (`src/tim/plan_repo_root.ts`): `resolveRepoRoot(configPath?, fallbackDir?)` derives the correct repository root. When `configPath` is provided, the repo root is derived from the config file's directory. Falls back to `getGitRoot()` or `fallbackDir` or `process.cwd()` when neither is provided.

**Legacy field stripping**: Legacy YAML-only fields (`rmfilter`, `generatedBy`, `promptsGeneratedAt`, `compactedAt`, `statusDescription`, `references`, `project`, `not_tim`) are stripped by `cleanPlanForYaml()` when writing materialized plan files. The `project`, `not_tim`, and `LegacyPlanPassthroughFields` type have been removed from the plan schema entirely. A `LegacyPlanFileMetadata` interface is preserved for backward compatibility when reading old plan files via `readPlanFile()`. The remaining legacy fields are not in the DB schema and are not preserved during plan writes.

### Adding a UUID-Backed Plan Reference Column

Plan schema fields that reference another plan by UUID (e.g. `parent_uuid`, `discovered_from`, `base_plan_uuid`) require updates at **every** point that touches the canonical plan shape or the sync projection. Missing one surface produces dangling references or stale projections that the round-trip happy-path tests will not catch. Checklist:

1. `PlanSchema` in `src/tim/planSchema.ts` (add the numeric `<field>` and keep it optional).
2. Public JSON schema (`schema/tim-plan-schema.json`).
3. DB schema + migration: new `<field>_uuid TEXT` column on both `plan` and `plan_canonical`. Match the `*_uuid` naming convention used by `parent_uuid`.
4. `PlanRow`, `UpsertPlanInput`, `UpsertCanonicalPlanInput`, `planWriteValues()` in `src/tim/db/plan.ts`. **Verify the placeholder count in the `INSERT INTO plan` statement matches the column list** — column/placeholder mismatches in `db/plan.ts` only surface under new fixtures and reviewers will not always catch them. Test against real DB inserts, not just upserts.
5. `planRowToSchemaInput` in `src/tim/plans_db.ts` — invert `<field>_uuid` back to the numeric ID via the `uuidToPlanId` map.
6. `setSyncedPlanScalar` helper + write_router operation key in `src/tim/sync/write_router.ts`.
7. `validateAdapterPlanOperation` in `src/tim/sync/operation_fold.ts` (`plan.set_scalar` branch).
8. `readCanonicalPlanState` — null-out on tombstone.
9. `getInboundProjectionOwnerPlanUuids` — include the new field so projection rebuild fan-out picks up changes to plans that _reference_ a mutated plan.
10. `import_helpers.planToPendingRow` — derive the new `<field>_uuid` from `idToUuid`.
11. `EditablePlanField` list in `src/tim/plan_materialize.ts` and the `diffPlanFields()` comparison set, so file edits round-trip through shadow-diff. Missing this silently drops edits made in the materialized YAML.
12. `getReferencedPlanIds` and `fixReferenceMismatches` in `src/tim/references.ts` — required for `tim renumber` and validate auto-fix to handle the reference.

For _soft_ references (changes to the referenced plan should take effect immediately, like `basePlan`), **do not** persist resolved values back into a sibling field (e.g. don't copy the resolved branch into `baseBranch`). Resolve fresh at every consumer; otherwise the reference quietly becomes a stale hard-coded value. This is the inverse of how `parent` works, where the parent's child-list is mutated as a cascade.

### GitHub App Authentication

GitHub App authentication state is stored in SQLite (migration v42). The private key contents are not stored; only the configured key path is persisted. Installation access tokens are short-lived and cached per installation with their expiry.

**Tables**:

- `github_app_config`: Single-row app configuration (`app_id`, `private_key_path`).
- `github_app_installation`: Installation rows keyed by `(app_id, installation_id)`, with optional `account_login`, cached `token`, and `token_expires_at`. `account_login` is used to map GitHub repository owners/orgs to the right installation.
- `github_app_project_installation`: Project-to-installation mapping keyed by `project_id`. This is populated from the current repository owner or by scanning known projects after listing installations.

**Auth boundary**:

- Personal-token GitHub flows use `resolveGitHubToken()` only (`GITHUB_TOKEN`, then `gh auth token`). They never read app installation tokens.
- App-authenticated flows use `src/common/github/app_auth.ts` and pass installation tokens directly to Octokit. They never fall back to `GITHUB_TOKEN` or `gh auth token`.
- `tim github-app status`, `token`, `refresh`, and `tim pr review-guide-comment` auto-detect the current repository owner, discover installations if needed, and use the matching installation token.

### PR Status Cache

PR status data from GitHub is cached in SQLite for display in the web UI and CLI. The schema (migration v8) separates the PR data from plan linkage so the same PR can be linked to multiple plans.

**Tables**:

- `pr_status`: Core PR record keyed by `pr_url` (UNIQUE). Stores state (open/closed/merged), draft flag, mergeable status, review decision, head/base branches, SHA, diff statistics (`additions`, `deletions`, `changed_files` — nullable INTEGER, added in migration v19), and `last_fetched_at` for cache freshness.
- `pr_check_run`: Individual CI check runs per PR (name, status, conclusion, details URL). `source` column distinguishes `check_run` vs `status_context` (GitHub's two check APIs). UNIQUE constraint on `(pr_status_id, name, source)` so both check sources can coexist with the same display name (migration v15).
- `pr_review`: Individual reviews per PR (author, state, submitted_at). UNIQUE constraint on `(pr_status_id, author)` for upsert support (migration v13).
- `pr_review_thread`: Review comment threads per PR (thread_id, path, line, original_line, start_line, original_start_line, diff_side, start_diff_side, is_resolved, is_outdated, subject_type). UNIQUE constraint on `(pr_status_id, thread_id)`. CASCADE delete from `pr_status`.
- `pr_review_thread_comment`: Individual comments within review threads (comment_id, database_id, author, body, diff_hunk, state, created_at). UNIQUE constraint on `(review_thread_id, comment_id)`. CASCADE delete from `pr_review_thread`.
- `pr_label`: Labels per PR (name, color).
- `plan_pr`: Junction table linking `plan.uuid` to `pr_status.id` with a `source` column (`'explicit'` or `'auto'`). Composite PK on `(plan_uuid, pr_status_id, source)` allows both explicit (user-specified) and auto (webhook branch-matched) links to coexist for the same plan/PR pair. Both sides have CASCADE deletes.

**CRUD module** (`src/tim/db/pr_status.ts`):

- `upsertPrStatus(db, data)`: INSERT ON CONFLICT(pr_url) DO UPDATE, replaces child rows (check runs, reviews, labels, and optionally review threads) in the same transaction. Used by full API refreshes. Review threads use undefined-preserves/[]-clears semantics: when `reviewThreads` is `undefined` in the input, existing cached threads are preserved; when `[]`, they are cleared. This prevents lightweight refresh paths (webhook handlers, check updates) from erasing valid cached thread data.
- `upsertPrStatusMetadata(db, data)`: Metadata-only upsert that updates PR fields and labels without destroying existing checks/reviews. Uses `pr_updated_at` monotonic guard (SQL WHERE clause rejects older timestamps) to prevent out-of-order webhook events from rolling back metadata. Uses `COALESCE` for `mergeable`/`review_decision`/`check_rollup_state`/`additions`/`deletions`/`changed_files` to prevent race conditions with concurrent targeted API calls and to preserve existing diff stats when webhook payloads omit them. Returns `{ detail, changed }` so callers can gate side-effects (e.g., check clearing on `synchronize`) on whether the update actually applied. Full API refreshes preserve `pr_updated_at` via COALESCE to maintain webhook out-of-order protection.
- `replaceReviewThreads(db, prStatusId, threads)`: DELETE all existing threads for the PR (CASCADE handles comments), INSERT each thread and its nested comments. Two-level insert: thread → get auto-generated ID → insert comments. Called from `upsertPrStatus()` only when `reviewThreads !== undefined`.
- `getPrStatusByUrl(db, prUrl, options?)`: Returns `PrStatusDetail` (status + checks + reviews + labels + optionally review threads). Accepts `includeReviewThreads` option (default false).
- `getPrStatusForPlan(db, planUuid, prUrls?, options?)`: All PR statuses linked to a plan. When `prUrls` are provided, queries `pr_status` directly by canonicalized URL and also includes auto-linked PRs from `plan_pr` (source `'auto'`), returning the union. Falls back to `plan_pr` join only when `prUrls` is not provided. Uses `tryCanonicalizePrUrl()` to safely skip malformed URLs without crashing. Accepts `includeReviewThreads` option.
- `getPrStatusesForRepo(db, owner, repo, options?)`: All open `pr_status` rows matching owner/repo, with joined checks/reviews/labels as `PrStatusDetail[]`. Used by the project-wide PR view. Accepts `includeReviewThreads` option.
- `getLinkedPlansByPrUrl(db, prUrls)`: Returns `Map<string, { planUuid, planId, title }[]>` — for each PR URL, the plans linked via `plan_pr` junction. Used to enrich the project PR list with linked plan info.
- `linkPlanToPr(db, planUuid, prStatusId, source?)` / `unlinkPlanFromPr`: Manage plan-PR junction. `linkPlanToPr` accepts optional `source` param (`'explicit'` default, `'auto'` for webhook branch matches). `unlinkPlanFromPr` only removes `source = 'explicit'` rows; auto-linked rows persist independently.
- `getPlansWithPrs(db, projectId?)`: Plans with linked PRs in active statuses (pending, in_progress, needs_review, reviewed). Canonicalizes plan `pull_request` URLs in TypeScript before matching against `pr_status.pr_url`. Filters stale `plan_pr` junction rows against the current plan's `pull_request` contents — if a plan's `pull_request` field is NULL or empty, any existing `plan_pr` junctions for that plan are excluded from results rather than treated as authoritative.
- `cleanOrphanedPrStatus(db)`: Removes orphaned `pr_status` records — those not referenced by any plan's `pull_request` URLs or `plan_pr` links — but only when their `state != 'open'` (closed or merged). Open orphans are retained, so the `pr_review`/`pr_review_request` rows that CASCADE from them survive too. This keeps the DB a durable source of webhook-ingested PR data (including PRs others opened purely for review) for up to ~24h, which a downstream daily digest depends on; the short-lived review-request notifier tolerated aggressive cleanup because it fires within ~30s of ingest. Closed/merged orphans are still deleted (cascading away their review data), and plan-linked rows are never treated as orphans regardless of state. Canonicalizes plan URLs in TypeScript before comparison.

**Granular upsert helpers** (added in migration v13 for webhook-based incremental updates):

- `getPrStatusByRepoAndNumber(db, owner, repo, prNumber)`: Look up a PR by repo + number (used by webhook event handlers to find existing PR records).
- `upsertPrCheckRunByName(db, prStatusId, input)`: INSERT OR REPLACE by `(pr_status_id, name, source)` — updates individual check runs without replacing all runs for the PR. Monotonic: completed checks can't be reverted by pending events; older completed events can't overwrite newer ones (compared by `completed_at`). Re-triggered checks (`started_at > completed_at`) can overwrite completed state.
- `upsertPrReviewByAuthor(db, prStatusId, input)`: INSERT OR REPLACE by `(pr_status_id, author)` — updates individual reviews, keeping latest per author. Monotonic: older reviews can't overwrite newer ones (compared by `submitted_at`). Returns boolean indicating whether the update applied.
- `recomputeCheckRollupState(db, prStatusId)`: Queries all `pr_check_run` rows for a PR and computes rollup state. Logic: any `failure`/`error`/`timed_out`/`startup_failure` → `'failure'`; any `pending`/`in_progress`/`queued`/`waiting`/`requested` → `'pending'`; all `success` → `'success'`; `neutral`/`skipped`/`cancelled` are non-blocking; empty → `null`. Completed checks with unrecognized conclusions are treated as pending (safe default).
- `getKnownRepoFullNames(db)`: Queries all projects and parses `repository_id` using `parseOwnerRepoFromRepositoryId()` to return `Set<string>` of `owner/repo` names. Used to filter webhook events to known repos.

**GraphQL enum normalization** (`src/common/github/pr_status.ts`): All normalizers (`normalizePrState`, `normalizeCheckStatus`, `normalizeCheckConclusion`, `normalizeReviewDecision`, `normalizeReviewState`, `normalizeMergeableState`, etc.) gracefully degrade with `console.warn` + sensible fallback for unknown values instead of throwing. GraphQL response types are widened to `string` so TypeScript recognizes default branches as reachable. This prevents the entire status fetch from failing if GitHub adds a new enum value. **Casing convention**: check-related normalizers (`normalizePrState`, `normalizeCheckStatus`, `normalizeCheckConclusion`, `normalizeCheckRollupState`) return lowercase values; review/merge-related normalizers (`normalizeReviewDecision`, `normalizeReviewState`, `normalizeMergeableState`) return UPPERCASE values to match GitHub's GraphQL schema conventions for those fields.

**Cache service** (`src/common/github/pr_status_service.ts`):

- `refreshPrStatus(db, prUrl)`: Canonicalizes the URL, fetches full status and review threads via GraphQL (in parallel), upserts to DB. Review thread fetch is best-effort — failure preserves cached thread data.
- `refreshPrCheckStatus(db, prUrl)`: Lightweight checks-only refresh. Validates the identifier via `canonicalizePrUrl()` before any cache lookup or API call.
- `ensurePrStatusFresh(db, prUrl, maxAgeMs)`: Stale-while-revalidate — returns cached if fresh, refreshes otherwise
- `syncPlanPrLinks(db, planUuid, prUrls)`: Atomic sync of plan-PR junction for `source = 'explicit'` rows only. Auto-linked rows are independently managed by webhook event handlers. All GitHub fetches complete before any DB writes; all upserts + link changes happen in one transaction. Orphan cleanup is the caller's responsibility.

**URL canonicalization** (`src/common/github/identifiers.ts`):

- `canonicalizePrUrl(identifier)`: Normalizes any PR URL to `https://github.com/{owner}/{repo}/pull/{number}` — handles `/pulls/` → `/pull/`, strips query params/fragments, rejects issue URLs and non-numeric PR numbers. Throws on invalid input. Used at all write/persistence entry points.
- `tryCanonicalizePrUrl(identifier)`: Non-throwing variant that returns `null` for invalid URLs. Used in read paths (e.g., `getPrStatusForPlan`, `getPrSummaryStatusByPlanUuid`) to avoid crashing page loads on malformed plan data.
- `validatePrIdentifier(identifier)`: Enforces GitHub host + `/pull/` path + numeric PR number for URL-form identifiers. Rejects issue URLs and other non-PR GitHub URLs.
- `deduplicatePrUrls(urls, options?)`: Canonicalizes and deduplicates a list of PR URLs. Optionally warns on invalid entries via `onInvalid` callback. Used by CLI commands and API endpoints to normalize input before processing.

### Standalone Reviews (PR and Plan)

Standalone reviews are stored in SQLite (migration v23, generalized in v37). A review row is keyed to either a PR (`pr_url` set) or a plan (`plan_uuid` set) — the v37 CHECK enforces that at least one is non-NULL. Multiple reviews per subject are supported for review history. The review guide is stored as TEXT directly on the `review` row. Results from multiple executors (Claude, Codex) are combined and individual issues are stored with source attribution. Review-guide annotations are stored as local-only `review_issue` rows with severity `note`.

Generation paths:

- `tim pr review-guide <prUrlOrNumber>` — PR-linked review (sets `pr_url`/`branch`/`pr_status_id`).
- `tim review-guide generate <planId>` — plan-only review (sets `plan_uuid`, leaves `pr_url`/`branch` NULL).
- `tim review-guide list-issues <planId|branch|prUrl>` — resolves a plan, PR, or branch to the latest stored guide and lists actionable issues. Plan resolution includes linked PR review rows; PR resolution includes linked plan review rows.
- `tim review-guide resolve-issue <issueId> [planId|branch|prUrl]` — marks an actionable issue resolved, optionally validating it belongs to the latest guide for the target.

**Tables**:

- `review`: Linked to a project and either a `pr_status` row or a `plan` row. Columns: `id`, `project_id` (FK CASCADE), `pr_status_id` (FK SET NULL, NULL for plan-only), `pr_url` (canonicalized, **NULLABLE** after v37), `branch` (**NULLABLE** after v37), `base_branch`, `reviewed_sha`, `plan_uuid` (FK to `plan(uuid)` ON DELETE SET NULL, added in v37), `review_guide` (TEXT), `status` (pending/in_progress/complete/error), `error_message`, `created_at`, `updated_at`. CHECK constraint: `pr_url IS NOT NULL OR plan_uuid IS NOT NULL`. No unique constraint on `(project_id, pr_url)` — use `ORDER BY created_at DESC, id DESC LIMIT 1` for latest. Indexes on `project_id`, `pr_url`, and `plan_uuid`.
- `review_issue`: Individual issues per review. Columns: `id`, `review_id` (FK CASCADE), `severity` (critical/major/minor/info/note), `category` (security/performance/bug/style/compliance/testing/other), `content`, `file`, `line`, `start_line`, `suggestion`, `source` (claude-code/codex-cli/combined), `resolved` (INTEGER default 0), `created_at`, `updated_at`. `note` rows come from review-guide annotations, are non-actionable/local-only, are not submitted to GitHub, and can be deleted locally. Index on `review_id`.

**Plan-delete trigger** (added in v37): A `BEFORE DELETE ON plan` trigger runs `DELETE FROM review WHERE plan_uuid = OLD.uuid AND pr_url IS NULL` so plan-only reviews are removed when their plan is deleted. PR-linked reviews that also reference the plan get `plan_uuid` set to NULL via the FK's `ON DELETE SET NULL` (BEFORE-DELETE triggers run before cascading FK actions in SQLite).

**CRUD module** (`src/tim/db/review.ts`):

- `createReview(db, input)`: Always inserts a new review record (never upserts). Canonicalizes `prUrl` on insert. Accepts either `prUrl`/`branch` (PR review) or `planUuid` (plan-only review). Empty-string `prUrl` is rejected before canonicalization.
- `updateReview(db, id, updates)`: Conditional field-building pattern (like workspace.ts) for nullable fields — supports explicit null clearing. Fields: `status`, `reviewedSha`, `reviewGuide`, `errorMessage`.
- `getLatestReviewByPrUrl(db, prUrl)`: Canonicalizes URL, returns most recent PR review.
- `getLatestReviewByPlanUuid(db, planUuid, options?)` / `getReviewsByPlanUuid(db, planUuid)` / `getLatestReviewGuideByPlanUuid(db, planUuid, options?)`: Plan-keyed equivalents of the PR lookups.
- `getReviewById(db, id)`: Look up by ID.
- `insertReviewIssues(db, reviewId, issues)`: Bulk insert in a single transaction.
- `getReviewIssues(db, reviewId)`: All issues for a review.
- `updateReviewIssue(db, id, updates)`: Update a single issue (e.g., mark resolved).
- `getReviewsForProject(db, projectId, options?)`: List reviews for a project. With `latestPerPr: true`, dedupes both PR rows by `pr_url` and plan-only rows (those with `pr_url IS NULL`) by `plan_uuid`.

### Webhook Log

Webhook events from the GitHub webhook ingestion server are stored locally for processing and audit. The schema (migration v13) provides cursor-based tracking for incremental event consumption.

**Tables**:

- `webhook_log`: Local copy of ingested webhook events. Columns: `id` (auto-increment), `delivery_id` (TEXT NOT NULL UNIQUE), `event_type`, `action`, `repository_full_name`, `payload_json`, `received_at` (from webhook server), `ingested_at` (local timestamp). Index on `(repository_full_name, id)`. Events for unknown repos are stored but not applied to PR status.
- `webhook_cursor`: Single-row table tracking ingestion position. Columns: `id` (CHECK id=1), `last_event_id` (INTEGER NOT NULL DEFAULT 0), `updated_at`. Initialized with default row `(1, 0, <now>)` in migration.

**CRUD module** (`src/tim/db/webhook_log.ts`):

- `insertWebhookLogEntry(db, entry)`: INSERT OR IGNORE by `delivery_id` — skips duplicates. Returns `{ inserted: boolean }`.
- `getWebhookCursor(db)`: Returns `last_event_id` from the single cursor row.
- `updateWebhookCursor(db, lastEventId)`: Updates the cursor row with a new event ID and timestamp.
- `pruneOldWebhookLogs(db, maxAgeDays?)`: Deletes entries where `ingested_at` is older than `maxAgeDays` (default 7).

**Webhook client** (`src/common/github/webhook_client.ts`): Fetches events from the webhook server's `/internal/events` endpoint. Uses `TIM_WEBHOOK_SERVER_URL` and `WEBHOOK_INTERNAL_API_TOKEN` env vars. Connection errors return empty array with warning; HTTP errors are thrown. Defines a local `WebhookEvent` interface (decoupled from `src/webhooks/`).

**Event handlers** (`src/common/github/webhook_event_handlers.ts`): Three handlers that parse webhook payloads and apply incremental updates to PR status tables:

- `handlePullRequestEvent(db, payload, knownRepos)`: Filters by known repos, upserts `pr_status` metadata and labels (via `upsertPrStatusMetadata()`) including diff statistics (`additions`, `deletions`, `changedFiles`), updates `requested_reviewers`, detects merged state (`closed` + `merged_at`), auto-links to plans by branch name (inside the main transaction boundary for atomicity), and uses `constructGitHubRepositoryId()` for consistent repository ID construction. Detects draft↔ready transitions by comparing the previously cached `draft` flag to the incoming payload and reports them via `prDraftTransition` (`'became_ready'` | `'became_draft'` | `null`) so the ingest loop can drive linked-plan status changes (see the orchestrator's plan-status side effects below). Returns deferred `Promise` for targeted `mergeable`/`review_decision` API fetch.
- `handlePullRequestReviewEvent(db, payload, knownRepos)`: Looks up existing `pr_status` by repo+number, upserts review by author. Returns deferred `Promise` for targeted `review_decision` API fetch only for states that affect `review_decision` (APPROVED, CHANGES_REQUESTED, DISMISSED — COMMENTED reviews skip the API call). Skips if PR not in DB.
- `handleCheckRunEvent(db, payload, knownRepos)`: For each PR in `check_run.pull_requests[]`, looks up `pr_status`, upserts check run by name and recomputes `check_rollup_state` within a single transaction (preventing stale rollup from concurrent events). Skips unknown PRs.

All handlers return `HandlerResult` with `prUrls` (affected), `updated` flag, and `deferredApiCalls` (promises for async API fetches).

**Targeted API fetch** (`src/common/github/pr_status_service.ts`): `fetchAndUpdatePrMergeableStatus(db, prUrl, owner, repo, prNumber)` calls `fetchPrMergeableAndReviewDecision()` (lightweight GraphQL query for just `mergeable` and `reviewDecision`) and updates the `pr_status` row. Used by webhook event handlers to backfill fields not available in webhook payloads.

**Ingestion orchestrator** (`src/common/github/webhook_ingest.ts`): `ingestWebhookEvents(db)` is the main entry point for webhook-based PR status updates. Flow: read cursor → fetch events from webhook server → insert into `webhook_log` (dedup by `delivery_id`) → dispatch to event handlers by `eventType` → collect and run deferred API calls via `Promise.allSettled` → advance cursor → prune old log entries. Returns `IngestResult` with `eventsIngested` (newly processed only), `prsUpdated`, `prsReadyForReview`, and `errors` (including missing `WEBHOOK_INTERNAL_API_TOKEN`, per-event parse/handler failures, and deferred API call failures with `owner/repo#number` context for debugging). Returns early with empty result if `TIM_WEBHOOK_SERVER_URL` is not set. All callers (web remote commands, CLI) inspect `IngestResult.errors` and surface non-empty errors as warnings via `formatWebhookIngestErrors()` shared helper.

Webhook ingestion can replay older events after the web server has been stopped for a while. Set `githubWebhooks.ignoreSideEffectsBefore` in the machine-local global config to an ISO timestamp to catch up cache state without outbound spam. Events before that timestamp still update local PR status, but webhook-derived Slack review-request notifications are marked as already notified and automatic review-guide comments are not spawned.

Beyond updating `pr_status`, the dispatch loop applies plan-status side effects to plans linked via `plan_pr`. These side effects are enabled by default and can be disabled in the machine-local global config with `githubWebhooks.planStatusUpdates: false`:

- `autoCompleteMergedLinkedPlans(...)`: when a PR is merged, linked plans currently in `needs_review` or `reviewed` (with all tasks done) are promoted to `done`, the assignment is removed, and `checkAndMarkParentDone` cascades to the parent.
- `applyDraftReadyStatusToLinkedPlans(...)`: when a PR's draft flag transitions (computed by comparing the incoming payload's `draft` to the previously cached `pr_status.draft`), linked plans move between `needs_review` and `reviewed`. `ready_for_review` (became ready) promotes plans in `needs_review → reviewed`; `converted_to_draft` (became draft) reverts plans in `reviewed → needs_review`. Each direction guards on the expected source status so the webhook never clobbers `in_progress`, `done`, or manual states.

**Refresh paths**: All PR refresh entry points use a webhook-first approach when `TIM_WEBHOOK_SERVER_URL` is set:

- **Web — project PRs** (`src/lib/remote/project_prs.remote.ts`): `refreshProjectPrs` calls `ingestWebhookEvents(db)` then returns cached data without running `refreshProjectPrsService()` (which handles marking stale PRs as closed). This means PRs that never received a webhook close event won't be detected as stale — the "Full Refresh from GitHub API" button addresses this. `fullRefreshProjectPrs` always calls `refreshProjectPrsService()` (direct GitHub API) as an escape hatch.
- **Web — plan PR status** (`src/lib/remote/pr_status.remote.ts`): `refreshPrStatus` calls `ingestWebhookEvents(db)` first, then pre-filters explicit PR URLs to only those already cached in the DB before calling `syncPlanPrLinks` — this prevents webhook mode from triggering GitHub API fetches for uncached URLs. PRs not yet seen via webhooks are reported as warnings. Falls back to direct GitHub API refresh when webhooks are not configured. When a plan has no PR URLs, always syncs junction links to prune stale rows (even in webhook mode). `fullRefreshPrStatus` bypasses webhooks entirely and uses `refreshPrStatus()` (unconditional API call) rather than `ensurePrStatusFresh()`, ensuring a true full refresh from GitHub regardless of `last_fetched_at` — the plan-level equivalent of `fullRefreshProjectPrs`.
- **CLI — `tim pr status`** (`src/tim/commands/pr.ts`): Calls `ingestWebhookEvents(db)` before displaying PR data when configured. In webhook mode, calls `syncPlanPrLinks` with only already-cached explicit URLs (never triggers GitHub API fetch) to keep the junction table consistent with the plan file. `--force-refresh` flag bypasses webhooks and fetches directly from GitHub API. When `TIM_WEBHOOK_SERVER_URL` is not set, preserves existing direct-API behavior.

### Project Settings

Per-project key-value settings stored in the database (migration v16). Used by the web UI for project-level configuration that doesn't belong in YAML config files.

**Table**:

- `project_setting`: Composite PK `(project_id, setting)`. Columns: `project_id` (INTEGER NOT NULL, FK to `project(id)` ON DELETE CASCADE), `setting` (TEXT NOT NULL), `value` (TEXT NOT NULL, JSON-encoded).

**CRUD module** (`src/tim/db/project_settings.ts`):

- `getProjectSetting(db, projectId, setting)`: Returns parsed JSON value or `null` if not set.
- `getProjectSettings(db, projectId)`: Returns `Record<string, unknown>` of all settings for a project.
- `setProjectSetting(db, projectId, setting, value)`: INSERT OR REPLACE with `JSON.stringify(value)`.
- `deleteProjectSetting(db, projectId, setting)`: Returns boolean indicating whether the setting existed.

Per-repo Slack settings are stored here under the `slack` setting key (JSON `{ enabled, workspace, channel }`), written by the `tim slack` CLI. Review-request messages also require the target global Slack workspace to opt in with `reviewNotifier.enabled: true`. See [`slack-integration.md`](slack-integration.md).

### Slack User Mappings

Workspace-scoped GitHub-to-Slack user mappings for review-request notifications (migration v39). Keyed by Slack workspace name + GitHub login because Slack user IDs are workspace-scoped, so a mapping is shared by every repo targeting that workspace. The `workspace` is a config-defined string (from `slack.workspaces` in machine-local config), so there is **no** `project_id` FK. See [`slack-integration.md`](slack-integration.md) for the surrounding feature.

**Table**:

- `slack_user_map`: Composite PK `(workspace, github_login)`. Columns: `workspace` (TEXT NOT NULL), `github_login` (TEXT NOT NULL), `slack_user_id` (TEXT NOT NULL), `slack_display` (TEXT, nullable), `created_at`/`updated_at` (TEXT NOT NULL, defaulted with `SQL_NOW_ISO_UTC`). Created with `IF NOT EXISTS`.

**Migration v39 also adds** `pr_review_request.notified_at` (TEXT, nullable, no `CHECK`) via a guarded `afterUp` `ALTER TABLE ADD COLUMN` (no table rebuild). The Slack notifier sets it transactionally after a confirmed Slack send so the pending query is restart-safe.

**Migration v40 adds** `pr_review_request.request_version` (INTEGER NOT NULL DEFAULT 0) via the same guarded `afterUp` pattern. `upsertPrReviewRequestByReviewer` increments it on every applied lifecycle change to a row (request, removal, re-request) and resets `notified_at` to NULL whenever a row is (re-)requested by a newer event. The notifier reads `request_version` alongside each pending row and `markReviewRequestsNotified` only sets `notified_at` where the version still matches, so a remove + re-request that lands during an in-flight Slack send does not mark the new request as already notified. See [`slack-integration.md`](slack-integration.md).

**CRUD module** (`src/tim/db/slack_user_map.ts`):

- `upsertUserMapping(db, { workspace, githubLogin, slackUserId, slackDisplay? })`: INSERT ON CONFLICT(workspace, github_login) DO UPDATE. Uses `slack_display = COALESCE(excluded.slack_display, slack_display)` so re-mapping without a display preserves an existing one; `created_at` stays stable while `updated_at` is refreshed.
- `deleteUserMapping(db, workspace, githubLogin)`: Returns boolean indicating whether a row was removed.
- `getUserMapping(db, workspace, githubLogin)`: Returns the row or `undefined`.
- `listUserMappings(db, workspace?)`: All mappings, optionally filtered to one workspace, ordered by `(workspace, github_login)`.

All mutations are synchronous and wrapped in `db.transaction().immediate()`.

### Slack Daily Digest Messages

Daily digest Slack message coordinates are stored in SQLite (migration v45) so same-day digest refreshes can update the existing per-repo Slack post with `chat.update`.

**Table**:

- `slack_daily_digest_message`: Composite PK `(workspace, channel, repo_full_name, digest_date)`. Columns: `workspace` (configured Slack workspace name), `channel` (configured project Slack channel), `repo_full_name` (`owner/repo`), `digest_date` (workspace-local `YYYY-MM-DD` digest date), `slack_channel` (Slack API channel ID), `slack_ts` (Slack message timestamp), `created_at`/`updated_at` (TEXT NOT NULL, defaulted with `SQL_NOW_ISO_UTC`). Indexed by `(workspace, digest_date)`.

**CRUD module** (`src/tim/db/slack_daily_digest_message.ts`):

- `getSlackDailyDigestMessage(db, workspace, channel, repoFullName, digestDate)`: Returns the stored Slack coordinates or `undefined`.
- `upsertSlackDailyDigestMessage(db, input)`: Inserts or updates Slack coordinates while preserving `created_at`.

### Web Query Helpers

`src/lib/server/db_queries.ts` provides enriched read-only queries for the SvelteKit web interface, layered on top of the CRUD functions in `src/tim/db/plan.ts`:

- **`getProjectsWithMetadata(db)`**: Lists projects with plan counts by status using a single aggregate SQL query (avoids N+1). Includes `featured` boolean from `project_setting` (defaults to `true`). Includes all projects regardless of plan count
- **`getPlansForProject(db, projectId?)`**: Returns enriched plan objects with tasks, tags, dependency UUIDs, computed display status, task completion counts, `pullRequests`/`issues` (parsed from JSON string columns), and `prSummaryStatus` (`'passing' | 'failing' | 'pending' | 'none'`). The `prSummaryStatus` is computed by canonicalizing each plan's `pull_request` URLs and matching them directly against `pr_status.pr_url` — not via `plan_pr` junctions — so cached status is shown even before junction links are populated. Neutral/cancelled/skipped check states map to `'passing'`; plans with PRs but no check data at all get `'none'`. When `projectId` is omitted, queries all projects with unfiltered SQL.
- **`getPlanDetail(db, planUuid)`**: Single plan with full dependency details (titles, statuses, resolved flag), parent info, assignment data, and `prStatuses: PrStatusDetail[]` (full PR data with nested check runs, reviews, labels). PR statuses are loaded by canonicalizing the plan's `pull_request` URLs and querying `pr_status` directly, falling back to `plan_pr` join only when URLs aren't available. Uses targeted single-plan queries (not full project bundle) and loads transitive dependency plans for accurate display status computation. Assignment is fetched via `getAssignmentEntry` (single lookup) with status overridden from the live plan row to avoid stale assignment data.

**Display status computation**: A derived status layered on top of raw plan status:

- `blocked`: Plan is pending/in_progress but has dependencies not all done. Missing/unknown dependency UUIDs are treated as blocking (unresolved) to match tim's CLI readiness semantics.
- `recently_done`: Plan is done and `updated_at` is within 7 days
- Otherwise: raw status unchanged

The enrichment pipeline (`enrichPlansWithContext`) builds internal lookup maps (`planByUuid`, `dependenciesByPlanUuid`) and exposes them so callers like `getPlanDetail` can reuse them for dependency resolution without duplicate work. It also backfills missing cross-project dependency plans from the DB so that project-scoped queries can still resolve dependencies on plans in other projects.

### Job / Activity Log

The `job` table records every non-tunneled session that starts an embedded server — the "Activity" tab in the web UI reads from it. CRUD lives in `src/tim/db/job.ts`:

- **`recordJobStart(db, input)`**: Inserts a `running` row and returns its id. Called from `src/tim/headless.ts` for standalone activity commands that create a session (`runWithHeadlessAdapterIfEnabled` and `createHeadlessAdapterForCommand`). It intentionally skips `agent-multi`, `review`, `chat`, `run-prompt`, `shell`, `review-guide-comment`, and any command run with `TIM_NO_SERVER=1` (no discoverable session). Job recording is best-effort and never throws into the command path.
- **`markJobFinished(db, jobId, status)`**: Stamps `finished_at` and sets the terminal status. `runWithHeadlessAdapterIfEnabled` records `completed`/`failed` based on the callback outcome; the manual `createHeadlessAdapterForCommand` path marks `completed` via the adapter's `onDestroy` hook (no success/failure signal available there).
- **`listRecentJobs(db, { projectId, limit })`**: Returns recent jobs most-recent-first, left-joining `plan` and `pr_status` to backfill `plan_id`/`plan_title`/`pr_number`. The activity route (`src/routes/projects/[projectId]/activity/+page.server.ts`) resolves each job's primary output link (latest review guide, plan artifacts page, PR, or plan) at display time.

### Testing

- Use `openDatabase(':memory:')` for isolated test databases
- Call `db.close(false)` in `afterEach` to clean up — the `false` parameter skips throwing on pending transactions
- The singleton `closeDatabaseForTesting()` is for tests that exercise code calling `getDatabase()`
- Tests using module mocking that touch DB-dependent code paths need `closeDatabaseForTesting()` and `XDG_CONFIG_HOME` isolation even when the test itself doesn't directly use the DB — transitive calls (e.g., `loadSharedPermissions` via an executor) can initialize the singleton and leak state to subsequent test files
