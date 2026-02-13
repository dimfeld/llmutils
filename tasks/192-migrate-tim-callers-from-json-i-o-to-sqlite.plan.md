---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Migrate tim callers from JSON I/O to SQLite database
goal: ""
id: 192
uuid: f8d20819-0761-48b4-8d59-f9dcb1ab9eae
generatedBy: agent
status: pending
priority: medium
dependencies:
  - 191
parent: 158
references:
  "158": e17331a4-1827-49ea-88e6-82de91f993df
  "191": b4980a23-e869-4ff5-9108-29b0efdd7fb0
planGeneratedAt: 2026-02-13T23:08:41.303Z
promptsGeneratedAt: 2026-02-13T23:08:41.303Z
createdAt: 2026-02-13T23:07:37.799Z
updatedAt: 2026-02-13T23:08:41.304Z
tasks:
  - title: Migrate assignment callers to use SQLite
    done: false
    description: Update claim_plan.ts, release_plan.ts, auto_claim.ts to use DB
      assignment functions instead of readAssignments/writeAssignments. Update
      commands/assignments.ts, commands/ready.ts to read from DB. Update
      commands/renumber.ts and id_utils.ts to use DB reserveNextPlanId. Ensure
      ClaimPlanResult and ReleasePlanResult interfaces still work for
      command-level code. DB functions are synchronous so callers drop await.
  - title: Migrate permission callers to use SQLite
    done: false
    description: Update executors/claude_code.ts to use getPermissions() from
      db/permission.ts instead of readSharedPermissions(). Update any subagent
      code that uses permissions. The addSharedPermission callers switch to
      addPermission(). DB functions are synchronous.
  - title: Migrate workspace callers to import from db/workspace.ts
    done: false
    description: Update workspace_manager.ts to use recordWorkspace() from
      db/workspace.ts. Update workspace_auto_selector.ts to use
      findWorkspacesByProjectId/findWorkspacesByTaskId from DB. Update
      commands/workspace.ts and commands/agent/agent.ts to use DB workspace
      operations. Callers import directly from db/workspace.ts - no facade
      layer. Remove workspace_tracker.ts after all callers migrated.
  - title: Refactor WorkspaceLock class to use DB internally
    done: false
    description: Modify src/tim/workspace/workspace_lock.ts to replace file
      operations with DB queries internally while keeping the same static method
      API (acquireLock, releaseLock, getLockInfo, isLocked, isLockStale). Sync
      cleanup handlers (process.on exit) use bun:sqlite synchronous API. Remove
      getLockDirectory, getLockFileName, getLockFilePath (no more lock files).
      setTestLockDirectory becomes unnecessary; tests use
      closeDatabaseForTesting instead.
  - title: Migrate repository metadata callers to use SQLite
    done: false
    description: Update external_storage_utils.ts to use getProject/updateProject
      from DB for metadata. Update storage/storage_manager.ts
      collectExternalStorageDirectories to use listProjects from DB. Update
      repository_config_resolver.ts to use getProject from DB for config
      resolution.
  - title: Update existing tests for DB-backed implementations
    done: false
    description: "Update test files: assignments_io.test.ts (test DB assignment
      operations), permissions_io.test.ts (test DB permission operations),
      workspace_tracker.test.ts (test DB workspace operations),
      workspace_lock.test.ts (test DB workspace lock operations),
      storage_manager.test.ts (test DB storage operations). Update integration
      tests: task-management.integration.test.ts, claim.test.ts,
      release.test.ts. Test isolation uses temp DB files instead of env var +
      module mock approach."
  - title: Remove deprecated JSON I/O code and file locking
    done: false
    description: Remove src/tim/assignments/assignments_io.ts,
      assignments_schema.ts, permissions_io.ts, permissions_schema.ts. Remove
      workspace_tracker.ts. Remove file locking code (acquireFileLock, lock
      files). Clean up any remaining references. Run bun run check and bun test
      to verify no broken references.
  - title: Final validation and documentation
    done: false
    description: Run bun test for full test suite. Run bun run check for type
      checking. Run bun run format for code formatting. Update README with any
      user-facing changes. Verify build works with bun run build.
tags: []
---

## Overview

Migrate all existing tim callers from JSON file I/O to the SQLite database layer created in plan 191. This includes updating assignment, permission, workspace, workspace lock, and repository metadata callers, updating tests, and removing deprecated JSON I/O code.

## Scope

### Caller Migrations
- Assignment callers: claim_plan.ts, release_plan.ts, auto_claim.ts, commands/assignments.ts, commands/ready.ts, commands/renumber.ts, id_utils.ts
- Permission callers: executors/claude_code.ts, subagent system
- Workspace callers: workspace_manager.ts, workspace_auto_selector.ts, commands/workspace.ts, commands/agent/agent.ts
- Workspace lock: Refactor WorkspaceLock class to use DB internally (keep same API)
- Repository metadata: external_storage_utils.ts, storage/storage_manager.ts, repository_config_resolver.ts

### Test Updates
- Update all existing tests that test JSON I/O to test DB-backed implementations
- Integration tests: task-management.integration.test.ts, claim.test.ts, release.test.ts

### Cleanup
- Remove assignments_io.ts, assignments_schema.ts, permissions_io.ts, permissions_schema.ts
- Remove file locking code
- Clean up unused references

## Key Design Decisions
- Callers import directly from db/ modules (no facade layer)
- workspace_tracker.ts is removed; callers import from db/workspace.ts
- WorkspaceLock class keeps same static API but uses DB internally
- DB functions are synchronous; callers drop `await` when switching
- Singleton getDatabase() pattern means minimal parameter threading
