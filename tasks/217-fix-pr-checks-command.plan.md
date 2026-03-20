---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: workspace tagging for auto mode
goal: ""
id: 217
uuid: 9c2ce79a-286c-459c-9d75-a1b5fa60ece4
generatedBy: agent
status: in_progress
priority: medium
planGeneratedAt: 2026-03-07T08:42:06.542Z
promptsGeneratedAt: 2026-03-07T08:42:06.542Z
createdAt: 2026-03-07T02:47:09.372Z
updatedAt: 2026-03-20T21:30:27.402Z
tasks:
  - title: Add DB migration to rename is_primary to workspace_type
    done: true
    description: Add migration version 7 to src/tim/db/migrations.ts with ALTER
      TABLE workspace RENAME COLUMN is_primary TO workspace_type. Existing
      values (0=standard, 1=primary) are preserved.
  - title: Define WorkspaceType and update DB layer
    done: true
    description: >-
      In src/tim/db/workspace.ts:

      1. Define WorkspaceType type: 'standard' | 'primary' | 'auto'

      2. Add mapping constants WORKSPACE_TYPE_VALUES = { standard: 0, primary:
      1, auto: 2 } and reverse map

      3. Rename is_primary to workspace_type in WorkspaceRow

      4. Add optional workspaceType to RecordWorkspaceInput and update
      recordWorkspace() INSERT

      5. Replace isPrimary with workspaceType in PatchWorkspaceInput

      6. Update patchWorkspace() to handle workspaceType using the mapping
  - title: Update WorkspaceInfo types and helpers
    done: true
    description: >-
      In src/tim/workspace/workspace_info.ts:

      1. Import WorkspaceType from DB layer

      2. Replace isPrimary?: boolean with workspaceType: WorkspaceType in
      WorkspaceInfo (required, default 'standard')

      3. Replace isPrimary?: boolean with workspaceType?: WorkspaceType in
      WorkspaceMetadataPatch

      4. Update workspaceRowToInfo() to map integer to WorkspaceType string

      5. Update findPrimaryWorkspaceForRepository() to check workspaceType ===
      'primary'

      6. Update patchWorkspaceInfo() to pass through workspaceType
  - title: Update auto-selection logic with workspace type filtering
    done: true
    description: >-
      In src/tim/workspace/workspace_auto_selector.ts:

      1. After fetching allWorkspaces, check if any have workspaceType ===
      'auto'

      2. If auto workspaces exist: filter to only workspaceType === 'auto'

      3. If no auto workspaces: filter to exclude workspaceType === 'primary'
      (preserving current behavior)

      4. When creating a new workspace because all auto workspaces are locked,
      auto-tag the new workspace as 'auto'

      5. Update createWorkspace calls to pass workspaceType through
  - title: Update workspace_manager.ts to accept workspaceType
    done: true
    description: Update createWorkspace() in src/tim/workspace/workspace_manager.ts
      to accept an optional workspaceType parameter and pass it through to
      recordWorkspace().
  - title: Update workspace commands (workspace.ts)
    done: true
    description: >-
      In src/tim/commands/workspace.ts:

      1. Replace isPrimary in WorkspaceListEntry interface with workspaceType:
      WorkspaceType

      2. Update display logic: show 'Primary' for primary, 'Auto' for auto,
      leave others as Available/Locked

      3. Update reuse filtering: only allow workspaceType === 'standard'
      (exclude both primary and auto)

      4. Update lock-available filtering: only allow workspaceType ===
      'standard'

      5. Update handleWorkspaceUpdateCommand to handle --primary/--no-primary
      and --auto/--no-auto, setting workspaceType appropriately

      6. Update handleWorkspaceAddCommand to accept --auto/--primary and pass
      workspaceType to createWorkspace
  - title: Update CLI options in tim.ts
    done: true
    description: >-
      In src/tim/tim.ts:

      1. Keep --primary/--no-primary on workspace update

      2. Add --auto/--no-auto on workspace update

      3. Add --auto and --primary flags on workspace add

      4. Add mutual exclusivity check: error if both --primary and --auto passed
      together

      5. --no-primary and --no-auto both set type to standard

      6. Update help text to describe all workspace types
  - title: Update roundtrip sync
    done: true
    description: "In src/tim/workspace/workspace_roundtrip.ts: update the check to
      use workspaceType === 'primary' instead of isPrimary."
  - title: Update existing tests for workspace_type rename
    done: true
    description: >-
      Update all existing tests that reference is_primary or isPrimary:

      1. workspace_auto_selector.test.ts: change is_primary = 1 to
      workspace_type = 1

      2. workspace.update.test.ts: update tests for the new type system

      3. workspace.push.test.ts: update test helpers using isPrimary to use
      workspaceType
  - title: Add new tests for auto workspace selection behavior
    done: true
    description: >-
      Add new tests in workspace_auto_selector.test.ts:

      1. No auto workspaces exist: all non-primary workspaces eligible (current
      behavior preserved)

      2. Some auto workspaces exist: only auto workspaces eligible

      3. All auto workspaces locked: creates new workspace auto-tagged as auto

      4. Mix of standard, primary, and auto: only auto workspaces selected

      5. Test reuse and lock-available filtering excludes both primary and auto
  - title: Update README with workspace type documentation
    done: false
    description: "Update README to document the workspace type system: standard,
      primary, and auto types; CLI flags --primary/--auto on workspace add and
      update; behavior of auto-selection when auto workspaces exist."
changedFiles:
  - CLAUDE.md
  - README.md
  - docs/multi-workspace-workflow.md
  - docs/web-interface.md
  - src/common/git.test.ts
  - src/common/git.ts
  - src/lib/components/MessageInput.svelte
  - src/lib/components/WorkspaceBadge.svelte
  - src/lib/components/WorkspaceRow.svelte
  - src/lib/server/db_queries.test.ts
  - src/lib/server/db_queries.ts
  - src/lib/server/session_manager.test.ts
  - src/logging/headless_adapter.test.ts
  - src/logging/headless_adapter.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/generate.test.ts
  - src/tim/commands/generate.ts
  - src/tim/commands/workspace.bookmark.test.ts
  - src/tim/commands/workspace.lock.test.ts
  - src/tim/commands/workspace.pull-plan.test.ts
  - src/tim/commands/workspace.push.test.ts
  - src/tim/commands/workspace.reuse.test.ts
  - src/tim/commands/workspace.ts
  - src/tim/commands/workspace.update.test.ts
  - src/tim/db/database.test.ts
  - src/tim/db/json_import.ts
  - src/tim/db/migrations.ts
  - src/tim/db/workspace.ts
  - src/tim/headless.test.ts
  - src/tim/headless.ts
  - src/tim/tim.ts
  - src/tim/workspace/workspace_auto_selector.test.ts
  - src/tim/workspace/workspace_auto_selector.ts
  - src/tim/workspace/workspace_info.ts
  - src/tim/workspace/workspace_manager.test.ts
  - src/tim/workspace/workspace_manager.ts
  - src/tim/workspace/workspace_roundtrip.test.ts
  - src/tim/workspace/workspace_roundtrip.ts
  - src/tim/workspace/workspace_setup.test.ts
  - src/tim/workspace/workspace_setup.ts
tags: []
---

Ability to tag workspaces as auto workspaces or not.
When at least one workspace is tagged as auto, anything that needs to automatically choose a workspace can only choose from the set of auto workspaces.

We can rename the is_primary column for this to workspace_type:
- 0 standard
- 1 primary
- 2 auto

This should allow the current values to persist without needing to be changed.

## Research

### Overview

This feature introduces a `workspace_type` classification system to replace the current boolean `is_primary` column. The goal is to allow workspaces to be tagged as "auto" workspaces, so that when at least one auto workspace exists for a repository, auto-selection logic restricts itself to only those workspaces instead of choosing from all non-primary workspaces.

### Key Findings

**Product & User Story**

A user with many workspaces wants to designate a subset as the "auto pool" — the set of workspaces that automated commands (`--auto-workspace`) can select from. Currently, the only workspace-level distinction is "primary" (excluded from auto-selection and used as push/pull targets). This feature adds a third type, "auto", which opts a workspace *into* the auto pool. When no workspaces are tagged as auto, the current behavior persists (all non-primary workspaces are eligible). When at least one is tagged auto, only auto workspaces are considered.

**Design & UX Approach**

- The `is_primary` column (INTEGER, 0 or 1) is renamed to `workspace_type` (INTEGER, 0/1/2).
- Existing values (0 = standard, 1 = primary) are preserved without migration of data — the rename is purely a schema change.
- CLI: The `--primary`/`--no-primary` flags on `tim workspace update` need to be augmented with `--auto`/`--no-auto` (or a `--type` option).
- Display: Workspace listing should show the type (Standard/Primary/Auto) in the status column.

**Technical Plan & Risks**

- The column rename requires a new DB migration (version 7). SQLite supports `ALTER TABLE RENAME COLUMN`.
- All code referencing `is_primary` or `isPrimary` must be updated to use `workspace_type` / `workspaceType`.
- The filtering logic in `workspace_auto_selector.ts`, `workspace.ts` (reuse and lock-available), and `workspace_roundtrip.ts` all currently check `isPrimary` and need to be updated to understand the three-valued type.
- The critical behavioral change: the auto-selector must check if any auto-tagged workspaces exist for the repository, and if so, restrict selection to only those.
- Risk: If the user sets all workspaces to "auto" or "primary", there are no "standard" workspaces left. This is fine — standard workspaces simply aren't preferred for auto-selection when auto workspaces exist.

**Pragmatic Effort Estimate**

This is a focused, well-scoped change touching ~8-10 files with a clear migration path. The core logic change is small (filtering predicate). Most of the work is mechanical renaming and updating CLI options/display.

### Detailed File Analysis

#### Database Layer

**`src/tim/db/migrations.ts`** — Current latest migration is version 6. A new version 7 migration will rename `is_primary` to `workspace_type` using `ALTER TABLE workspace RENAME COLUMN is_primary TO workspace_type`.

**`src/tim/db/workspace.ts`** — Contains `WorkspaceRow` interface with `is_primary: number` field, and `PatchWorkspaceInput` with `isPrimary?: boolean`. The `patchWorkspace()` function has explicit handling at lines 169-171:
```typescript
if ('isPrimary' in nextPatch) {
  fields.push('is_primary = ?');
  values.push(nextPatch.isPrimary ? 1 : 0);
}
```
This needs to change to `workspace_type` with the new type values.

#### Workspace Info Layer

**`src/tim/workspace/workspace_info.ts`** — Contains:
- `WorkspaceInfo` interface with `isPrimary?: boolean` (line 36)
- `WorkspaceMetadataPatch` interface with `isPrimary?: boolean` (line 48)
- `workspaceRowToInfo()` conversion at line 71: `isPrimary: row.is_primary === 1 ? true : undefined`
- `findPrimaryWorkspaceForRepository()` at line 99-102
- `patchWorkspaceInfo()` at lines 136-137

All of these need updating to use a `workspaceType` field with a proper enum/type.

#### Auto-Selection Logic

**`src/tim/workspace/workspace_auto_selector.ts`** — The critical file. Line 92:
```typescript
const workspaces = allWorkspaces.filter((workspace) => !workspace.isPrimary);
```
This is where the core behavioral change happens. The new logic should be:
1. Check if any workspace in `allWorkspaces` has `workspaceType === 'auto'`
2. If yes: filter to only `workspaceType === 'auto'` workspaces
3. If no: filter to exclude `workspaceType === 'primary'` (current behavior for standard + auto)

#### Workspace Commands

**`src/tim/commands/workspace.ts`** — Multiple locations:
- Line 77: `isPrimary?: boolean` in `WorkspaceListEntry`
- Line 170: copying `isPrimary` to list entry
- Line 387-388: Display logic showing "Primary" status
- Line 755: Filtering for reuse — `!workspace.isPrimary`
- Line 1458: Lock-available filtering — `!workspace.isPrimary`
- Lines 1896-1921: Update command handling `--primary` option

#### CLI Definition

**`src/tim/tim.ts`** — Lines 1300-1301:
```
.option('--primary', 'Mark this workspace as primary (excluded from auto-selection)')
.option('--no-primary', 'Remove primary designation from this workspace')
```

#### Roundtrip Sync

**`src/tim/workspace/workspace_roundtrip.ts`** — Line 33: `if (!workspaceInfo || workspaceInfo.isPrimary)` — primary workspaces are skipped from sync. This should continue to skip primary but allow auto workspaces.

#### Test Files

- `src/tim/workspace/workspace_auto_selector.test.ts` — Tests that set `is_primary = 1` directly in DB (lines 285, 307)
- `src/tim/commands/workspace.update.test.ts` — Tests for setting/unsetting primary (lines 345, 357, 372)
- `src/tim/commands/workspace.push.test.ts` — Tests using `isPrimary: true` in test helpers (multiple locations)

### Existing Patterns & Conventions

- The `WorkspaceInfo` interface uses optional fields (`isPrimary?: boolean` where `undefined` means false/standard). The new `workspaceType` should follow a similar pattern but use a string union or numeric enum.
- DB stores as integer, TypeScript uses semantic types. The conversion happens in `workspaceRowToInfo()`.
- Config schema uses zod but workspace types are not in config — they're per-workspace DB metadata.
- CLI options use `--flag`/`--no-flag` pattern for boolean toggles.

### TypeScript Type Design

A good approach is to define:
```typescript
export type WorkspaceType = 'standard' | 'primary' | 'auto';
```
And map to/from the DB integer values (0, 1, 2) in the conversion functions. The `WorkspaceInfo` interface replaces `isPrimary?: boolean` with `workspaceType: WorkspaceType` (always present, defaults to 'standard').

## Implementation Guide

### Step 1: Add DB Migration

Add migration version 7 to `src/tim/db/migrations.ts`:
```sql
ALTER TABLE workspace RENAME COLUMN is_primary TO workspace_type;
```
This is a simple column rename. Existing values (0 and 1) are preserved.

### Step 2: Define WorkspaceType and Update DB Layer

In `src/tim/db/workspace.ts`:
1. Define `WorkspaceType` type: `'standard' | 'primary' | 'auto'`
2. Add mapping constants: `WORKSPACE_TYPE_VALUES = { standard: 0, primary: 1, auto: 2 }` and reverse map
3. Rename `is_primary` to `workspace_type` in `WorkspaceRow`
4. Add optional `workspaceType?: WorkspaceType` to `RecordWorkspaceInput` so type can be set at creation time
5. Update `recordWorkspace()` to include `workspace_type` in the INSERT when provided
6. Replace `isPrimary?: boolean` with `workspaceType?: WorkspaceType` in `PatchWorkspaceInput`
7. Update `patchWorkspace()` to handle `workspaceType` field using the mapping

### Step 3: Update WorkspaceInfo Types

In `src/tim/workspace/workspace_info.ts`:
1. Import `WorkspaceType` from the DB layer (or define it in a shared location)
2. Replace `isPrimary?: boolean` with `workspaceType: WorkspaceType` in `WorkspaceInfo` (make it non-optional with default 'standard')
3. Replace `isPrimary?: boolean` with `workspaceType?: WorkspaceType` in `WorkspaceMetadataPatch`
4. Update `workspaceRowToInfo()` to map integer to WorkspaceType string
5. Update `findPrimaryWorkspaceForRepository()` to check `workspaceType === 'primary'`
6. Update `patchWorkspaceInfo()` to pass through `workspaceType`

### Step 4: Update Auto-Selection Logic

In `src/tim/workspace/workspace_auto_selector.ts`:
1. After fetching `allWorkspaces`, check if any have `workspaceType === 'auto'`
2. If auto workspaces exist: filter to only `workspaceType === 'auto'`
3. If no auto workspaces: filter to exclude `workspaceType === 'primary'` (preserving current behavior)
4. When creating a new workspace because all auto workspaces are locked, auto-tag the new workspace as `auto` (so it's eligible for future auto-selection)
5. This is the key behavioral change — approximately 5-10 lines of code

### Step 5: Update Workspace Commands

In `src/tim/commands/workspace.ts`:
1. Replace `isPrimary` references in `WorkspaceListEntry` interface and mapping with `workspaceType`
2. Update display logic (line 387): show 'Primary' for primary, 'Auto' for auto, leave others as Available/Locked
3. Update reuse filtering (line 755): only allow `workspaceType === 'standard'` (exclude both primary and auto)
4. Update lock-available filtering (line 1458): only allow `workspaceType === 'standard'` (exclude both primary and auto)
5. Update the update command handler (lines 1896-1921) to handle the new type options
6. Update `handleWorkspaceAddCommand()` to accept `--auto`/`--primary` flags and pass `workspaceType` through to `createWorkspace()` → `recordWorkspace()`
7. Update `createWorkspace()` in `workspace_manager.ts` to accept and pass through an optional `workspaceType` parameter

### Step 6: Update CLI Options

In `src/tim/tim.ts`:
1. Keep `--primary`/`--no-primary` and add `--auto`/`--no-auto` flags on `workspace update`
2. Add `--auto` and `--primary` flags on `workspace add` as well
3. Error if both `--primary` and `--auto` are passed together (mutually exclusive)
4. `--no-primary` and `--no-auto` both set workspace type to `standard`
5. Update help text to describe all workspace types
6. Handle the CLI options in both update and add command handlers to set appropriate `workspaceType`

### Step 7: Update Roundtrip Sync

In `src/tim/workspace/workspace_roundtrip.ts`:
1. Update the check at line 33 to use `workspaceType === 'primary'` instead of `isPrimary`

### Step 8: Update Tests

1. `workspace_auto_selector.test.ts`: Update tests setting `is_primary = 1` to use `workspace_type = 1`, add new tests for auto workspace filtering behavior
2. `workspace.update.test.ts`: Update tests for the new type system, add tests for setting auto type
3. `workspace.push.test.ts`: Update test helpers using `isPrimary` to use `workspaceType`
4. Add new tests specifically for the "when auto workspaces exist, restrict to auto" behavior

### Key Test Scenarios for Auto Workspace Selection

1. **No auto workspaces exist**: All non-primary workspaces are eligible (current behavior preserved)
2. **Some auto workspaces exist**: Only auto workspaces are eligible for auto-selection
3. **All auto workspaces locked**: Creates new workspace (should it be auto-tagged?)
4. **Mix of standard, primary, and auto**: Only auto workspaces selected
5. **Primary workspace with auto tag**: Not possible (mutually exclusive types)

### Manual Testing Steps

1. Create several workspaces: `tim workspace add`
2. Mark one as auto: `tim workspace update <id> --auto`
3. Verify `tim workspace list` shows "Auto" status
4. Run `tim agent <plan> --auto-workspace` and verify it picks from auto workspaces only
5. Remove all auto tags: verify it falls back to selecting any non-primary workspace
6. Mark one as primary, verify it's excluded from auto-selection as before

### Potential Gotchas

- **Newly created workspaces during auto-selection**: When all auto workspaces are locked and a new one is created, it should automatically be tagged as auto. Otherwise the new workspace won't be eligible for future auto-selection when auto workspaces exist.
- **Backward compatibility**: The `isPrimary` field is used in multiple interfaces. Need to ensure all callers are updated and no external consumers rely on it.
- **The `findPrimaryWorkspaceForRepository` function** is used by workspace manager and push commands. It must continue to work correctly with the new type system.
- **Workspace reuse and lock-available filtering**: Both manual operations (reuse and lock-available) should only consider standard workspaces, excluding both primary and auto. Auto workspaces are reserved for `--auto-workspace` selection only.

## Current Progress
### Current State
- All core implementation complete (Tasks 1-8). CLI layer complete (Tasks 6-7). All tests updated and new tests added (Tasks 9-10).
- 70+ workspace-related tests pass across 5 test files
- TypeScript compilation clean (only pre-existing errors in treesitter and review_runner)
### Completed (So Far)
- Task 1: DB migration v7 renaming is_primary to workspace_type
- Task 2: WorkspaceType type, mapping constants, DB layer updates
- Task 3: WorkspaceInfo types updated (workspaceType replaces isPrimary)
- Task 4: Auto-selection logic updated to prefer auto workspaces when they exist
- Task 5: workspace_manager.ts createWorkspace accepts workspaceType
- Task 6: Workspace commands updated — display shows Auto/Primary with lock status, reuse/lock-available filtering excludes auto and primary, add/update handlers support --auto/--primary with mutual exclusivity
- Task 7: CLI options in tim.ts updated — --auto/--no-auto on workspace update, --auto/--primary on workspace add, help text updated
- Task 8: Roundtrip sync updated to check workspaceType === 'primary'
- Task 9: All existing tests updated for workspace_type rename
- Task 10: New tests added for auto workspace selection, reuse filtering, lock-available filtering, add command type persistence, mutual exclusivity
- Also fixed: JSON import preserves legacy isPrimary and new workspaceType fields
- Also fixed: workspace add --reuse/--try-reuse now applies workspaceType to reused workspace via patchWorkspaceInfo
### Remaining
- Task 11: Update README with workspace type documentation
### Next Iteration Guidance
- Task 11 is the only remaining task — update README to document workspace types and CLI flags
### Decisions / Changes
- WorkspaceType exported from src/tim/db/workspace.ts as the canonical location
- workspaceType is required (not optional) on WorkspaceInfo with default 'standard'
- dbValueToWorkspaceType defaults unknown values to 'standard'
- JSON import now handles both legacy isPrimary:true and new workspaceType fields
- --no-primary and --no-auto both set type to 'standard' regardless of current type (by design per plan spec)
- resolveWorkspaceTypeOption() is a shared helper used by both add and update command handlers
- Workspace list display shows lock status for both primary and auto workspaces (e.g. "Auto (Locked)")
### Lessons Learned
- JSON import is a critical migration path that's easy to overlook — when changing DB schema, always check json_import.ts for legacy field handling
- When adding CLI flags to a command with multiple code paths (create vs reuse), verify the flag is honored on all paths — the reuse path silently dropped --auto/--primary until caught in review
- Test seed helpers should use production APIs (e.g. recordWorkspace with workspaceType param) rather than manual SQL UPDATEs to exercise the full code path
### Risks / Blockers
- None
