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

### Plan SQLite Sync

Plan metadata, tasks, and dependencies are mirrored in SQLite alongside the YAML plan files. This enables centralized querying across workspaces without reading individual files from disk.

**Tables** (migration v2):

- `plan`: Core metadata (uuid PRIMARY KEY, project_id FK, plan_id, title, goal, details, status, priority, parent_uuid, epic, filename, timestamps). No unique constraint on `(project_id, plan_id)` to tolerate temporary duplicate numeric IDs.
- `plan_task`: Tasks per plan (plan_uuid FK with CASCADE, task_index, title, description, done). UNIQUE on `(plan_uuid, task_index)`.
- `plan_dependency`: Dependencies by UUID (plan_uuid FK with CASCADE, depends_on_uuid, composite PK). No FK on `depends_on_uuid` since the referenced plan may not be synced yet.

**CRUD module** (`src/tim/db/plan.ts`):

- `upsertPlan(db, projectId, input)`: INSERT ON CONFLICT(uuid) DO UPDATE, replaces tasks and dependencies in the same transaction
- `getPlanByUuid`, `getPlansByProject`, `getPlanTasksByUuid`, `deletePlan`, `getPlansNotInSet`
- `getPlansNotInSet` uses a temporary table for the UUID exclusion set instead of a dynamic `NOT IN (?)` clause, avoiding SQLite's `SQLITE_MAX_VARIABLE_NUMBER` limit (default 999)
- All functions are synchronous, write operations use `db.transaction().immediate()`

**Sync module** (`src/tim/db/plan_sync.ts`):

- `syncPlanToDb(plan, filePath, options?)`: Upserts a single plan to DB. Uses lazy-cached project context (keyed by git root) resolved via `getRepositoryIdentity()` + `getOrCreateProject()`. Accepts optional `idToUuid` map for bulk operations.
- `removePlanFromDb(planUuid)`: Deletes plan and its assignment in a single transaction.
- `syncAllPlansToDb(projectId, tasksDir, options?)`: Bulk sync with optional prune (removes DB plans not found on disk, including their assignments).
- `clearPlanSyncContext()`: Resets cached context for testing.
- DB sync failures are logged as warnings, never blocking plan file writes.
- Stale write protection: when a plan includes `updatedAt`, upserts are skipped if that timestamp is older than the existing row's `updated_at`. `tim sync --force` disables this guard.
- Single-plan sync hydration: `tim sync --plan <id>` also checks the named plan's `references` UUIDs and syncs any referenced plans that are missing in SQLite.

**Context caching**: The sync module caches project context per git root to avoid repeated `getRepositoryIdentity()` calls. Concurrent context resolution for the same git root is deduplicated via a shared promise.

**Repository identity**: `getRepositoryIdentity()` is always called from `process.cwd()` (the caller's git context), never from the plan file or tasks directory. This prevents mis-associating plans to the wrong project when `paths.tasks` points outside the repository.

**Fallback UUID resolution**: When resolving parent/dependency UUIDs from numeric IDs, the sync module first checks `plan.references`, then falls back to `readAllPlans()`. The fallback uses `options.tasksDir ?? context.tasksDir` (the resolved sync context's tasks directory), ensuring cross-subdirectory lookups work correctly (e.g., a child plan in `tasks/a/` can resolve a parent in `tasks/b/`).

**Parse error tracking**: `readAllPlans()` returns an `erroredFiles` array tracking files that failed to parse (excluding files with no frontmatter). `syncAllPlansToDb` always counts these failures in `errors` so partial syncs are never reported as fully successful. Parse warnings are emitted only when verbose mode is enabled (e.g., `tim sync --verbose`).

**Prune safety**: `syncAllPlansToDb` with `prune: true` checks `erroredFiles` before deleting anything. If any plan file failed to parse, prune is skipped entirely to prevent deleting DB rows for plans that still exist on disk but couldn't be read. The prune UUID set is built from `allPlans.uuidToId.keys()` to handle duplicate numeric IDs correctly.

**Prune atomicity**: Each prune deletion wraps `deletePlan` + `removeAssignment` in a single `db.transaction().immediate()` to prevent inconsistent state if one operation fails.

**Deletion ordering**: Plan deletion commands (`tim remove`, `tim cleanup-temp`) use file-then-DB order: delete the plan file first, then remove the DB row. Orphan DB rows (file deleted but DB row remains) are safely cleaned up by `tim sync --prune`, while orphan files (DB deleted but file remains) would reappear on next sync. `removePlanFromDb` handles both plan and assignment deletion in a single transaction, so callers do not need to call `removePlanAssignment` separately.

**Error handling layers**: `syncPlanToDb` has a single try/catch that logs warnings and never rethrows. Callers (e.g., `writePlanFile`) trust this and do not add redundant outer error handling.

### PR Status Cache

PR status data from GitHub is cached in SQLite for display in the web UI and CLI. The schema (migration v8) separates the PR data from plan linkage so the same PR can be linked to multiple plans.

**Tables**:

- `pr_status`: Core PR record keyed by `pr_url` (UNIQUE). Stores state (open/closed/merged), draft flag, mergeable status, review decision, head/base branches, SHA, and `last_fetched_at` for cache freshness.
- `pr_check_run`: Individual CI check runs per PR (name, status, conclusion, details URL). `source` column distinguishes `check_run` vs `status_context` (GitHub's two check APIs).
- `pr_review`: Individual reviews per PR (author, state, submitted_at).
- `pr_label`: Labels per PR (name, color).
- `plan_pr`: Junction table linking `plan.uuid` to `pr_status.id`. Both sides have CASCADE deletes.

**CRUD module** (`src/tim/db/pr_status.ts`):

- `upsertPrStatus(db, data)`: INSERT ON CONFLICT(pr_url) DO UPDATE, replaces child rows (check runs, reviews, labels) in the same transaction
- `getPrStatusByUrl(db, prUrl)`: Returns `PrStatusDetail` (status + checks + reviews + labels)
- `getPrStatusForPlan(db, planUuid)`: All PR statuses linked to a plan via `plan_pr` join
- `linkPlanToPr(db, planUuid, prStatusId)` / `unlinkPlanFromPr`: Manage plan-PR junction
- `getPlansWithPrs(db, projectId?)`: Plans with linked PRs in active statuses (pending, in_progress, needs_review)
- `cleanOrphanedPrStatus(db)`: Removes `pr_status` records with no `plan_pr` links

**Cache service** (`src/common/github/pr_status_service.ts`):

- `refreshPrStatus(db, prUrl)`: Fetches full status via GraphQL, upserts to DB
- `refreshPrCheckStatus(db, prUrl)`: Lightweight checks-only refresh
- `ensurePrStatusFresh(db, prUrl, maxAgeMs)`: Stale-while-revalidate — returns cached if fresh, refreshes otherwise
- `syncPlanPrLinks(db, planUuid, prUrls)`: Atomic sync of plan-PR junction. All GitHub fetches complete before any DB writes; all upserts + link changes happen in one transaction. Orphan cleanup is the caller's responsibility.

### Web Query Helpers

`src/lib/server/db_queries.ts` provides enriched read-only queries for the SvelteKit web interface, layered on top of the CRUD functions in `src/tim/db/plan.ts`:

- **`getProjectsWithMetadata(db)`**: Lists projects with plan counts by status using a single aggregate SQL query (avoids N+1)
- **`getPlansForProject(db, projectId?)`**: Returns enriched plan objects with tasks, tags, dependency UUIDs, computed display status, task completion counts, `pullRequests`/`issues` (parsed from JSON string columns), and `prSummaryStatus` (`'passing' | 'failing' | 'pending' | 'none'`). The `prSummaryStatus` is computed via an efficient bulk join on `plan_pr → pr_status` (single query for all plans, not N+1). When `projectId` is omitted, queries all projects with unfiltered SQL.
- **`getPlanDetail(db, planUuid)`**: Single plan with full dependency details (titles, statuses, resolved flag), parent info, assignment data, and `prStatuses: PrStatusDetail[]` (full PR data with nested check runs, reviews, labels joined via `plan_pr`). Uses targeted single-plan queries (not full project bundle) and loads transitive dependency plans for accurate display status computation. Assignment is fetched via `getAssignmentEntry` (single lookup) with status overridden from the live plan row to avoid stale assignment data.

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
