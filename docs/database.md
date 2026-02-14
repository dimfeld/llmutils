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

### Testing

- Use `openDatabase(':memory:')` for isolated test databases
- Call `db.close(false)` in `afterEach` to clean up — the `false` parameter skips throwing on pending transactions
- The singleton `closeDatabaseForTesting()` is for tests that exercise code calling `getDatabase()`
- Tests using module mocking that touch DB-dependent code paths need `closeDatabaseForTesting()` and `XDG_CONFIG_HOME` isolation even when the test itself doesn't directly use the DB — transitive calls (e.g., `loadSharedPermissions` via an executor) can initialize the singleton and leak state to subsequent test files
