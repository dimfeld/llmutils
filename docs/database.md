### bun:sqlite Transaction Patterns

- All DB functions are **synchronous** (matching bun:sqlite's native API)
- `db.transaction()` returns an object with `.immediate()`, `.deferred()`, `.exclusive()` methods — it does NOT return a function directly
- Use `.immediate()` for all write transactions consistently: `db.transaction().immediate(() => { ... })`
- Inner `db.transaction().immediate()` calls within an existing transaction automatically use savepoints — no special handling needed for nesting
- Single-statement DELETEs (and other single-statement writes) don't need transaction wrappers since individual SQL statements are already atomic in SQLite

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
- When calling `getOrCreateProject()` followed by `updateProject()`, compare existing field values against the new values before updating. Skipping the update when all fields match avoids unnecessary `updated_at` timestamp bumps that make projects appear modified when they weren't.
- When adding a provenance/source column to a junction table, include it in the primary key so both sources can coexist for the same entity pair. `INSERT OR IGNORE` with a single-column key won't allow inserting a second row with a different source — the first source wins silently.
- Multi-step DB mutations (e.g., upsert + clear child rows + update related rows) should be wrapped in a single transaction for atomicity, even if each individual statement seems independent. This prevents partial state from being visible to concurrent readers or from persisting if a later step fails.

### Plan SQLite Sync

Plan metadata, tasks, and dependencies are mirrored in SQLite alongside the YAML plan files. This enables centralized querying across workspaces without reading individual files from disk.

**Tables** (migration v2, extended through v23):

- `plan`: Core metadata (uuid PRIMARY KEY, project_id FK, plan_id, title, goal, details, status, priority, parent_uuid, epic, filename, timestamps). Additional columns added in later migrations: `assigned_to`, `simple`, `tdd`, `discovered_from`, `base_branch`, `base_commit` (TEXT), `base_change_id` (TEXT), `issue` (JSON), `pull_request` (JSON), `branch`, `temp` (INTEGER), `docs` (JSON array), `changed_files` (JSON array), `plan_generated_at` (TEXT), `review_issues` (JSON array of objects), `docs_updated_at` (TEXT), `lessons_applied_at` (TEXT). No unique constraint on `(project_id, plan_id)` to tolerate temporary duplicate numeric IDs. `base_commit` and `base_change_id` are DB-managed fields for stacked PR base tracking — they are not imported from plan files during file→DB sync.
- `plan_task`: Tasks per plan (plan_uuid FK with CASCADE, task_index, title, description, done). UNIQUE on `(plan_uuid, task_index)`.
- `plan_dependency`: Dependencies by UUID (plan_uuid FK with CASCADE, depends_on_uuid, composite PK). No FK on `depends_on_uuid` since the referenced plan may not be synced yet.

**CRUD module** (`src/tim/db/plan.ts`):

- `upsertPlan(db, projectId, input)`: INSERT ON CONFLICT(uuid) DO UPDATE, replaces tasks and dependencies in the same transaction
- `getPlanByUuid`, `getPlansByProject`, `getPlanTasksByUuid`, `deletePlan`, `getPlansNotInSet`
- `getPlansNotInSet` uses a temporary table for the UUID exclusion set instead of a dynamic `NOT IN (?)` clause, avoiding SQLite's `SQLITE_MAX_VARIABLE_NUMBER` limit (default 999)
- All functions are synchronous, write operations use `db.transaction().immediate()`

**Sync module** (`src/tim/db/plan_sync.ts`):

- `syncPlanToDb(plan, filePath, options?)`: Upserts a single plan to DB. Uses lazy-cached project context (keyed by git root) resolved via `getRepositoryIdentity()` + `getOrCreateProject()`. Accepts optional `idToUuid` map for bulk operations. Options: `throwOnError` (propagate errors instead of logging warnings), `cwdForIdentity` (override CWD for repository identity resolution).
- `removePlanFromDb(planUuid, options?)`: Deletes plan and its assignment in a single transaction. Supports `throwOnError: true` to propagate DB deletion failures to the caller (used by `cleanup-temp` to keep the DB row intact when file deletion succeeds but DB deletion fails).
- `clearPlanSyncContext()`: Resets cached context for testing.
- DB sync failures are logged as warnings, never blocking plan file writes.
- Stale write protection: when a plan includes `updatedAt`, upserts are skipped if that timestamp is older than the existing row's `updated_at`. `tim sync --force` disables this guard. All file→DB sync paths (including `syncMaterializedPlan` and `resolvePlanFromDbOrSyncFile`) rely on this guard — `force: true` is reserved for explicit user-initiated sync operations, never used in generic resolution or workspace reuse paths. **Important**: any sync path that modifies data must refresh `updatedAt` to a current timestamp before calling `upsertPlan()`, otherwise the stale-write guard may cause subsequent syncs to silently skip updates.

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

- `diffPlanFields(shadow, current)`: Compares all user-editable fields between shadow and current file plans using `Bun.deepEquals()`. Returns `{ changedFields: Set<string>, hasChanges: boolean }`. Compared fields: title, goal, details, status, priority, parent, branch, simple, tdd, discoveredFrom, assignedTo, baseBranch, temp, epic, planGeneratedAt, dependencies, issue, pullRequest, docs, changedFiles, tags, tasks, reviewIssues. Excludes: id, uuid, createdAt, updatedAt, materializedAs, references.
- `mergePlanWithShadow(dbPlan, shadowPlan, filePlan)`: Starts from `dbPlan`, overlays only the fields that differ between `shadowPlan` and `filePlan`. This preserves DB-side changes (e.g., from web UI) to fields the user didn't edit in the file. When shadow is null, returns `filePlan` unchanged (full overwrite for backward compatibility).

**Path helpers**: `getMaterializedPlanPath(repoRoot, planId)`, `getShadowPlanPath(repoRoot, planId)`, `getShadowPlanPathForFile(planFilePath)`.

**CLI entry points**: `tim materialize <planId>` writes the working copy, `tim sync <planId>` syncs a single materialized file back to DB, `tim sync` (no args) scans `.tim/plans/` for all `*.plan.md` files and syncs them all (supports `--verbose` for progress output), and `tim cleanup-materialized` removes stale files.

**`skipDb` / `skipFile` options on `writePlanFile()`**: `skipDb` (aliased as `skipSync` for backward compatibility) prevents the DB write; used by materialization to avoid circular sync when writing a file that was just read from the DB. `skipFile` prevents the file write; used when only the DB needs updating. When `filePath` is null, file writing is automatically skipped.

**UUID safety**: `syncMaterializedPlan()` extracts the UUID from raw file YAML before calling `readPlanFile()`, because `readPlanFile()` auto-generates UUIDs for files missing them (which would corrupt a materialized file with a wrong UUID).

**`readPlanFile()` write side effect**: `readPlanFile()` is not a pure read operation. When a plan file is missing a UUID, it auto-generates one and persists it back to disk via `writePlanFile()`, which also triggers a DB insert. Callers that need read-only behavior (e.g., reading plan files for comparison or diffing) should use `readShadowPlanFile()` instead — it parses the same YAML+markdown format but has no side effects.

### DB-First Plan Resolution and Writing

The plan system uses DB-first access: the SQLite database is the source of truth for plan data, with files as optional materialized views.

**Plan resolution** (`src/tim/plans.ts`):

- `resolvePlanFromDb(planArg, repoRoot, options?)`: Resolves a plan from the DB by numeric ID or UUID string. Returns `{ plan: PlanSchema, planPath: string | null }` where `planPath` is the materialized file path (via `getMaterializedPlanPath()`) if one exists on disk, or `null` for DB-only plans. Throws `PlanNotFoundError` if the plan is not found in the DB — no file fallback. Options: `context` (pre-resolved `ProjectContext`), `resolveDir` (base directory for resolving relative file paths — defaults to `process.cwd()`).
- `PlanNotFoundError` (`src/tim/plans.ts`): Custom error class for plan-not-found conditions. Use `isPlanNotFoundError()` from `ensure_plan_in_db.ts` (which uses `instanceof`) to check errors — avoids false positives from broad string matching against unrelated "not found" messages.
- `resolvePlan()` in `plan_display.ts` delegates to `resolvePlanFromDb()`. Returns nullable `planPath` — callers must handle `null`.

**Plan writing** (`src/tim/plans.ts`):

- `writePlanToDb(input, options?)`: Validates, normalizes (fancy quotes, deprecated fields), and writes a plan to the DB in a single transaction (`upsertPlan` + `upsertPlanTasks` + `upsertPlanDependencies` + `upsertPlanTags`). Returns the validated `PlanSchema`. Accepts optional `ProjectContext` to avoid redundant queries.
- `writePlanFile(filePath, input, options?)`: DB-first write function. `filePath` can be `string | null` — when null, only the DB is written (file write is skipped). When `filePath` is null, either `cwdForIdentity` or `context` must be provided (throws otherwise) so the correct project can be resolved for the DB write. Options: `skipFile` (skip file write), `skipDb`/`skipSync` (skip DB write, used by materialization to avoid circular sync), `skipUpdatedAt`, `cwdForIdentity`, `context`.

**Project context** (`src/tim/plan_materialize.ts`):

- `resolveProjectContext(repoRoot, repository?)`: Returns `ProjectContext` with `projectId`, `rows`, `planIdToUuid`/`uuidToPlanId` maps, `duplicatePlanIds`, and `maxNumericId` (highest plan ID in DB). Caches results per repo root. Used by `resolvePlanFromDb()`, `writePlanToDb()`, and `generateNumericPlanId()`.

**ID generation** (`src/tim/id_utils.ts`):

- `generateNumericPlanId(tasksDir, options?)`: Uses `resolveProjectContext().maxNumericId` from the DB. The `tasksDir` parameter is a legacy artifact that will be removed in a future cleanup.

### Plan Loading from DB

`src/tim/plans_db.ts` provides `loadPlansFromDb(searchDir, repositoryId)` — a shared function that assembles `PlanWithFilename` objects from DB rows (plans, tasks, tags, dependencies) for a given project. Returns `PlansLoadResult` with `plans: Map<number, PlanWithFilename>` and `duplicates`. Uses `planRowToSchemaInput()` to convert DB rows to `PlanSchema` objects with full field coverage.

**`planRowToSchemaInput(row, tasks, deps, tags, uuidToPlanId?)`** converts a single plan's DB data to `PlanSchema`. Handles all fields including JSON-stored columns (`issue`, `pullRequest`, `docs`, `changedFiles`, `reviewIssues`). Resolves `parent_uuid` and dependency UUIDs back to numeric plan IDs — if a `uuidToPlanId` map is provided it uses that, otherwise it queries the DB for needed UUIDs. This shared converter is used by both `loadPlansFromDb()` (bulk loading) and `resolvePlanFromDb()` (single-plan resolution).

**`planRowForTransaction(row, uuidToPlanId)`** is a convenience wrapper that fetches tasks, dependencies, and tags from the DB for a given plan row, then delegates to `planRowToSchemaInput()`. Used by commands that need to resolve a plan within a DB transaction (e.g., `add`, `set`, `create_plan`). **`invertPlanIdToUuidMap(planIdToUuid)`** converts a `Map<number, string>` (planId→UUID) to the `Map<string, number>` (UUID→planId) format expected by `planRowToSchemaInput`. Both are exported from `plans_db.ts` to avoid duplication across command modules.

Used by `tim list`, `tim ready`, `tim show` (for `--next-ready` dependency resolution), and the MCP `list-ready-plans` tool. All commands use DB-only access.

### Parent Cascade (DB-First)

Parent completion and status cascading is handled by `src/tim/plans/parent_cascade.ts`, a consolidated module replacing the previous two separate implementations in `mark_done.ts` and `commands/agent/parent_plans.ts`.

**Key functions**:

- `checkAndMarkParentDone(config, plan, options?)`: Queries `getPlansByParentUuid()` to find all children of the parent, checks their statuses from DB. If all children are work-complete (`done`, `needs_review`, `cancelled`, or `deferred`) and the parent isn't already cancelled or deferred, marks the parent using `getCompletionStatus(config)` (defaults to `needs_review`) via `writePlanFile()` with auto-materialization. Recursively checks grandparent.
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

- Writes new plan directly to DB via atomic transaction (`upsertPlan` + `upsertPlanTasks` + parent update in single `db.transaction().immediate()`)
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

**`tim set`**: Loads plan from DB via `resolvePlanFromDb()`, applies metadata changes in-memory, writes to DB via `writePlanToDb()`. Multi-plan updates (parent/child cascading, dependency changes) use DB transactions for atomicity. Re-materializes the plan file if one exists on disk. Uses `checkAndMarkParentDone()` from `parent_cascade.ts` for parent status cascading.

**`tim done` / `mark_done.ts`**: Loads plan from DB, marks tasks as done, updates `changedFiles` from Git, writes to DB via `writePlanToDb()`. When all tasks are complete, sets plan status to `getCompletionStatus(config)` (defaults to `needs_review`). Assignments and workspace locks are preserved for `needs_review` plans (only released on actual `done`). Re-materializes if a materialized file exists. Parent cascade (`checkAndMarkParentDone()`) runs after the child's status is written to DB.

**`tim set-task-done` / `tim add-task`**: Both use `resolvePlanFromDbOrSyncFile()` from `ensure_plan_in_db.ts` to resolve plans. This function syncs existing file paths to DB before resolving, ensuring file edits are captured during the transition period. Writes go through `writePlanFile()` (DB-first, then optional file materialization).

**`tim list` / `tim ready`**: DB-only via `loadPlansFromDb()`. All filtering, sorting, and display logic operates on DB-loaded plans. No `--local` file-scanning fallback. Filenames in JSON/structured output are checked with `fs.existsSync()` before inclusion — DB-only plans get empty filenames instead of bogus synthesized paths, matching the MCP `list_ready_plans` behavior.

**`tim show`**: Resolves plans from DB via `resolvePlanFromDb()`. When `--next-ready` is used, finds the next ready dependency using `loadPlansFromDb()` and DB-backed readiness checks, falling back to the parent plan when all dependencies are complete. Plan context display assembled from DB data; `planPath` may be null for DB-only plans.

**`tim generate` / `tim chat`**: Resolve plans from DB via `resolvePlanFromDbOrSyncFile()`. Both commands derive the repo root from the loaded config via `resolveRepoRootForPlanArg()`, which correctly handles `--config` for cross-repo plan resolution. The repo root is computed once and shared between plan resolution and workspace setup. Plans are materialized into the workspace at `.tim/plans/{planId}.plan.md` via `setupWorkspace()` (which accepts a `planId` option). The executor edits the materialized file during execution. After the executor finishes, `syncPlanToDb()` syncs the edited file back to DB. Post-execution sync targets the actual file the executor edited, including reused legacy backing files when present.

**`tim agent`**: Uses DB-backed plan discovery functions from `plan_discovery.ts` for all plan resolution modes (`--next-ready`, `--latest`, `--next`, `--current`, direct argument). `resolvePlanFromDbOrSyncFile()` resolves the plan, then materializes into the workspace via `setupWorkspace()`. `batch_mode.ts` and `stub_plan.ts` use `setPlanStatusById()` for DB-first completion status updates with `getCompletionStatus(config)` (defaults to `needs_review`). Completion side effects (assignment removal via `removePlanAssignment()`, parent cascade via `checkAndMarkParentDone()`) are deferred until after final review confirms the plan is still complete — if review reopens the plan by appending tasks, these side effects are skipped. When `planAutocompleteStatus: 'done'`, assignment removal runs; for `needs_review`, assignments and workspace locks are preserved. Batch mode resets status to `in_progress` when review appends tasks and the user declines to continue. When reusing a workspace branch, existing materialized files are synced back to DB before re-materializing to prevent data loss from unsynced edits. `ensure_plan_in_db.ts` promotes UUID-less file plans into DB state by generating UUIDs before syncing.

**`tim review`**: When no plan is specified, auto-detects the plan via `autoSelectPlanForReview()`: extracts plan ID from the current branch name using `/^(\d+)-/` pattern and resolves via `resolvePlanFromDb()`. If found, validates any existing materialized file's ID before reusing, and materializes fresh from DB to avoid stale file overwrites. When a plan is explicitly specified via `tim review <planId>`, uses `resolvePlanFromDbOrSyncFile()`. Write operations (`resolveReviewPlanForWrite()`) use `resolveRepoRootForPlanArg()` with `configPath` threading for correct cross-repo resolution. `gatherPlanContext()` in `context_gathering.ts` uses `resolvePlanFromDbOrSyncFile()` for plan resolution and `loadPlansFromDb()` for hierarchy (parent chain, completed children), returning `repoRoot` and `gitRoot` in `PlanContext` so callers don't re-derive them from CWD. For `--autofix` flows, `ensureReviewPlanFilePath()` materializes DB-only plans before invoking the executor, memoizing to avoid redundant materialization. After the autofix executor edits the materialized file, `syncPlanToDb(force: true)` syncs changes back to DB (force is intentional since the executor just wrote the latest state). Both explicit `tim review 123 --autofix` and branch-name auto-selected DB-only plans are covered.

**`tim description`**: Uses `gatherPlanContext()` for DB-first plan resolution and hierarchy loading. Derives `gitRoot` from the returned `PlanContext` rather than re-computing from CWD, ensuring correct behavior under `--config` for cross-repo scenarios.

**`tim finish`**: Resolves the plan from DB via `resolvePlanFromDb()`. Determines what finalization work is needed based on `docsUpdatedAt`/`lessonsAppliedAt` fields and config. If executor work is needed (docs or lessons), sets up workspace and headless adapter, runs the applicable steps, and sets the respective timestamp fields on success. If no executor work is needed, skips workspace/headless setup entirely. Always sets plan status to `done` at the end. DB-only plans are materialized lazily inside the headless callback (after workspace setup) to avoid stale files.

**`tim update-docs` / `tim update-lessons`**: Both commands accept `configPath` in their options and use `resolveRepoRootForPlanArg()` with it to derive the correct repo root. The resolved `repoRoot` is used as the executor's `baseDir`, ensuring cross-repo invocations (via `--config`) run the LLM against the correct working tree. The exported helper functions (`runUpdateDocs()`, `runUpdateLessons()`) also accept `configPath` in their options so direct callers (e.g., review autofix) can thread `--config` through correctly.

**`tim validate`**: Loads all plans from DB via `loadPlansFromDb()` with a file overlay for YAML-specific validation (schema compliance, formatting). DB-only plans are schema-validated and participate in all fix passes. File-based validation concerns previously handled by the command (missing UUIDs, missing parent references) are now enforced by the DB schema and sync layer. Circular dependency detection remains as a graph-level check. When `--fix` auto-fixers operate on plans with backing files, they use `readPlanFile()`/`writePlanFile()`. For DB-only plans, fixers route through `writePlanToDb()` directly — no synthetic task files are created. The `references` YAML-only field is skipped for DB-only plans since it is not persisted in the DB. Fix functions in `references.ts` (`detectMissingUuids`, `detectReferenceIssues`, `fixReferenceMismatches`) handle DB-only plans: parent/dependency ID mismatches are fixed, but `references` map updates are skipped. DB-only validate fixes preserve existing DB `filename` metadata. The `--dir` flag validates plans within a specific repository context.

**`tim renumber`**: DB-first — loads plans from DB, wraps multi-plan ID changes in a single DB transaction with snapshot-based rollback. After renumbering, stale materialized files at `.tim/plans/{oldId}.plan.md` are cleaned up and re-materialized with new IDs. Legacy backing files (if they exist) are also renamed using `getLegacyAwareSearchDir()` for path resolution. DB filenames use `path.relative(searchDir, ...)` to preserve subdirectory information. The ID→UUID map used for DB writes includes ALL project plans (not just the changed set) to ensure `toPlanUpsertInput()` can resolve parent/dependency UUID references.

**Plan discovery** (`src/tim/plans/plan_discovery.ts`): DB-backed plan discovery functions. `findNextReadyDependencyFromDb()` finds the next ready dependency for a plan. `findLatestPlanFromDb()` finds the most recently updated plan. `findNextPlanFromDb()` finds the next plan after a given plan ID. All use `loadPlansFromDb()` and DB queries. Shared in-memory collection helpers `findNextPlanFromCollection()` and `findNextReadyDependencyFromCollection()` are exported for callers that already have loaded plans (e.g., `show.ts`), avoiding redundant DB queries. All discovery functions use a unified priority scale: `{ urgent: 5, high: 4, medium: 3, low: 2, maybe: 1 }`. BFS traversal includes both dependency and child plan edges. `getDirectDependencies()` in `dependency_traversal.ts` provides the shared dependency edge lookup used by plan discovery.

**File-to-DB promotion** (`src/tim/ensure_plan_in_db.ts`): `resolvePlanFromDbOrSyncFile()` handles the transition from file-first to DB-first. When passed a file path, it syncs the file to DB (generating a UUID if missing) before resolving from DB — but without `force: true`, so the normal timestamp guard protects newer DB state from being overwritten by stale files. Files without `updatedAt` are treated as non-authoritative when the plan already exists in DB. Only `PlanNotFoundError` from DB resolution triggers the sync path (checked via `isPlanNotFoundError()` using `instanceof`); other errors are propagated. When passed a numeric ID or UUID, it resolves directly from DB. Callers are responsible for passing the correct `repoRoot` — typically obtained from `resolveRepoRootForPlanArg()` with `configPath` to honor `--config` for cross-repo scenarios. Accepts an optional `configBaseDir` parameter — when provided, relative file paths are resolved against it instead of `process.cwd()`, ensuring correct resolution under `--config` for cross-repo scenarios. Used by `generate`, `chat`, `agent`, `review`, `set-task-done`, and `add-task` commands.

**Repo root resolution** (`src/tim/plan_repo_root.ts`): `resolveRepoRootForPlanArg(planArg, repoRoot?, configPath?)` derives the correct repository root for a plan argument. Absolute plan paths take precedence over `configPath` — the repo root is derived from the file's actual location, preventing cross-repo DB corruption (e.g., syncing a plan from repo B into repo A's database). When only `configPath` is provided, the repo root is derived from the config file's directory. Falls back to `getGitRoot()` or `process.cwd()` when neither is provided.

**Legacy field stripping**: Legacy YAML-only fields (`rmfilter`, `generatedBy`, `promptsGeneratedAt`, `compactedAt`, `statusDescription`, `references`, `project`, `not_tim`) are stripped by `cleanPlanForYaml()` when writing materialized plan files. The `project`, `not_tim`, and `LegacyPlanPassthroughFields` type have been removed from the plan schema entirely. A `LegacyPlanFileMetadata` interface is preserved for backward compatibility when reading old plan files via `readPlanFile()`. The remaining legacy fields are not in the DB schema and are not preserved during plan writes.

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
- `getPlansWithPrs(db, projectId?)`: Plans with linked PRs in active statuses (pending, in_progress, needs_review). Canonicalizes plan `pull_request` URLs in TypeScript before matching against `pr_status.pr_url`. Filters stale `plan_pr` junction rows against the current plan's `pull_request` contents — if a plan's `pull_request` field is NULL or empty, any existing `plan_pr` junctions for that plan are excluded from results rather than treated as authoritative.
- `cleanOrphanedPrStatus(db)`: Removes `pr_status` records not referenced by any plan's `pull_request` URLs or `plan_pr` links. Canonicalizes plan URLs in TypeScript before comparison.

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

### Webhook Log

Webhook events from the GitHub webhook ingestion server are stored locally for processing and audit. The schema (migration v13) provides cursor-based tracking for incremental event consumption.

**Tables**:

- `webhook_log`: Local copy of ingested webhook events. Columns: `id` (auto-increment), `delivery_id` (TEXT NOT NULL UNIQUE), `event_type`, `action`, `repository_full_name`, `payload_json`, `received_at` (from webhook server), `ingested_at` (local timestamp). Index on `(repository_full_name, id)`. Events for unknown repos are stored but not applied to PR status.
- `webhook_cursor`: Single-row table tracking ingestion position. Columns: `id` (CHECK id=1), `last_event_id` (INTEGER NOT NULL DEFAULT 0), `updated_at`. Initialized with default row `(1, 0, <now>)` in migration.

**CRUD module** (`src/tim/db/webhook_log.ts`):

- `insertWebhookLogEntry(db, entry)`: INSERT OR IGNORE by `delivery_id` — skips duplicates. Returns `{ inserted: boolean }`.
- `getWebhookCursor(db)`: Returns `last_event_id` from the single cursor row.
- `updateWebhookCursor(db, lastEventId)`: Updates the cursor row with a new event ID and timestamp.
- `pruneOldWebhookLogs(db, maxAgeDays?)`: Deletes entries where `ingested_at` is older than `maxAgeDays` (default 30).

**Webhook client** (`src/common/github/webhook_client.ts`): Fetches events from the webhook server's `/internal/events` endpoint. Uses `TIM_WEBHOOK_SERVER_URL` and `WEBHOOK_INTERNAL_API_TOKEN` env vars. Connection errors return empty array with warning; HTTP errors are thrown. Defines a local `WebhookEvent` interface (decoupled from `src/webhooks/`).

**Event handlers** (`src/common/github/webhook_event_handlers.ts`): Three handlers that parse webhook payloads and apply incremental updates to PR status tables:

- `handlePullRequestEvent(db, payload, knownRepos)`: Filters by known repos, upserts `pr_status` metadata and labels (via `upsertPrStatusMetadata()`) including diff statistics (`additions`, `deletions`, `changedFiles`), updates `requested_reviewers`, detects merged state (`closed` + `merged_at`), auto-links to plans by branch name (inside the main transaction boundary for atomicity), and uses `constructGitHubRepositoryId()` for consistent repository ID construction. Returns deferred `Promise` for targeted `mergeable`/`review_decision` API fetch.
- `handlePullRequestReviewEvent(db, payload, knownRepos)`: Looks up existing `pr_status` by repo+number, upserts review by author. Returns deferred `Promise` for targeted `review_decision` API fetch only for states that affect `review_decision` (APPROVED, CHANGES_REQUESTED, DISMISSED — COMMENTED reviews skip the API call). Skips if PR not in DB.
- `handleCheckRunEvent(db, payload, knownRepos)`: For each PR in `check_run.pull_requests[]`, looks up `pr_status`, upserts check run by name and recomputes `check_rollup_state` within a single transaction (preventing stale rollup from concurrent events). Skips unknown PRs.

All handlers return `HandlerResult` with `prUrls` (affected), `updated` flag, and `deferredApiCalls` (promises for async API fetches).

**Targeted API fetch** (`src/common/github/pr_status_service.ts`): `fetchAndUpdatePrMergeableStatus(db, prUrl, owner, repo, prNumber)` calls `fetchPrMergeableAndReviewDecision()` (lightweight GraphQL query for just `mergeable` and `reviewDecision`) and updates the `pr_status` row. Used by webhook event handlers to backfill fields not available in webhook payloads.

**Ingestion orchestrator** (`src/common/github/webhook_ingest.ts`): `ingestWebhookEvents(db)` is the main entry point for webhook-based PR status updates. Flow: read cursor → fetch events from webhook server → insert into `webhook_log` (dedup by `delivery_id`) → dispatch to event handlers by `eventType` → collect and run deferred API calls via `Promise.allSettled` → advance cursor → prune old log entries. Returns `IngestResult` with `eventsIngested` (newly processed only), `prsUpdated`, and `errors` (including missing `WEBHOOK_INTERNAL_API_TOKEN`, per-event parse/handler failures, and deferred API call failures with `owner/repo#number` context for debugging). Returns early with empty result if `TIM_WEBHOOK_SERVER_URL` is not set. All callers (web remote commands, CLI) inspect `IngestResult.errors` and surface non-empty errors as warnings via `formatWebhookIngestErrors()` shared helper.

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

### Testing

- Use `openDatabase(':memory:')` for isolated test databases
- Call `db.close(false)` in `afterEach` to clean up — the `false` parameter skips throwing on pending transactions
- The singleton `closeDatabaseForTesting()` is for tests that exercise code calling `getDatabase()`
- Tests using module mocking that touch DB-dependent code paths need `closeDatabaseForTesting()` and `XDG_CONFIG_HOME` isolation even when the test itself doesn't directly use the DB — transitive calls (e.g., `loadSharedPermissions` via an executor) can initialize the singleton and leak state to subsequent test files
