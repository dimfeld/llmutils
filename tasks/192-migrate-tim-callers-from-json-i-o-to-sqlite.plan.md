---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Migrate tim callers from JSON I/O to SQLite database
goal: ""
id: 192
uuid: f8d20819-0761-48b4-8d59-f9dcb1ab9eae
generatedBy: agent
status: done
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
updatedAt: 2026-02-14T07:35:09.986Z
tasks:
  - title: Migrate assignment callers to use SQLite
    done: true
    description: Update claim_plan.ts, release_plan.ts, auto_claim.ts to use DB
      assignment functions instead of readAssignments/writeAssignments. Update
      commands/assignments.ts, commands/ready.ts to read from DB. Update
      commands/renumber.ts and id_utils.ts to use DB reserveNextPlanId. Ensure
      ClaimPlanResult and ReleasePlanResult interfaces still work for
      command-level code. DB functions are synchronous so callers drop await.
  - title: Migrate permission callers to use SQLite
    done: true
    description: Update executors/claude_code.ts to use getPermissions() from
      db/permission.ts instead of readSharedPermissions(). Update any subagent
      code that uses permissions. The addSharedPermission callers switch to
      addPermission(). DB functions are synchronous.
  - title: Migrate workspace callers to import from db/workspace.ts
    done: true
    description: Update workspace_manager.ts to use recordWorkspace() from
      db/workspace.ts. Update workspace_auto_selector.ts to use
      findWorkspacesByProjectId/findWorkspacesByTaskId from DB. Update
      commands/workspace.ts and commands/agent/agent.ts to use DB workspace
      operations. Callers import directly from db/workspace.ts - no facade
      layer. Remove workspace_tracker.ts after all callers migrated.
  - title: Refactor WorkspaceLock class to use DB internally
    done: true
    description: Modify src/tim/workspace/workspace_lock.ts to replace file
      operations with DB queries internally while keeping the same static method
      API (acquireLock, releaseLock, getLockInfo, isLocked, isLockStale). Sync
      cleanup handlers (process.on exit) use bun:sqlite synchronous API. Remove
      getLockDirectory, getLockFileName, getLockFilePath (no more lock files).
      setTestLockDirectory becomes unnecessary; tests use
      closeDatabaseForTesting instead.
  - title: Migrate repository metadata callers to use SQLite
    done: true
    description: Update external_storage_utils.ts to use getProject/updateProject
      from DB for metadata. Update storage/storage_manager.ts
      collectExternalStorageDirectories to use listProjects from DB. Update
      repository_config_resolver.ts to use getProject from DB for config
      resolution.
  - title: Update existing tests for DB-backed implementations
    done: true
    description: "Update test files: assignments_io.test.ts (test DB assignment
      operations), permissions_io.test.ts (test DB permission operations),
      workspace_tracker.test.ts (test DB workspace operations),
      workspace_lock.test.ts (test DB workspace lock operations),
      storage_manager.test.ts (test DB storage operations). Update integration
      tests: task-management.integration.test.ts, claim.test.ts,
      release.test.ts. Test isolation uses temp DB files instead of env var +
      module mock approach."
  - title: Remove deprecated JSON I/O code and file locking
    done: true
    description: Remove src/tim/assignments/assignments_io.ts,
      assignments_schema.ts, permissions_io.ts, permissions_schema.ts. Remove
      workspace_tracker.ts. Remove file locking code (acquireFileLock, lock
      files). Clean up any remaining references. Run bun run check and bun test
      to verify no broken references.
  - title: Final validation and documentation
    done: true
    description: Run bun test for full test suite. Run bun run check for type
      checking. Run bun run format for code formatting. Update README with any
      user-facing changes. Verify build works with bun run build.
  - title: "Address Review Feedback: cleanStaleLocks has a TOCTOU
      (time-of-check-to-time-of-use) race condition."
    done: true
    description: >-
      cleanStaleLocks has a TOCTOU (time-of-check-to-time-of-use) race
      condition. It reads all pid locks outside a transaction (lines 148-156),
      filters for stale ones in JavaScript (line 158), then deletes them inside
      a separate transaction (lines 164-172). Between the read and delete,
      another process could call acquireWorkspaceLock which atomically replaces
      a stale lock with a new valid one. The subsequent DELETE in
      cleanStaleLocks would remove the newly-acquired valid lock. Mitigating
      factor: cleanStaleLocks is currently only called from tests, not from any
      production code path.


      Suggestion: Add conditions to the DELETE to match the specific lock that
      was identified as stale: `DELETE FROM workspace_lock WHERE workspace_id =
      ? AND pid = ? AND started_at = ?`. This ensures the delete only removes
      the exact lock it checked, not a replacement.


      Related file: src/tim/db/workspace_lock.ts:147-175
  - title: "Address Review Feedback: `collectExternalStorageDirectories()` now lists
      DB rows without checking whether `repositoryPath` actually exists
      (`src/tim/storage/storage_manager.ts:106`)."
    done: true
    description: >-
      `collectExternalStorageDirectories()` now lists DB rows without checking
      whether `repositoryPath` actually exists
      (`src/tim/storage/storage_manager.ts:106`). This returns phantom storage
      entries after manual deletion/stale metadata, which regresses behavior
      from filesystem-backed listing and makes `tim storage list` inaccurate.


      Suggestion: Before emitting an entry, verify `repositoryPath` exists as a
      directory. If missing, either skip it or clear that project's external
      storage fields in DB.


      Related file: src/tim/storage/storage_manager.ts:106
  - title: "Address Review Feedback: The test 'claimAssignment preserves existing
      assignment status on re-claim' sets the assignment status to 'in_progress'
      before re-claiming, but 'in_progress' is already the default status on
      initial claim."
    done: true
    description: >-
      The test 'claimAssignment preserves existing assignment status on
      re-claim' sets the assignment status to 'in_progress' before re-claiming,
      but 'in_progress' is already the default status on initial claim. The test
      passes trivially without actually verifying that a different status is
      preserved through the ON CONFLICT clause.


      Suggestion: Change the status to something other than 'in_progress' (e.g.,
      'done' or 'pending') before re-claiming, to verify the ON CONFLICT clause
      actually preserves the existing status value.


      Related file: src/tim/db/assignment.test.ts:82-91
  - title: "Address Review Feedback: During JSON import, updateProject is called for
      every workspace's repository, even when repositoryData is undefined."
    done: true
    description: >-
      During JSON import, updateProject is called for every workspace's
      repository, even when repositoryData is undefined. When repositoryData is
      undefined, all fields resolve to null via
      `repositoryData?.metadata?.lastGitRoot ?? null`, which can overwrite valid
      metadata previously set by another workspace iteration for the same
      project. The second loop at line 334-409 already handles project metadata
      updates with a proper guard (line 347), making this first updateProject
      call at line 308-313 both redundant and potentially destructive.


      Suggestion: Only call updateProject when repositoryData is defined, e.g.
      wrap lines 308-313 in `if (repositoryData) { ... }`, or remove the
      updateProject call from the workspace loop entirely since the second loop
      handles it with a proper guard.


      Related file: src/tim/db/json_import.ts:308-313
  - title: "Address Review Feedback: STORAGE_METADATA_FILENAME is exported but has
      no importers anywhere in the codebase after the migration."
    done: true
    description: >-
      STORAGE_METADATA_FILENAME is exported but has no importers anywhere in the
      codebase after the migration. It's leftover from the JSON file storage
      approach.


      Suggestion: Remove the dead export: `export const
      STORAGE_METADATA_FILENAME = 'metadata.json';`


      Related file: src/tim/external_storage_utils.ts:8
  - title: "Address Review Feedback: The removePlanAssignment helper is duplicated
      across 4 files with nearly identical logic: check UUID, get repository
      identity, get DB/project, call removeAssignment, catch errors and warn."
    done: true
    description: >-
      The removePlanAssignment helper is duplicated across 4 files with nearly
      identical logic: check UUID, get repository identity, get DB/project, call
      removeAssignment, catch errors and warn. The only difference is whether
      baseDir is accepted as a parameter.


      Suggestion: Extract into a shared utility function (e.g., in
      src/tim/db/assignment.ts or a new
      src/tim/assignments/remove_assignment_helper.ts) that accepts an optional
      baseDir parameter. Update mark_done.ts:20, parent_plans.ts:11, set.ts:366,
      and remove.ts:151 to use the shared function.


      Related file: src/tim/plans/mark_done.ts:20-42
  - title: "Address Review Feedback: Pre-existing inconsistency:
      checkAndMarkParentDone in parent_plans.ts (line 101) only considers status
      === 'done' for all-children-done check, while mark_done.ts (lines 510-512)
      also accepts 'cancelled'."
    done: true
    description: >-
      Pre-existing inconsistency: checkAndMarkParentDone in parent_plans.ts
      (line 101) only considers status === 'done' for all-children-done check,
      while mark_done.ts (lines 510-512) also accepts 'cancelled'. This means a
      parent epic won't auto-complete via the agent path if any child is
      cancelled, but will auto-complete via 'tim done'. This was not introduced
      by the migration.


      Suggestion: Unify the two implementations to both accept 'done' and
      'cancelled' as complete states, or document the intentional difference.


      Related file: src/tim/commands/agent/parent_plans.ts:101
  - title: "Address Review Feedback: Stale-lock cleanup on read has a TOCTOU race
      that can delete a newly acquired valid lock."
    done: true
    description: >-
      Stale-lock cleanup on read has a TOCTOU race that can delete a newly
      acquired valid lock. In `WorkspaceLock.getLockInfoInternal()` and
      `WorkspaceLock.isLocked()`, code checks staleness and then calls force
      release. `releaseWorkspaceLock()` deletes by `workspace_id` only, so if
      another process replaces the stale lock between check and delete, the
      fresh lock is removed.


      Suggestion: Make stale cleanup conditional on the exact lock observed
      (match `workspace_id + pid + started_at`), similar to the
      `cleanStaleLocks` fix. Add a regression test that replaces a stale lock
      during cleanup and verifies the replacement is preserved.


      Related file: src/tim/workspace/workspace_lock.ts:155
  - title: "Address Review Feedback: The two batch mode integration tests
      ('end-to-end batch mode functionality' and 'batch mode state isolation
      between executions') pass individually but fail when run as part of the
      full `bun test` suite."
    done: true
    description: >-
      The two batch mode integration tests ('end-to-end batch mode
      functionality' and 'batch mode state isolation between executions') pass
      individually but fail when run as part of the full `bun test` suite. The
      test mocks were updated in this migration (changing `spawnAndLogOutput` to
      `spawnWithStreamingIO`, adding missing mock functions), but the tests
      still time out when other test files run first. This indicates a test
      isolation issue likely related to the singleton database or module mock
      contamination from earlier test files.


      Suggestion: Investigate whether `closeDatabaseForTesting()` is being
      called properly in the test's afterEach/afterAll, or whether another test
      file is leaving state that interferes with the module mocking.


      Related file: src/tim/batch_mode_integration.test.ts:42-380
  - title: "Address Review Feedback: The `resolveExternalConfig()` method calls
      `getOrCreateProject()` (which sets all fields on creation via INSERT OR
      IGNORE) and then unconditionally calls `updateProject()` with the exact
      same values."
    done: true
    description: >-
      The `resolveExternalConfig()` method calls `getOrCreateProject()` (which
      sets all fields on creation via INSERT OR IGNORE) and then unconditionally
      calls `updateProject()` with the exact same values. This means every
      external config resolution performs two DB transactions when at most one
      is needed. When the project already exists and values haven't changed, the
      `updateProject` still updates `updated_at` to the current time, making it
      appear the project was modified when it wasn't.


      Suggestion: Wrap the `updateProject` call in a guard that checks whether
      the existing project fields differ from the new values, or accept the
      inefficiency and add a comment explaining the trade-off.


      Related file: src/tim/repository_config_resolver.ts:108-121
  - title: "Address Review Feedback: `WorkspaceLock.isLockStale` doesn't handle
      invalid date strings."
    done: true
    description: >-
      `WorkspaceLock.isLockStale` doesn't handle invalid date strings. It
      computes `Date.now() - new Date(lockInfo.startedAt).getTime()`. If
      `startedAt` is an invalid date string, `new Date(invalid).getTime()`
      returns `NaN`, making `lockAge` = `NaN`. Since `NaN >
      this.STALE_LOCK_TIMEOUT_MS` is `false`, the method incorrectly reports the
      lock as NOT stale. In contrast, `db/workspace_lock.ts:51-54` correctly
      handles this case with `if (!Number.isFinite(startedAtMs)) { return true;
      }`, treating invalid dates as stale. This inconsistency means a lock with
      a corrupted started_at value would be treated differently depending on
      which code path is used.


      Suggestion: Add an isFinite check to match the DB layer behavior: `const
      lockAge = Date.now() - new Date(lockInfo.startedAt).getTime(); if
      (!Number.isFinite(lockAge)) { return true; }`


      Related file: src/tim/workspace/workspace_lock.ts:190
  - title: "Address Review Feedback: In json_import.ts, the first-loop
      `updateProject` call at lines 308-315 is redundant with the second loop at
      lines 349-357."
    done: true
    description: >-
      In json_import.ts, the first-loop `updateProject` call at lines 308-315 is
      redundant with the second loop at lines 349-357. Even with the `if
      (repositoryData)` guard, both loops write the exact same project metadata
      fields. The second loop handles all repository data processing with a
      proper guard, making the first loop's updateProject unnecessary.


      Suggestion: Remove lines 308-315 entirely, since the second loop at lines
      336-357 handles all project metadata updates.


      Related file: src/tim/db/json_import.ts:308-315
  - title: "Address Review Feedback: `getLockInfo` and `isLocked` have subtly
      different stale lock release behavior."
    done: true
    description: >-
      `getLockInfo` and `isLocked` have subtly different stale lock release
      behavior. `getLockInfo` uses `releaseWorkspaceLock(db, workspaceId, {
      force: true })` (a direct DB call), while `isLocked` uses `await
      this.releaseLock(workspacePath, { force: true })` (a higher-level call
      that also unregisters cleanup handlers). This means stale lock cleanup
      from `getLockInfo` leaves orphaned cleanup handlers in the
      `cleanupHandlersByWorkspace` Map.


      Suggestion: Use the same release path in both methods — either both use
      the higher-level `releaseLock` or both use the lower-level DB call with
      explicit handler cleanup.


      Related file: src/tim/workspace/workspace_lock.ts:155-157
  - title: "Address Review Feedback: The `SQL_NOW_ISO_UTC` string constant
      (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`) is duplicated across 4 files:
      db/assignment.ts, db/project.ts, db/workspace.ts, and
      db/workspace_lock.ts."
    done: true
    description: >-
      The `SQL_NOW_ISO_UTC` string constant
      (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`) is duplicated across 4 files:
      db/assignment.ts, db/project.ts, db/workspace.ts, and
      db/workspace_lock.ts. Consolidating into a single shared import would
      reduce drift risk if the format ever needs to change. This is a
      pre-existing pattern from plan 191.


      Suggestion: Extract SQL_NOW_ISO_UTC into a shared db utilities module and
      import from there.


      Related file: src/tim/db/assignment.ts:5
  - title: "Address Review Feedback: Pre-existing bug remains: commit message
      template contains an extra `}` in parent completion commit message."
    done: true
    description: >-
      Pre-existing bug remains: commit message template contains an extra `}` in
      parent completion commit message.


      Suggestion: Change to `await commitAll(`Mark plan${title} as done (ID:
      ${parentPlan.id})`, baseDir);`.


      Related file: src/tim/plans/mark_done.ts:145
changedFiles:
  - CHANGELOG.md
  - CLAUDE.md
  - README.md
  - docs/database.md
  - docs/multi-workspace-workflow.md
  - docs/parent-child-relationships.md
  - docs/testing.md
  - src/tim/assignments/auto_claim.test.ts
  - src/tim/assignments/auto_claim.ts
  - src/tim/assignments/claim_plan.ts
  - src/tim/assignments/release_plan.ts
  - src/tim/assignments/remove_plan_assignment.ts
  - src/tim/assignments/stale_detection.test.ts
  - src/tim/assignments/stale_detection.ts
  - src/tim/batch_mode_integration.test.ts
  - src/tim/commands/add.test.ts
  - src/tim/commands/agent/agent.test.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/agent/agent.workspace_description.test.ts
  - src/tim/commands/agent/parent_completion.test.ts
  - src/tim/commands/agent/parent_plans.ts
  - src/tim/commands/assignments.test.ts
  - src/tim/commands/assignments.ts
  - src/tim/commands/claim.test.ts
  - src/tim/commands/import/import.ts
  - src/tim/commands/integration.test.ts
  - src/tim/commands/list.test.ts
  - src/tim/commands/list.ts
  - src/tim/commands/ready.test.ts
  - src/tim/commands/ready.ts
  - src/tim/commands/release.test.ts
  - src/tim/commands/remove.ts
  - src/tim/commands/renumber.ts
  - src/tim/commands/set.test.ts
  - src/tim/commands/set.ts
  - src/tim/commands/show.test.ts
  - src/tim/commands/show.ts
  - src/tim/commands/storage.test.ts
  - src/tim/commands/storage.ts
  - src/tim/commands/subagent.test.ts
  - src/tim/commands/task-management.integration.test.ts
  - src/tim/commands/workspace.claim.test.ts
  - src/tim/commands/workspace.list.test.ts
  - src/tim/commands/workspace.lock.test.ts
  - src/tim/commands/workspace.reuse.test.ts
  - src/tim/commands/workspace.ts
  - src/tim/commands/workspace.update.test.ts
  - src/tim/configLoader.test.ts
  - src/tim/db/assignment.test.ts
  - src/tim/db/assignment.ts
  - src/tim/db/json_import.test.ts
  - src/tim/db/json_import.ts
  - src/tim/db/migrations.ts
  - src/tim/db/project.test.ts
  - src/tim/db/project.ts
  - src/tim/db/sql_utils.ts
  - src/tim/db/workspace.test.ts
  - src/tim/db/workspace.ts
  - src/tim/db/workspace_lock.test.ts
  - src/tim/db/workspace_lock.ts
  - src/tim/executors/claude_code/run_claude_subprocess.permissions_db.test.ts
  - src/tim/executors/claude_code/run_claude_subprocess.ts
  - src/tim/executors/claude_code.ts
  - src/tim/external_storage_utils.ts
  - src/tim/id_utils.test.ts
  - src/tim/id_utils.ts
  - src/tim/plans/mark_done.ts
  - src/tim/plans/plan_state_utils.test.ts
  - src/tim/plans/plan_state_utils.ts
  - src/tim/repository_config_resolver.test.ts
  - src/tim/repository_config_resolver.ts
  - src/tim/resolvePlanFile.external.test.ts
  - src/tim/storage/storage_manager.test.ts
  - src/tim/storage/storage_manager.ts
  - src/tim/tags.integration.test.ts
  - src/tim/tim.ts
  - src/tim/workspace/workspace_auto_selector.test.ts
  - src/tim/workspace/workspace_auto_selector.ts
  - src/tim/workspace/workspace_info.ts
  - src/tim/workspace/workspace_lock.test.ts
  - src/tim/workspace/workspace_lock.ts
  - src/tim/workspace/workspace_manager.test.ts
  - src/tim/workspace/workspace_manager.ts
  - test-preload.ts
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

## Current Progress
### Current State
- All 23 tasks complete. Full migration from JSON I/O to SQLite is done, all review feedback addressed.
- 3078 tests pass, type checker passes, code formatted, build succeeds.

### Completed (So Far)
- Task 1: Migrated assignment callers (claim_plan.ts, release_plan.ts, auto_claim.ts, commands/assignments.ts, commands/ready.ts, commands/renumber.ts, id_utils.ts) to use DB functions
- Task 2: Migrated permission callers (executors/claude_code.ts, run_claude_subprocess.ts) to use DB functions
- Task 3: Migrated workspace callers (workspace_manager.ts, workspace_auto_selector.ts, commands/workspace.ts, commands/agent/agent.ts) to use DB functions
- Task 4: Refactored WorkspaceLock to use DB internally while keeping same static API
- Task 5: Migrated repository metadata callers (external_storage_utils.ts, storage_manager.ts, repository_config_resolver.ts) to use DB functions. Also migrated missed assignment callers (remove.ts, set.ts, parent_plans.ts, mark_done.ts, import.ts, list.ts, show.ts).
- Task 6: Updated all tests to use DB-backed implementations. Removed deprecated test files (assignments_io.test.ts, permissions_io.test.ts, workspace_tracker.test.ts). Updated mocks in subagent.test.ts, agent.test.ts, workspace_manager.test.ts. Migrated workspace lock tests to DB-only (removed setTestLockDirectory usage).
- Task 7: Removed deprecated files: assignments_io.ts, permissions_io.ts, assignments_schema.ts, permissions_schema.ts, workspace_tracker.ts. Moved AssignmentEntry type to db/assignment.ts. Inlined permissions schema into json_import.ts. Removed file-based compatibility codepaths from WorkspaceLock. Consolidated isProcessAlive to shared sync version in db/workspace_lock.ts. Fixed storage clean to update DB state. Fixed collectExternalStorageDirectories to only include projects with external_config_path or external_tasks_dir set.
- Task 8: Final validation — all tests pass, type checker clean, formatter clean, build succeeds. README and docs already updated in prior tasks to reference SQLite storage.
- Consolidated normalizePlanStatus into src/tim/plans/plan_state_utils.ts (was duplicated in 4 files)
- Consolidated assignment-to-AssignmentEntry conversion into shared DB helpers in db/assignment.ts
- Created src/tim/workspace/workspace_info.ts as shared module for WorkspaceInfo, WorkspaceMetadataPatch, workspaceRowToInfo(), patchWorkspaceInfo(), and workspace lookup helpers
- Added listAllWorkspaces() to db/workspace.ts
- Added getProjectByRepositoryId() helper to db/project.ts for repositoryId → project_id resolution
- Added clearExternalStoragePaths() to db/project.ts for storage cleanup
- WorkspaceLock: stale locks now cleaned up on read (getLockInfo, isLocked)
- WorkspaceLock: cleanup handlers properly unregistered on releaseLock (no more listener leak)
- WorkspaceAutoSelector: stale-lock handling is now lazy (only evaluated when no unlocked workspace available)
- Removed per-command JSON re-import from workspace commands (was overwriting DB state)
- External storage base dir now uses getTimConfigRoot() for XDG/APPDATA consistency
- Task 9: Fixed TOCTOU race in cleanStaleLocks — DELETE now matches workspace_id + pid + started_at to avoid deleting replacement locks
- Task 10: collectExternalStorageDirectories now skips entries where repositoryPath doesn't exist on disk
- Task 11: Assignment re-claim test now uses 'done' status instead of 'in_progress' to actually validate ON CONFLICT preservation
- Task 12: JSON import updateProject call guarded with `if (repositoryData)` to prevent null-overwriting valid metadata
- Task 13: Removed dead STORAGE_METADATA_FILENAME export from external_storage_utils.ts
- Task 14: Extracted shared removePlanAssignment into src/tim/assignments/remove_plan_assignment.ts. Updated mark_done.ts, parent_plans.ts, set.ts, and remove.ts to use the shared function.
- Task 15: Unified parent completion logic — both checkAndMarkParentDone implementations (parent_plans.ts and mark_done.ts) now accept 'done' or 'cancelled' as complete states. Also fixed: set.ts now triggers parent completion on cancelled status, cancelled parents are preserved (not overwritten to done), changedFiles sorting is consistent, set.ts and remove.ts now pass baseDir consistently.

- Task 16: Fixed TOCTOU race in stale-lock cleanup on read — added `releaseSpecificWorkspaceLock()` in db/workspace_lock.ts that matches workspace_id + pid + started_at. Both `getLockInfoInternal()` and `isLocked()` now use targeted delete + explicit cleanup handler unregistration, unifying stale lock release behavior (also fixes Task 21).
- Task 19: Added `Number.isFinite(lockAge)` guard to `WorkspaceLock.isLockStale()` to treat invalid date strings as stale, matching the DB layer behavior.
- Task 20: Removed redundant `updateProject()` call from json_import.ts first loop (lines 308-315) since the second loop handles all project metadata updates.
- Task 21: Unified stale lock release behavior — both `getLockInfoInternal` and `isLocked` now use the same approach: targeted DB delete + explicit cleanup handler unregistration (implemented together with Task 16).
- Task 22: Extracted `SQL_NOW_ISO_UTC` into shared `src/tim/db/sql_utils.ts`. Updated all 6 consumers (assignment.ts, project.ts, workspace.ts, workspace_lock.ts, json_import.ts, migrations.ts) to import from the shared module.
- Task 23: Fixed extra `}` in parent completion commit message template in mark_done.ts.
- Task 17: Batch mode integration tests now pass in full suite. The original mock updates (spawnAndLogOutput → spawnWithStreamingIO) from Task 6 resolved the core issue. Added closeDatabaseForTesting() and XDG_CONFIG_HOME isolation to batch_mode_integration.test.ts for robustness.
- Task 18: resolveExternalConfig() now compares existing project fields against new values before calling updateProject(). Skips the update when all fields match, avoiding unnecessary updated_at bumps. Added regression test verifying timestamp stability on repeated resolution.

### Remaining
- None

### Next Iteration Guidance
- claimPlan/releasePlan are still async; making them sync was deferred but should be considered for a follow-up cleanup
- The two checkAndMarkParentDone implementations (parent_plans.ts and mark_done.ts) remain duplicated due to circular dependency constraints. Consider extracting shared core logic with callbacks for output differences (sendStructured vs log).
- Review found a major issue: re-claiming with undefined plan ID clears existing plan_id to NULL (pre-existing issue in claim_plan.ts/assignment.ts)
- Review found a critical issue: legacy workspace locks are not imported during JSON→SQLite migration (pre-existing issue in json_import.ts)
- Review found: `paths.trackingFile` config option is now dead code since workspace storage is DB-backed

### Decisions / Changes
- Assignment model changed from multi-workspace (workspacePaths[]) to single workspace (workspace_id FK) per the DB schema design
- claimPlan now auto-creates workspace rows via recordWorkspace when needed
- Assignment status on claim is 'in_progress' (not 'claimed') to align with plan status schema
- Re-claiming preserves existing assignment status (doesn't overwrite)
- Release only clears claimed_by_user when workspace matches (non-owning workspace release is a no-op)
- Claim warnings now say "reassigning" instead of implying coexistence of multiple workspace claims
- Created workspace_info.ts as shared module to consolidate WorkspaceInfo types and conversion helpers (was duplicated across 4 files). This replaces workspace_tracker.ts as the canonical source for workspace types/helpers.
- Stale lock cleanup happens on read (getLockInfo/isLocked) not just on acquisition
- WorkspaceAutoSelector evaluates stale locks lazily - only when no unlocked workspace is available
- AssignmentEntry type moved from assignments_schema.ts to db/assignment.ts (canonical source)
- Permissions schema inlined into json_import.ts (only consumer after migration)
- Storage listing filters on explicit external-storage markers (external_config_path/external_tasks_dir), not last_git_root
- Storage clean now clears DB external storage fields in addition to deleting filesystem directories
- External storage base dir uses getTimConfigRoot() instead of hardcoded ~/.config/tim
- Parent completion treats both 'done' and 'cancelled' children as complete (unified across agent and CLI paths)
- Cancelled parents are preserved — child completion doesn't overwrite a cancelled parent to done

### Lessons Learned
- recordWorkspace's ON CONFLICT DO UPDATE can null out existing fields when called with sparse input. Using COALESCE(excluded.col, col) prevents this race condition in concurrent multi-process usage.
- SQLite datetime('now') produces local-time-ambiguous format. Always use strftime('%Y-%m-%dT%H:%M:%fZ','now') for ISO-8601 UTC timestamps.
- When migrating from multi-value arrays (workspacePaths[]) to single FK (workspace_id), warning/conflict logic that assumed multiple values must be updated - dead code paths like show-conflicts become permanently false.
- The undefined !== null distinction matters in TypeScript: existing?.field evaluates to undefined when existing is null, but undefined !== null is true. Use explicit !created guards for new-record checks.
- Claim/release semantics need careful ordering: warnings must be generated AFTER determining whether an actual change will be persisted, not before.
- When migrating callers that use conversion helpers (e.g., workspaceRowToInfo), consolidate shared code into a dedicated module early to prevent drift between copies. The implementer initially duplicated helpers across 4 files, causing a repositoryId guard inconsistency between workspace.ts and agent.ts.
- Re-importing legacy JSON on every command invocation can overwrite newer DB state. One-time migration on DB creation is sufficient.
- Process event listeners (exit, SIGINT, etc.) must be properly unregistered on cleanup, not just tracked in a set. Store function references in a Map keyed by identifier so they can be removed with process.off().
- Stale-lock enrichment should be lazy in selection flows - enriching all workspaces eagerly can trigger unnecessary prompts/cleanup when an unlocked workspace is available.
- When migrating data source from filesystem scanning to DB queries for listing, ensure cleanup operations also update DB state — otherwise deleted entries reappear in listings.
- Filter criteria for DB-backed listings must not use fields that are set by unrelated operations (e.g., last_git_root is set by workspace/lock flows but shouldn't make a project appear in external storage listings).
- Schema files that export types used by many callers need careful migration: move types to the new canonical location (e.g., db/assignment.ts) and update all importers before removing the old file.
- When unifying behavior across multiple code paths (e.g., accepting 'cancelled' as complete), audit all call sites that guard entry into the unified function — not just the function body. The set.ts guard was initially missed.
- When a status check uses early-return for terminal states, consider all terminal states (done, cancelled) to prevent one from being overwritten by another.
- Order matters: parent completion checks must run after writing the child's updated status, otherwise the check reads stale data.
- Tests using module mocking that touch DB-dependent code paths need closeDatabaseForTesting() and XDG_CONFIG_HOME isolation even when the test itself doesn't directly use the DB — transitive calls (e.g., loadSharedPermissions via executor.execute) can initialize the singleton and leak state to subsequent tests.
- When a function calls getOrCreateProject() then updateProject() with the same values, the redundant update silently bumps updated_at, making it look like the project was modified. Field-by-field comparison before updating avoids this.

### Risks / Blockers
- None
