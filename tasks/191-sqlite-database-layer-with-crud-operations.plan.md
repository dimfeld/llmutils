---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: SQLite database layer with CRUD operations, migration, and JSON import
goal: ""
id: 191
uuid: b4980a23-e869-4ff5-9108-29b0efdd7fb0
generatedBy: agent
status: done
priority: medium
parent: 158
references:
  "158": e17331a4-1827-49ea-88e6-82de91f993df
planGeneratedAt: 2026-02-13T23:08:19.319Z
promptsGeneratedAt: 2026-02-13T23:08:19.319Z
createdAt: 2026-02-13T23:07:25.620Z
updatedAt: 2026-02-13T23:58:44.673Z
tasks:
  - title: Create shared config path utility
    done: true
    description: Create src/common/config_paths.ts with getTimConfigRoot() function.
      Consolidates duplicated getConfigRoot() from assignments_io.ts and
      permissions_io.ts. Handles XDG_CONFIG_HOME, APPDATA (Windows), and
      defaults to ~/.config/tim.
  - title: Create database module with initialization and singleton
    done: true
    description: Create src/tim/db/database.ts with openDatabase(dbPath?) function
      that creates/opens SQLite DB, sets pragmas (WAL, foreign_keys,
      busy_timeout, synchronous), runs migrations, and triggers JSON import on
      first creation. Implement singleton getDatabase() and
      closeDatabaseForTesting(). All functions synchronous.
  - title: Create schema migration system
    done: true
    description: "Create src/tim/db/migrations.ts with a simple migration runner.
      Uses schema_version table to track current version. Initial migration (v1)
      creates all tables: project, workspace, workspace_issue, workspace_lock,
      permission, assignment with all indices. SQL defined as template literal
      strings in TypeScript (bundles naturally). Lock types: 'persistent' |
      'pid'."
  - title: Implement Project CRUD operations
    done: true
    description: "Create src/tim/db/project.ts with synchronous functions:
      getOrCreateProject(db, repositoryId, options?), getProject(db,
      repositoryId), updateProject(db, projectId, updates),
      reserveNextPlanId(db, repositoryId, localMaxId, count?), listProjects(db).
      reserveNextPlanId uses BEGIN IMMEDIATE transaction with UPDATE SET
      highest_plan_id = max(highest_plan_id, localMaxId) + count."
  - title: Implement Assignment CRUD operations
    done: true
    description: "Create src/tim/db/assignment.ts with synchronous functions:
      claimAssignment(db, projectId, planUuid, planId, workspaceId?, user?),
      releaseAssignment(db, projectId, planUuid, workspacePath?, user?),
      getAssignment(db, projectId, planUuid), getAssignmentsByProject(db,
      projectId), removeAssignment(db, projectId, planUuid),
      cleanStaleAssignments(db, projectId, staleThresholdDays). Return types
      should provide enough info for ClaimPlanResult/ReleasePlanResult
      compatibility."
  - title: Implement Permission CRUD operations
    done: true
    description: "Create src/tim/db/permission.ts with synchronous functions:
      getPermissions(db, projectId) returning {allow: string[], deny: string[]},
      addPermission(db, projectId, type, pattern), removePermission(db,
      projectId, type, pattern), setPermissions(db, projectId, permissions)."
  - title: Implement Workspace CRUD operations
    done: true
    description: "Create src/tim/db/workspace.ts with synchronous functions:
      recordWorkspace(db, workspace), getWorkspaceByPath(db, workspacePath),
      findWorkspacesByTaskId(db, taskId), findWorkspacesByProjectId(db,
      projectId), patchWorkspace(db, workspacePath, patch), deleteWorkspace(db,
      workspacePath). Also workspace issue management: addWorkspaceIssue,
      getWorkspaceIssues, setWorkspaceIssues. Return types compatible with
      WorkspaceInfo interface."
  - title: Implement Workspace Lock CRUD operations
    done: true
    description: "Create src/tim/db/workspace_lock.ts with synchronous functions:
      acquireWorkspaceLock(db, workspaceId, lockInfo), releaseWorkspaceLock(db,
      workspaceId, options?), getWorkspaceLock(db, workspaceId),
      cleanStaleLocks(db). PID liveness check (process.kill(pid, 0)) stays in
      application code. Lock types: 'persistent' | 'pid'."
  - title: Implement JSON import logic
    done: true
    description: Create src/tim/db/json_import.ts with importFromJsonFiles(db,
      configRoot) function. Scans ~/.config/tim/shared/ for assignment and
      permission JSON files, reads workspaces.json, scans repositories/ for
      metadata, scans locks/ for lock files. Imports all data within a single
      transaction. For multi-workspace assignments, picks most recent workspace.
      Uses INSERT OR IGNORE for idempotency. JSON files left in place after
      import.
  - title: Write comprehensive tests for all DB modules
    done: true
    description: "Create test files: database.test.ts (pragma verification,
      migration idempotency, table structure), project.test.ts,
      assignment.test.ts, permission.test.ts, workspace.test.ts,
      workspace_lock.test.ts. Each test uses fs.mkdtemp() temp directories for
      isolated DB files. Test CRUD operations, edge cases, constraint
      enforcement."
  - title: Write JSON import integration tests
    done: true
    description: "Create src/tim/db/json_import.test.ts. Tests: import from complete
      JSON fixtures, import with missing files, import with multi-workspace
      assignments (verifies most-recent picking), import idempotency, imported
      data queryable through CRUD functions. Creates realistic JSON fixture
      files in temp directories."
changedFiles:
  - src/common/config_paths.test.ts
  - src/common/config_paths.ts
  - src/tim/db/assignment.test.ts
  - src/tim/db/assignment.ts
  - src/tim/db/database.test.ts
  - src/tim/db/database.ts
  - src/tim/db/json_import.test.ts
  - src/tim/db/json_import.ts
  - src/tim/db/migrations.ts
  - src/tim/db/permission.test.ts
  - src/tim/db/permission.ts
  - src/tim/db/project.test.ts
  - src/tim/db/project.ts
  - src/tim/db/workspace.test.ts
  - src/tim/db/workspace.ts
  - src/tim/db/workspace_lock.test.ts
  - src/tim/db/workspace_lock.ts
tags: []
---

## Overview

Create the SQLite database foundation for tim storage migration. This plan covers the database module, schema migrations, all CRUD operation modules, JSON import logic, and comprehensive tests. No existing callers are modified in this plan.

## Scope

- `src/common/config_paths.ts` - Shared `getTimConfigRoot()` function
- `src/tim/db/database.ts` - Database initialization, connection, pragma setup, singleton
- `src/tim/db/migrations.ts` - Schema versioning and migration runner
- `src/tim/db/project.ts` - Project CRUD (getOrCreate, update, reserveNextPlanId, list)
- `src/tim/db/assignment.ts` - Assignment CRUD (claim, release, get, list, remove)
- `src/tim/db/permission.ts` - Permission CRUD (get, add, remove, set)
- `src/tim/db/workspace.ts` - Workspace CRUD (record, get, find, patch, delete, issues)
- `src/tim/db/workspace_lock.ts` - Workspace lock CRUD (acquire, release, get, clean stale)
- `src/tim/db/json_import.ts` - One-time import from existing JSON files
- Tests for all of the above, including import integration tests

## Key Design Decisions

- All DB functions are **synchronous** (matching bun:sqlite's native API)
- Singleton `getDatabase()` pattern with `closeDatabaseForTesting()` for test cleanup
- Config root function in `src/common/config_paths.ts`
- JSON import triggers automatically on first DB creation (file doesn't exist)
- Import picks most recent workspace for assignments with multiple workspace paths
- Lock types: 'persistent' | 'pid' (matching current code)
- Old JSON files left in place after import

## Current Progress
### Current State
- All 11 tasks completed. The full SQLite database layer is implemented with CRUD operations, migration system, and JSON import.

### Completed (So Far)
- `src/common/config_paths.ts` - Shared `getTimConfigRoot()` consolidating duplicated logic
- `src/tim/db/database.ts` - Database init with WAL, foreign_keys, busy_timeout, synchronous pragmas; singleton pattern; auto-import on first creation
- `src/tim/db/migrations.ts` - Schema v1 with all tables, indices, and FK constraints (ON DELETE CASCADE throughout); schema_version tracks import_completed flag
- `src/tim/db/project.ts` - Full CRUD with `db.transaction().immediate()` for all writes
- `src/tim/db/assignment.ts` - Claim/release with rich result types (updatedWorkspace, updatedUser, etc.); importAssignment for legacy data preservation
- `src/tim/db/permission.ts` - Get/add/remove/set with duplicate prevention
- `src/tim/db/workspace.ts` - Full CRUD including issue management; UNIQUE(workspace_id, issue_url) constraint
- `src/tim/db/workspace_lock.ts` - Acquire/release/clean with stale-lock auto-clearing (PID liveness + 24h timeout)
- `src/tim/db/json_import.ts` - Imports assignments, permissions, workspaces, repository metadata; skips locks (ephemeral); validates entries before import
- 72 tests passing across all modules

### Remaining
- None for this plan. Caller migration is handled by sibling plan 192.

### Next Iteration Guidance
- Plan 192 (caller migration) should reference the CRUD function signatures in `src/tim/db/` modules
- `importAssignment` preserves legacy timestamps/status - callers should use `claimAssignment` for runtime operations
- The `shouldRunImport`/`markImportCompleted` pattern uses a persistent flag in schema_version, not project count

### Decisions / Changes
- Lock file import was intentionally skipped - lock files use hash-based filenames that can't be reverse-mapped to workspace paths, and locks are ephemeral
- Import gating uses a persistent `import_completed` flag in schema_version (not project count) to prevent redundant filesystem scans
- All write transactions use `db.transaction().immediate()` consistently per plan requirements
- Assignment table has ON DELETE CASCADE on project_id FK, matching all other tables
- workspace_issue table has UNIQUE(workspace_id, issue_url) constraint to prevent duplicates
- `acquireWorkspaceLock` auto-clears stale locks before throwing, matching existing `WorkspaceLock.acquireLock()` behavior
- `cleanStaleLocks` checks both PID liveness AND 24-hour age threshold, matching existing stale lock detection

### Lessons Learned
- bun:sqlite's `db.transaction()` returns an object with `.immediate()`, `.deferred()`, `.exclusive()` methods - use `.immediate()` for all write transactions consistently
- When nesting transactions in bun:sqlite, inner `db.transaction().immediate()` calls automatically use savepoints - no special handling needed
- Single-statement DELETEs don't need transaction wrappers since individual SQL statements are already atomic in SQLite
- SQL parameterization must be used even for validated integer values to maintain consistent security patterns
- Import functions should preserve legacy field values (status, timestamps) rather than using defaults that lose data
- Stale lock detection requires both PID liveness check AND age-based timeout (24h) to handle PID recycling edge cases

### Risks / Blockers
- None
