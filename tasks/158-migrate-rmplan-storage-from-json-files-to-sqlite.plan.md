---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Migrate tim storage in .config/tim from JSON files to SQLite database
goal: Replace JSON file storage in ~/.config/tim (assignments, permissions,
  workspaces, repository metadata, workspace locks) with a single SQLite
  database at ~/.config/tim/tim.db, using bun:sqlite with WAL mode and
  synchronous API
id: 158
uuid: e17331a4-1827-49ea-88e6-82de91f993df
generatedBy: agent
status: in_progress
priority: medium
epic: true
dependencies:
  - 191
  - 192
references:
  "191": b4980a23-e869-4ff5-9108-29b0efdd7fb0
  "192": f8d20819-0761-48b4-8d59-f9dcb1ab9eae
planGeneratedAt: 2026-02-13T23:07:50.121Z
promptsGeneratedAt: 2026-02-13T23:07:50.121Z
createdAt: 2026-01-02T17:08:05.033Z
updatedAt: 2026-02-13T23:10:21.669Z
tasks:
  - title: "Create child plan 191: SQLite database layer with CRUD operations,
      migration, and JSON import"
    done: false
    description: "Plan 191 covers the database foundation: schema, migrations, CRUD
      operations for all entity types, JSON import logic, and comprehensive
      tests."
  - title: "Create child plan 192: Migrate tim callers from JSON I/O to SQLite
      database"
    done: false
    description: Plan 192 covers migrating all existing callers from JSON file I/O
      to the SQLite database, updating tests, and removing deprecated code.
      Depends on plan 191.
tags: []
---

## Overview

Migrate all tim functionality that tracks state via JSON files in `.config/tim` to use an SQLite database instead. The data model should be relational (normalized), replacing the current denormalized JSON structure.

## Current JSON Storage

Files being replaced:
- `~/.config/tim/shared/{repositoryId}/assignments.json` - Plan claims/assignments
- `~/.config/tim/shared/{repositoryId}/permissions.json` - Claude Code approval permissions
- `~/.config/tim/workspaces.json` - Global workspace tracking
- `~/.config/tim/repositories/{repoName}/metadata.json` - External storage metadata

## Database Schema

### Tables

**project**
- id (PK, auto-increment)
- repository_id (unique) - stable identifier string
- remote_url (nullable)
- last_git_root
- external_config_path
- external_tasks_dir
- remote_label
- highest_plan_id - atomic counter for plan ID generation
- created_at
- updated_at

**workspace**
- id (PK, auto-increment)
- project_id (FK to project, required)
- task_id
- workspace_path (unique)
- original_plan_file_path
- branch
- name
- description
- plan_id
- plan_title
- created_at
- updated_at

**workspace_issue**
- id (PK)
- workspace_id (FK to workspace)
- issue_url

**workspace_lock**
- workspace_id (FK to workspace, unique)
- lock_type ('persistent' | 'pid')
- pid
- started_at
- hostname
- command

**permission**
- id (PK)
- project_id (FK to project)
- permission_type ('allow' | 'deny')
- pattern

**assignment**
- id (PK)
- project_id (FK to project)
- plan_uuid (unique per project)
- plan_id
- workspace_id (FK to workspace, nullable) - local claim
- claimed_by_user - who claimed (supports remote sync scenarios)
- status
- assigned_at
- updated_at

### Indices

- project(repository_id) - unique
- workspace(workspace_path) - unique
- workspace(project_id)
- assignment(project_id, plan_uuid) - unique
- assignment(workspace_id)
- permission(project_id)

## SQLite Configuration (bun:sqlite)

```typescript
db.exec("PRAGMA journal_mode = WAL");      // Write-ahead logging
db.exec("PRAGMA foreign_keys = ON");       // Enforce FK constraints
db.exec("PRAGMA busy_timeout = 5000");     // 5s timeout for locks
db.exec("PRAGMA synchronous = NORMAL");    // Good perf with WAL
```

For write transactions, use `BEGIN IMMEDIATE` to acquire write lock upfront and avoid deadlocks.

## Design Decisions

| Decision | Choice |
|----------|--------|
| Concurrency control | Transactions (BEGIN IMMEDIATE), no version columns |
| Migration strategy | Single initial schema, import existing JSON on first run |
| Stale lock cleanup | On read (24-hour threshold for pid locks, matching current workspace lock behavior) |
| Workspace without project | Always require project; create one if needed |
| Historical tracking | Current state only |
| Multiple workspaces per assignment | No - one workspace per assignment |
| User tracking | `claimed_by_user` on assignment (supports remote sync) |
| Released assignments | Delete the record |

We must make sure that any migration SQL is readable by the built script in dist as well, whether that's by copying the
SQL as part of the build script or some other way.

## Database Location

Store the SQLite database at `~/.config/tim/tim.db` (or platform equivalent).

## Research

### Overview

This migration replaces four JSON file storage systems (assignments, permissions, workspaces, repository metadata) and a workspace lock file system with a single SQLite database. The current system uses file-based locking with optimistic version control, atomic temp-file-then-rename writes, and per-repository directory structures under `~/.config/tim/`. SQLite eliminates the complex locking infrastructure while providing better concurrency, querying, and atomicity guarantees.

### Current Storage Architecture

#### 1. Assignments (`assignments_io.ts`)
- **Path**: `~/.config/tim/shared/{repositoryId}/assignments.json`
- **Schema**: `AssignmentsFile` with `repositoryId`, `repositoryRemoteUrl`, `version` (optimistic locking), `assignments` (Record<uuid, AssignmentEntry>), `highestPlanId`
- **AssignmentEntry**: `planId`, `workspacePaths[]`, `workspaceOwners` (Record<path, username>), `users[]`, `status`, `assignedAt`, `updatedAt`
- **Locking**: File-based `.lock` files with 25ms retry, 2s timeout, 5-min stale threshold
- **Concurrency**: Optimistic version checking on write
- **Key functions**: `readAssignments()`, `writeAssignments()`, `removeAssignment()`, `reserveNextPlanId()`
- **Callers**: `claim_plan.ts`, `release_plan.ts`, `auto_claim.ts`, commands (`assignments.ts`, `ready.ts`, `renumber.ts`), `id_utils.ts`

**Important observation**: The current assignment model is denormalized with arrays of `workspacePaths` and `users` per assignment UUID. The new schema simplifies this to one workspace per assignment with a single `claimed_by_user`. This is a semantic change that needs careful handling during migration.

#### 2. Permissions (`permissions_io.ts`)
- **Path**: `~/.config/tim/shared/{repositoryId}/permissions.json`
- **Schema**: `SharedPermissionsFile` with `repositoryId`, `version`, `permissions.allow[]`, `permissions.deny[]`, `updatedAt`
- **Locking**: Identical to assignments (duplicated lock code)
- **Key functions**: `readSharedPermissions()`, `writeSharedPermissions()`, `addSharedPermission()`
- **Callers**: `claude_code.ts` executor (loads permissions for auto-approval), subagent system

#### 3. Workspaces (`workspace_tracker.ts`)
- **Path**: `~/.config/tim/workspaces.json` (global file, not per-repository)
- **Schema**: `Record<workspacePath, WorkspaceInfo>` with `taskId`, `originalPlanFilePath`, `repositoryId`, `workspacePath`, `branch`, `createdAt`, `lockedBy`, `name`, `description`, `planId`, `planTitle`, `issueUrls[]`, `updatedAt`
- **Locking**: NONE (last-writer-wins)
- **Key functions**: `readTrackingData()`, `writeTrackingData()`, `recordWorkspace()`, `getWorkspaceMetadata()`, `findWorkspacesByTaskId()`, `findWorkspacesByRepositoryId()`, `patchWorkspaceMetadata()`
- **Callers**: `workspace_manager.ts`, `workspace_auto_selector.ts`, commands (`workspace.ts`, `agent.ts`)

#### 4. Workspace Locks (`workspace_lock.ts`)
- **Path**: `~/.config/tim/locks/{hash-of-workspace-path}.lock`
- **Schema**: `LockInfo` with `type` ('persistent' | 'pid'), `pid`, `command`, `startedAt`, `hostname`, `version`
- **Class**: `WorkspaceLock` with static methods
- **Stale threshold**: 24 hours for pid locks, persistent locks never stale
- **Key functions**: `acquireLock()`, `releaseLock()`, `getLockInfo()`, `isLocked()`, `isLockStale()`
- **Test hooks**: `setTestPid()`, `setTestLockDirectory()` for isolation

#### 5. Repository Metadata (`external_storage_utils.ts`)
- **Path**: `~/.config/tim/repositories/{repositoryName}/metadata.json`
- **Schema**: `RepositoryStorageMetadata` with `repositoryName`, `remoteLabel`, `createdAt`, `updatedAt`, `lastGitRoot`, `externalConfigPath`, `externalTasksDir`
- **Locking**: NONE
- **Key functions**: `readRepositoryStorageMetadata()`, `writeRepositoryStorageMetadata()`
- **Callers**: `storage_manager.ts`, `repository_config_resolver.ts`

### Config Root Resolution

All storage modules use `getConfigRoot()` (duplicated in `assignments_io.ts` and `permissions_io.ts`):
- Windows: `%APPDATA%/tim` or `~/AppData/Roaming/tim`
- Unix with XDG: `$XDG_CONFIG_HOME/tim`
- Default: `~/.config/tim`

This should be consolidated into a single shared function in the database module.

### Build System

- Build uses `Bun.build()` in `build.ts` with minification, targeting `bun` runtime
- Entrypoints: `src/tim/tim.ts` → `dist/tim.js`, `src/tim/executors/claude_code/permissions_mcp.ts` → `dist/claude_code/permissions_mcp.ts`
- Externals: `effect`, `@valibot/to-json-schema`, `sury`
- `bun:sqlite` is a built-in Bun module - no external dependency needed
- WASM files are copied to dist (tree-sitter parsers)
- The plan notes that migration SQL must be readable from the built dist. Since `bun:sqlite` is built-in and SQL can be defined as string constants in TypeScript, this is straightforward - the SQL is embedded in the source code and bundled by the builder.

### Test Isolation Patterns

Tests use three isolation techniques:
1. **Temp directories**: `fs.mkdtemp()` with unique prefixes, cleanup in `afterEach`
2. **Environment override**: `XDG_CONFIG_HOME` set to temp dir, `APPDATA` deleted
3. **Module mocking**: `ModuleMocker` mocks `os.homedir()` to redirect config path resolution

For SQLite migration, tests should use separate in-memory or temp-file databases. The database module should accept a path parameter, defaulting to the production path but overridable for tests. This is simpler and more reliable than the current env var + module mock approach.

### Key Architectural Observations

1. **Duplicated code**: `getConfigRoot()`, `acquireFileLock()`, `ensureTrailingNewline()` are duplicated between `assignments_io.ts` and `permissions_io.ts`. The migration eliminates all of this.

2. **Denormalized → Normalized**: The current assignments model stores `workspacePaths[]` and `users[]` arrays per UUID. The new schema normalizes this to individual assignment rows. The plan specifies "one workspace per assignment" which simplifies the data model significantly.

3. **Version fields eliminated**: SQLite transactions replace optimistic locking, so the `version` fields on assignments and permissions files are no longer needed.

4. **Lock simplification**: Workspace locks currently use separate hash-named files. Moving to a `workspace_lock` table simplifies this significantly. The stale lock cleanup logic (checking PID liveness) remains the same, just reads from DB instead of files.

5. **`highestPlanId` moves to project table**: Currently stored in the assignments file, this becomes a column on the `project` table.

6. **External storage metadata persists as files**: The `repositories/{name}/metadata.json` stores paths to config and tasks directories. These need to migrate to the `project` table as `external_config_path` and `external_tasks_dir` columns.

### Interface Design Strategy

The migration should introduce a database access layer (`src/tim/db/`) that:
1. Provides a single `getDatabase()` function returning a configured `Database` instance
2. Handles schema creation and future migrations
3. Exports repository-specific functions (e.g., `db.getProject(repositoryId)`, `db.upsertAssignment(...)`)
4. Is injectable for tests (accept db instance as parameter or use test-specific database path)

Callers (commands, executors, MCP tools) should be updated to use the new DB functions instead of the JSON I/O functions. The old JSON I/O modules can be removed once all callers are migrated.

### Files to Create
- `src/tim/db/database.ts` - Database initialization, connection management, schema
- `src/tim/db/database.test.ts` - Tests for database layer
- `src/tim/db/migrations.ts` - Schema migration logic
- `src/tim/db/project.ts` - Project CRUD operations
- `src/tim/db/workspace.ts` - Workspace CRUD operations
- `src/tim/db/assignment.ts` - Assignment CRUD operations
- `src/tim/db/permission.ts` - Permission CRUD operations
- `src/tim/db/workspace_lock.ts` - Workspace lock operations
- `src/tim/db/json_import.ts` - One-time import from existing JSON files
- `src/tim/db/json_import.test.ts` - Tests for JSON import

### Files to Modify (callers that switch from JSON to DB)
- `src/tim/assignments/claim_plan.ts` - Use DB instead of readAssignments/writeAssignments
- `src/tim/assignments/release_plan.ts` - Use DB instead of readAssignments/writeAssignments
- `src/tim/assignments/auto_claim.ts` - Use DB claim function
- `src/tim/commands/assignments.ts` - Read from DB
- `src/tim/commands/ready.ts` - Read assignments from DB
- `src/tim/commands/renumber.ts` - reserveNextPlanId from DB
- `src/tim/id_utils.ts` - reserveNextPlanId from DB
- `src/tim/executors/claude_code.ts` - Read permissions from DB
- `src/tim/workspace/workspace_tracker.ts` - Replace all functions with DB operations
- `src/tim/workspace/workspace_lock.ts` - Replace file-based locks with DB operations
- `src/tim/workspace/workspace_manager.ts` - Use DB for workspace recording
- `src/tim/workspace/workspace_auto_selector.ts` - Use DB for workspace lookup
- `src/tim/commands/workspace.ts` - Use DB for workspace operations
- `src/tim/commands/agent/agent.ts` - Use DB for workspace operations
- `src/tim/commands/done.ts` - Use DB for lock release
- `src/tim/external_storage_utils.ts` - Use DB for repository metadata
- `src/tim/storage/storage_manager.ts` - Use DB for external storage metadata
- `src/tim/repository_config_resolver.ts` - Use DB for repository metadata

### Files to Eventually Remove (after migration)
- `src/tim/assignments/assignments_io.ts` (replaced by DB)
- `src/tim/assignments/assignments_schema.ts` (schema moves to DB layer)
- `src/tim/assignments/permissions_io.ts` (replaced by DB)
- `src/tim/assignments/permissions_schema.ts` (schema moves to DB layer)

### Potential Challenges

1. **Test isolation**: Tests currently mock `os.homedir()` and `XDG_CONFIG_HOME`. With SQLite, each test needs its own database. The simplest approach is having the database module accept a path parameter, and tests pass a temp file path.

2. **Workspace lock PID checking**: The current `WorkspaceLock.isLockStale()` checks if the PID is still alive via `process.kill(pid, 0)`. This logic must be preserved in the DB-backed implementation.

3. **Concurrent access**: Multiple tim processes may access the database simultaneously (e.g., multiple agents in different workspaces). SQLite WAL mode + `BEGIN IMMEDIATE` handles this well, but the busy timeout (5s) needs to be sufficient.

4. **JSON import on first run**: When the database doesn't exist, it should be created with the schema and then import any existing JSON data. This needs to handle partial data gracefully (some JSON files may exist, others may not).

5. **Migration SQL in built dist**: Since `bun:sqlite` is built-in and SQL strings are embedded in TypeScript source, they're automatically included in the bundled output. No special build step needed.

6. **Semantic change in assignments**: Current model allows multiple workspace paths per assignment UUID. New model is one workspace per assignment. The import logic needs to handle this - either create multiple assignment rows (one per workspace path) or pick the most recent.

## Design Decisions from Refinement

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Assignment import (multi-workspace) | Single row, most recent workspace | Simplifies import; multi-workspace tracking rarely used |
| Plan structure | Two child plans | DB layer + CRUD + import (plan A), Caller migration + cleanup (plan B) |
| DB access pattern | Singleton `getDatabase()` | Minimal caller changes; `closeDatabaseForTesting()` for tests |
| Workspace lock refactoring | Refactor `WorkspaceLock` class internally | Keep same static API, replace file ops with DB queries |
| Old JSON files | Leave in place after import | Serve as implicit backup |
| First plan testing | Include import integration test | Validates DB layer before caller migration |
| Workspace API migration | Replace callers directly | Remove `workspace_tracker.ts`, callers import from `db/workspace.ts` |
| Config path location | `src/common/` | Shared `getTimConfigRoot()` function |
| Import trigger | Auto on first DB creation | If DB file doesn't exist, create + migrate + import JSON |
| Lock types | Keep `'persistent' \| 'pid'` | Match current code, not the schema's unused types |
| Sync vs async | Synchronous DB functions | Match `bun:sqlite`'s native sync API; simpler and faster |

## Implementation Guide

### Phase 1: Database Foundation

#### Step 1: Create config path utility (`src/common/config_paths.ts`)

Extract and consolidate the `getConfigRoot()` logic duplicated in `assignments_io.ts` and `permissions_io.ts` into a shared `getTimConfigRoot()` function. Respects `XDG_CONFIG_HOME`, `APPDATA`, and defaults to `~/.config/tim`.

#### Step 2: Create database module (`src/tim/db/database.ts`)

Create the core database module with:
- A `getDefaultDatabasePath()` function returning `{getTimConfigRoot()}/tim.db`
- An `openDatabase(dbPath?: string)` function that:
  - Opens/creates the SQLite database at the given path (or default)
  - Sets pragmas: `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`, `synchronous = NORMAL`
  - Runs migrations (see Step 3)
  - If the database file was just created (didn't exist before), runs JSON import (see Phase 3)
  - Returns the `Database` instance
- A singleton `getDatabase()` that lazily opens the default database
- A `closeDatabaseForTesting()` function that closes and resets the singleton (for test cleanup)

All DB functions should be **synchronous**, matching `bun:sqlite`'s native API. Callers that previously used `await` on async JSON I/O functions will call the new DB functions directly without `await`.

Use `bun:sqlite`'s `Database` class directly. Reference the Bun SQLite documentation for API details.

#### Step 3: Create migration system (`src/tim/db/migrations.ts`)

Implement a simple migration runner:
- Create a `schema_version` table with a single row tracking the current version
- Define migrations as an ordered array of `{ version: number, sql: string }` objects
- The initial migration (version 1) creates all tables and indices from the plan's Database Schema section
- Run migrations in a transaction, updating `schema_version` after each
- The SQL is defined as template literal strings directly in TypeScript, so it's bundled automatically

Initial schema DDL should create:
- `schema_version` table
- `project` table with unique index on `repository_id`
- `workspace` table with unique index on `workspace_path` and index on `project_id`
- `workspace_issue` table with FK to workspace
- `workspace_lock` table with unique FK to workspace
- `permission` table with index on `project_id`
- `assignment` table with unique index on `(project_id, plan_uuid)` and index on `workspace_id`

Note: The `lock_type` column in `workspace_lock` should use values `'persistent'` and `'pid'` to match the current `LockType` in `workspace_lock.ts`, not the `'file' | 'pid' | 'advisory'` values listed in the original schema section above.

#### Step 4: Write database foundation tests (`src/tim/db/database.test.ts`)

Test:
- Database opens successfully with temp file path
- Pragmas are correctly set (WAL mode, foreign keys ON)
- Schema version is tracked
- Tables exist with correct structure
- Migrations run idempotently (opening same DB twice doesn't fail)

Use `fs.mkdtemp()` to create temp directories for test databases. Each test gets its own database file.

### Phase 2: CRUD Operations

Each of these modules should follow the same pattern:
- Export functions that accept a `Database` instance as the first parameter
- Use prepared statements for performance (bun:sqlite supports `db.prepare()`)
- Use `BEGIN IMMEDIATE` transactions for write operations
- Return plain TypeScript objects (not raw SQL rows)

#### Step 5: Project CRUD (`src/tim/db/project.ts`)

Functions:
- `getOrCreateProject(db, repositoryId, options?)` - Find by `repository_id` or create with provided details. Return the project row.
- `getProject(db, repositoryId)` - Find by `repository_id`, return null if not found
- `updateProject(db, projectId, updates)` - Update mutable fields
- `reserveNextPlanId(db, repositoryId, localMaxId, count?)` - Atomic ID reservation using `UPDATE ... SET highest_plan_id = max(highest_plan_id, ?) + ?` within a transaction
- `listProjects(db)` - List all projects

The `getOrCreateProject` function is key - many operations need to ensure a project exists before creating related records.

#### Step 6: Assignment CRUD (`src/tim/db/assignment.ts`)

Functions matching current `claim_plan.ts` / `release_plan.ts` semantics:
- `claimAssignment(db, projectId, planUuid, planId, workspaceId?, user?)` - Upsert assignment. Return created/updated status.
- `releaseAssignment(db, projectId, planUuid, workspacePath?, user?)` - Remove or update assignment. If no workspace/user remains, delete the row.
- `getAssignment(db, projectId, planUuid)` - Get single assignment
- `getAssignmentsByProject(db, projectId)` - List all assignments for a project
- `removeAssignment(db, projectId, planUuid)` - Delete assignment record
- `cleanStaleAssignments(db, projectId, staleThresholdDays)` - Remove old assignments

The caller modules (`claim_plan.ts`, `release_plan.ts`) should be updated to call these functions. The return types should match the existing `ClaimPlanResult` / `ReleasePlanResult` interfaces where possible, to minimize changes to command-level code.

#### Step 7: Permission CRUD (`src/tim/db/permission.ts`)

Functions:
- `getPermissions(db, projectId)` - Return `{ allow: string[], deny: string[] }`
- `addPermission(db, projectId, type, pattern)` - Add if not duplicate
- `removePermission(db, projectId, type, pattern)` - Remove specific permission
- `setPermissions(db, projectId, permissions)` - Replace all permissions for a project

#### Step 8: Workspace CRUD (`src/tim/db/workspace.ts`)

Functions mapping to current `workspace_tracker.ts`:
- `recordWorkspace(db, workspace)` - Insert or update workspace
- `getWorkspaceByPath(db, workspacePath)` - Get single workspace
- `findWorkspacesByTaskId(db, taskId)` - Find workspaces by task ID
- `findWorkspacesByProjectId(db, projectId)` - Find workspaces by project
- `patchWorkspace(db, workspacePath, patch)` - Partial update
- `deleteWorkspace(db, workspacePath)` - Remove workspace record
- Workspace issue management: `addWorkspaceIssue(db, workspaceId, issueUrl)`, `getWorkspaceIssues(db, workspaceId)`, `setWorkspaceIssues(db, workspaceId, issueUrls[])`

#### Step 9: Workspace Lock CRUD (`src/tim/db/workspace_lock.ts`)

Functions mapping to current `WorkspaceLock` class:
- `acquireWorkspaceLock(db, workspaceId, lockInfo)` - Insert lock, fail if exists (non-stale)
- `releaseWorkspaceLock(db, workspaceId, options?)` - Delete lock, with PID/force checks
- `getWorkspaceLock(db, workspaceId)` - Get lock info
- `cleanStaleLocks(db)` - Remove stale locks (same PID-checking logic)

The PID liveness check (`process.kill(pid, 0)`) stays in application code, not in SQL.

### Phase 3: JSON Import

#### Step 10: JSON import logic (`src/tim/db/json_import.ts`)

Create a one-time import function that:
1. Checks if the database has been previously populated (e.g., a `migration_completed` flag in `schema_version` or simply checking if any projects exist)
2. Scans `~/.config/tim/shared/` for assignment/permission JSON files
3. Reads `~/.config/tim/workspaces.json`
4. Scans `~/.config/tim/repositories/` for metadata JSON files
5. Scans `~/.config/tim/locks/` for lock files
6. Imports all data into the database within a single transaction
7. Handles the denormalized → normalized conversion for assignments (multiple workspacePaths → pick most appropriate single workspace or create multiple assignments)

For assignments with multiple workspace paths, pick the most recently updated workspace path and its corresponding user from `workspaceOwners`. This simplifies the import since the new schema supports only one workspace per assignment.

This import runs automatically when `openDatabase()` detects the database file is being created for the first time (file didn't exist before the call). It should be idempotent - running it when data already exists should not create duplicates (use INSERT OR IGNORE or check existence).

Note: The import is triggered automatically from `openDatabase()` when the DB file is being created for the first time. The import function reads the existing JSON files from the config directory, but the JSON files are left in place after import (they serve as implicit backup).

#### Step 11: Write import tests (`src/tim/db/json_import.test.ts`)

Test:
- Import from complete JSON files
- Import with missing files (graceful handling)
- Import with assignments that have multiple workspace paths (picks most recent)
- Import is idempotent
- Imported data is queryable through CRUD functions

### Phase 4: Migrate Callers

#### Step 12: Migrate assignment callers

Update these files to use DB functions instead of JSON I/O:
- `src/tim/assignments/claim_plan.ts` - Replace `readAssignments()`/`writeAssignments()` with `claimAssignment()`
- `src/tim/assignments/release_plan.ts` - Replace with `releaseAssignment()`
- `src/tim/assignments/auto_claim.ts` - Update to use DB claim
- `src/tim/commands/assignments.ts` - Read/write from DB
- `src/tim/commands/ready.ts` - Read assignments from DB
- `src/tim/commands/renumber.ts` - Use DB `reserveNextPlanId()`
- `src/tim/id_utils.ts` - Use DB `reserveNextPlanId()`

The key challenge here is that `claimPlan()` and `releasePlan()` return detailed result objects (`ClaimPlanResult`, `ReleasePlanResult`). The DB functions should return compatible information so command-level code doesn't need major changes.

#### Step 13: Migrate permission callers

Update:
- `src/tim/executors/claude_code.ts` - Use `getPermissions()` instead of `readSharedPermissions()`
- Any subagent code that uses permissions

#### Step 14: Migrate workspace callers

Update callers to import directly from `src/tim/db/workspace.ts` instead of `workspace_tracker.ts`:
- `src/tim/workspace/workspace_manager.ts` - Use `recordWorkspace()` from DB
- `src/tim/workspace/workspace_auto_selector.ts` - Use `findWorkspacesByProjectId()`/`findWorkspacesByTaskId()` from DB
- `src/tim/commands/workspace.ts` - Use DB for workspace operations
- `src/tim/commands/agent/agent.ts` - Use DB for workspace operations

#### Step 15: Migrate workspace lock to use DB internally

Refactor `src/tim/workspace/workspace_lock.ts` (`WorkspaceLock` class) to use DB queries internally instead of file operations, keeping the same static method API. The sync cleanup handlers (`process.on('exit', ...)`) use `bun:sqlite`'s native synchronous API directly (since `bun:sqlite` is synchronous by default). Callers (`done.ts`, `workspace.ts`, `agent.ts`) don't need changes since the API is preserved.

#### Step 16: Migrate repository metadata callers

Update:
- `src/tim/external_storage_utils.ts` - Use `getProject()` / `updateProject()` from DB
- `src/tim/storage/storage_manager.ts` - Use `listProjects()` from DB
- `src/tim/repository_config_resolver.ts` - Use `getProject()` from DB

### Phase 5: Cleanup and Testing

#### Step 17: Update existing tests

Update all test files that currently test JSON I/O to test the DB-backed implementations:
- `assignments_io.test.ts` → test DB assignment operations
- `permissions_io.test.ts` → test DB permission operations
- `workspace_tracker.test.ts` → test DB workspace operations
- `workspace_lock.test.ts` → test DB workspace lock operations
- `storage_manager.test.ts` → test DB storage operations
- Integration tests: `task-management.integration.test.ts`, `claim.test.ts`, `release.test.ts`

Test isolation for SQLite: Each test should create its own database in a temp directory. A test helper like `createTestDatabase()` would standardize this.

#### Step 18: Remove deprecated JSON I/O code

Once all callers are migrated and tests pass:
- Remove `src/tim/assignments/assignments_io.ts`
- Remove `src/tim/assignments/assignments_schema.ts`
- Remove `src/tim/assignments/permissions_io.ts`
- Remove `src/tim/assignments/permissions_schema.ts`
- Remove file locking code that's no longer needed
- Clean up any remaining references

#### Step 19: End-to-end testing and documentation

- Run `bun test` to verify all tests pass
- Run `bun run check` for type checking
- Run `bun run format` for code formatting
- Test the JSON import manually with existing data
- Update README if any user-facing behavior changes

### Manual Testing Steps

1. Build and install: `bun run dev-install`
2. Run `tim list` - should trigger JSON import on first run, creating `~/.config/tim/tim.db`
3. Verify existing assignments, workspaces, and permissions are accessible
4. Run `tim workspace list` - should show existing workspaces
5. Create a new workspace and verify it appears in the database
6. Claim and release a plan, verify assignment tracking works
7. Test concurrent access: run two tim commands simultaneously

### Rationale for Approach

- **Bottom-up implementation**: Build the DB layer first (Phase 1-2), then import (Phase 3), then migrate callers (Phase 4). This allows incremental testing at each phase.
- **Synchronous API**: `bun:sqlite` is natively synchronous. The new DB functions are synchronous too, eliminating unnecessary Promise wrapping. Callers drop `await` when switching to DB functions.
- **Function-level DB access rather than ORM**: `bun:sqlite` is synchronous and fast. Prepared statements provide sufficient abstraction without adding an ORM dependency.
- **Singleton pattern**: `getDatabase()` lazily opens the default database. Tests use `closeDatabaseForTesting()` + temp file paths. Simpler than threading a `db` parameter through every call chain.
- **Embedded SQL strings**: SQL as template literals in TypeScript files means no special build handling needed - they bundle naturally with `Bun.build()`.
- **Test database per test**: Simpler and more reliable than the current environment variable + module mock approach. Each test creates a temp database, no global state contamination.
