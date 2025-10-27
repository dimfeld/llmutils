---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add multi-user assignment and status tracking with shared config
goal: Enable multi-user workflows in rmplan by supporting user identity via
  environment variables and tracking both plan assignments and status in a
  shared configuration
id: 139
uuid: 8b82a7c6-2182-48b7-af3e-2be853519242
generatedBy: agent
status: in_progress
priority: high
container: false
temp: false
dependencies: []
issue: []
pullRequest: []
docs: []
planGeneratedAt: 2025-10-27T08:01:47.867Z
promptsGeneratedAt: 2025-10-27T08:01:47.867Z
createdAt: 2025-10-27T05:51:22.359Z
updatedAt: 2025-10-27T09:01:40.700Z
progressNotes:
  - timestamp: 2025-10-27T08:07:27.994Z
    text: Added optional uuid field to plan schema, generate/add stub assignments
      now create a UUID, and readPlanFile lazily persists UUIDs for legacy
      plans. Tests still pending.
    source: "implementer: Task 1"
  - timestamp: 2025-10-27T08:13:30.648Z
    text: "Added focused tests covering UUID generation: rmplan add and generate
      command outputs now assert UUID presence, and plans.test.ts verifies
      legacy plans receive and persist generated UUIDs."
    source: "implementer: Task 1"
  - timestamp: 2025-10-27T08:17:01.891Z
    text: Verified UUID-related unit tests (add, generate, plans) and TypeScript
      check all pass locally.
    source: "tester: Task 1"
  - timestamp: 2025-10-27T08:29:09.881Z
    text: Reviewed repository_config_resolver, workspace utilities, and existing
      atomic write patterns to align upcoming assignments schema/IO and
      workspace identification modules.
    source: "implementer: Tasks 2&3"
  - timestamp: 2025-10-27T08:33:29.635Z
    text: Implemented assignments schema and IO utilities with optimistic locking,
      atomic writes, and initial tests covering missing files, corruption, and
      version conflicts.
    source: "implementer: Task 2"
  - timestamp: 2025-10-27T08:36:15.352Z
    text: Added workspace identification utilities covering workspace path
      normalization, repository identity derivation, and user identity
      precedence along with comprehensive tests for symlink handling, remote
      parsing, and environment fallback.
    source: "implementer: Task 3"
  - timestamp: 2025-10-27T08:36:34.007Z
    text: Ran bun run check plus targeted tests for assignments IO and workspace
      identifier modules; all new suites pass.
    source: "tester: Tasks 2&3"
  - timestamp: 2025-10-27T08:39:41.676Z
    text: Full test run uncovered regressions in mark_done_set_task.test.ts and
      renumber.test.ts due to newly persisted plan UUID/updatedAt fields;
      targeting test updates to account for auto-generated metadata.
    source: "tester: tasks 2-3"
  - timestamp: 2025-10-27T08:43:31.484Z
    text: Updated regression tests to ignore auto-generated uuid/updatedAt metadata,
      adjusted renumber dry-run assertions to read via readPlanFile, and added a
      coverage test for repositoryId mismatches in assignments_io. Full suite
      and type check now pass.
    source: "tester: tasks 2-3"
  - timestamp: 2025-10-27T08:55:33.482Z
    text: Implemented uuid lookup utilities and tests covering cache fallback and
      resolvePlanWithUuid persistence.
    source: "implementer: Task 4"
  - timestamp: 2025-10-27T09:00:42.277Z
    text: Added claim command with shared claimPlan utility, repository/workspace
      detection, and tests for new claim scenarios and conflicts.
    source: "implementer: Task 5"
  - timestamp: 2025-10-27T09:01:09.306Z
    text: Ran bun run check and targeted tests for uuid_lookup and claim commands;
      all passing.
    source: "tester: Tasks 4-5"
tasks:
  - title: Add UUID field to plan schema with auto-generation
    done: true
    description: Add `uuid` field to plan schema in `src/rmplan/planSchema.ts` as
      `z.string().uuid().optional()`. Update JSON schema generation. Implement
      UUID auto-generation in `rmplan add` and `rmplan generate` commands using
      `crypto.randomUUID()`. Add lazy UUID generation in `readPlanFile()` that
      generates and writes back UUID if missing (for existing plans). Include
      test coverage for UUID generation and persistence.
    files: []
    docs: []
    steps: []
  - title: Create assignments file schema and utilities
    done: true
    description: "Create `src/rmplan/assignments/assignments_schema.ts` with Zod
      schema for assignments file structure. Schema should include:
      repositoryId, repositoryRemoteUrl, version field for optimistic locking,
      and assignments map. Each assignment entry: {planId (cached),
      workspacePaths (array - supports multiple), users (array - who claimed
      it), status (optional override), assignedAt, updatedAt}. Create
      `src/rmplan/assignments/assignments_io.ts` with functions:
      readAssignments(), writeAssignments() using atomic writes (temp file +
      rename), getAssignmentsFilePath(). Include comprehensive tests for I/O
      operations and edge cases (missing file, corrupted JSON, concurrent
      writes)."
    files: []
    docs: []
    steps: []
  - title: Implement workspace and repository identification
    done: true
    description: "Create `src/rmplan/assignments/workspace_identifier.ts` with:
      getCurrentWorkspacePath() that resolves git root to absolute normalized
      path using fs.realpathSync(), getRepositoryId() that reuses logic from
      repository_config_resolver.ts to derive repo ID from remote URL. Add
      getUserIdentity() that checks RMPLAN_USER, USER, USERNAME, LOGNAME in
      order. Include path normalization tests (symlinks, relative paths, case
      sensitivity) and repo ID tests (various remote URL formats)."
    files: []
    docs: []
    steps: []
  - title: Implement plan UUID lookup utilities
    done: false
    description: "Create `src/rmplan/assignments/uuid_lookup.ts` with:
      findPlanByUuid(uuid, allPlans) that scans plans to find matching UUID,
      resolvePlanWithUuid(planArg) that resolves numeric ID/path to plan and
      returns {plan, uuid}, verifyPlanIdCache(planId, uuid, allPlans) that
      implements the fast-path verification logic (try planId first, fall back
      to UUID scan if mismatch, update cache if needed). Include tests for cache
      hit/miss scenarios and renumbering cases."
    files: []
    docs: []
    steps: []
  - title: Implement rmplan claim command
    done: false
    description: "Create `src/rmplan/commands/claim.ts` with handleClaimCommand().
      Logic: resolve plan, ensure it has UUID (generate if missing), get
      workspace path and user, read assignments file, add workspace to
      workspacePaths array and user to users array (if not already present),
      warn if already claimed by different workspace/user. Do NOT change plan
      status. Write assignments file with atomic operation. Add CLI definition
      in rmplan.ts. Create shared utility claimPlan(planId, options) that can be
      called by other commands. Include tests for: claiming unassigned plans,
      already-claimed plans (same workspace = no-op, different workspace =
      warning), multiple workspace claims."
    files: []
    docs: []
    steps: []
  - title: Implement rmplan release command
    done: false
    description: "Create `src/rmplan/commands/release.ts` with
      handleReleaseCommand(). Logic: resolve plan to UUID, read assignments
      file, remove current workspace from workspacePaths array and current user
      from users array. If arrays become empty, remove entire assignment entry.
      Optionally reset plan status to pending (with --reset-status flag). Write
      assignments file and plan file if status changed. Add CLI definition with
      options: --reset-status (reset to pending). Include tests for releasing
      assigned plans, already-released plans, partial releases (multiple
      workspaces), status handling."
    files: []
    docs: []
    steps: []
  - title: Update ready command with assignment filtering
    done: false
    description: "Modify `src/rmplan/commands/ready.ts`: read assignments file,
      filter by current workspace path by default (show plans claimed here OR
      unassigned), add --all flag (ignore assignments), add --unassigned flag
      (only show unassigned), add --user <name> flag (filter by user). Use
      assignment status as source of truth if present, fall back to plan file
      status. Update display functions to show workspace/user info and warn
      about multi-workspace claims. Maintain backward compatibility (if
      assignments file doesn't exist, behave like before). Include comprehensive
      tests for all filtering modes."
    files: []
    docs: []
    steps: []
  - title: Update list and show commands with assignment display
    done: false
    description: "Modify `src/rmplan/commands/list.ts`: read assignments file, add
      assignment indicator column (workspace names or icon), optionally filter
      by --assigned/--unassigned flags. Modify `src/rmplan/commands/show.ts`:
      display workspace paths and users if plan is assigned, show assignment
      timestamp, warn if claimed in multiple workspaces. Update display
      utilities in `src/rmplan/utils/display_utils.ts` if needed for formatting
      workspace paths (abbreviate home directory, show relative to current
      workspace). Include tests for display with and without assignments."
    files: []
    docs: []
    steps: []
  - title: Add automatic cleanup when plans marked done
    done: false
    description: "Modify `src/rmplan/plans/mark_done.ts` and
      `src/rmplan/commands/set.ts`: when plan status changes to 'done' or
      'cancelled', automatically remove entire assignment entry from assignments
      file. Add removeAssignment(uuid) utility in assignments_io.ts. Ensure this
      works for both direct status changes and task completion. Include tests
      for automatic cleanup on done/cancelled."
    files: []
    docs: []
    steps: []
  - title: Add stale assignment detection and cleanup
    done: false
    description: "Add configuration option `assignments.staleTimeout` (default 7
      days) to rmplan config schema. Create
      `src/rmplan/assignments/stale_detection.ts` with:
      isStaleAssignment(assignment, timeoutDays) that checks updatedAt
      timestamp, getStaleAssignments(assignments, timeoutDays). Add `rmplan
      assignments` command with subcommands: list (show all assignments with
      workspace/user details), clean-stale (remove stale assignments with
      confirmation), show-conflicts (list plans claimed in multiple workspaces).
      Include tests for stale detection and cleanup."
    files: []
    docs: []
    steps: []
  - title: Add comprehensive tests and documentation
    done: false
    description: "Create test files: assignments_io.test.ts (file operations, atomic
      writes, corruption handling), workspace_identifier.test.ts (path
      normalization, repo ID derivation), uuid_lookup.test.ts (cache
      verification, scanning), claim.test.ts (assignment creation, conflicts,
      warnings), release.test.ts (assignment removal, partial releases),
      integration tests for auto-claiming in agent/generate commands. Update
      README.md with multi-workspace workflow documentation. Create
      docs/multi-workspace-workflow.md with examples: setting up multiple
      workspaces, claiming plans, handling conflicts, using with teams. Add
      troubleshooting section for common issues. Test entire workflow end-to-end
      with multiple workspace clones."
    files: []
    docs: []
    steps: []
changedFiles:
  - schema/rmplan-plan-schema.json
  - src/rmplan/assignments/assignments_io.test.ts
  - src/rmplan/assignments/assignments_io.ts
  - src/rmplan/assignments/assignments_schema.ts
  - src/rmplan/assignments/workspace_identifier.test.ts
  - src/rmplan/assignments/workspace_identifier.ts
  - src/rmplan/commands/add.test.ts
  - src/rmplan/commands/add.ts
  - src/rmplan/commands/generate.test.ts
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/renumber.test.ts
  - src/rmplan/planSchema.ts
  - src/rmplan/plans/mark_done_set_task.test.ts
  - src/rmplan/plans.test.ts
  - src/rmplan/plans.ts
  - test-plans/plans/001-stub-plan.yml
  - test-plans/plans/002-tasks-no-steps.yml
  - test-plans/plans/003-tasks-with-steps.yml
  - test-plans/plans/100-container-plan.yml
  - test-plans/plans/101-frontend-refactor.yml
  - test-plans/plans/102-api-optimization.yml
  - test-plans/plans/103-testing-infrastructure.yml
  - test-plans/plans/104-test-data-generation.yml
rmfilter: []
---

<!-- rmplan-generated-start -->
## Expected Behavior/Outcome

Users can work on multiple plans simultaneously in different workspace clones of the same repository. The `rmplan ready` command in each workspace shows only plans relevant to that workspace, preventing conflicts and confusion.

**Key behaviors:**
- Plans are primarily tracked by workspace path (e.g., `/Users/alice/work/myapp-feature-1`)
- Secondary tracking by user (via `RMPLAN_USER`) supports team coordination
- Shared state stored in `~/.config/rmplan/shared/<repo-id>/assignments.json`
- Each plan identified by UUID (stable across workspaces and git operations)
- `rmplan ready` defaults to showing plans assigned to current workspace + unassigned plans
- New plans from `git pull` appear as unassigned (available to claim)

**State definitions:**
- **Assigned plan**: Has workspace path (and optionally user) in shared assignments file
- **Unassigned plan**: Exists in repository but not in assignments file
- **Available plan**: Unassigned plan that is ready to work on (dependencies met)
- **Stale assignment**: Assignment older than configurable timeout (e.g., 7 days)

## Key Findings

### Product & User Story

**Primary Use Case**: Developer working on multiple features/plans simultaneously
- Alice has 3 workspace clones: `myapp-feature-1`, `myapp-feature-2`, `myapp-feature-3`
- Each workspace is working on a different plan from the shared plan repository
- `rmplan ready` in each workspace shows only that workspace's assigned plan(s)
- When Alice runs `git pull` and new plans appear, they show as available in all workspaces

**Secondary Use Case**: Team coordination
- Bob and Alice work on the same repository
- Each has their own workspaces
- `RMPLAN_USER` environment variable identifies the user
- `rmplan ready` can filter by user to prevent showing other people's work
- Assignments include both workspace path and user for full context

### Design & UX Approach

**Claiming a Plan** (new feature):
```bash
# In workspace ~/work/myapp-feature-1
$ rmplan claim 42
✓ Claimed plan 42 in workspace /Users/alice/work/myapp-feature-1
  Status updated to: in_progress
```

**Viewing Ready Plans**:
```bash
# Default: show assigned to current workspace + unassigned
$ rmplan ready

# Show all plans regardless of assignment
$ rmplan ready --all

# Show plans for specific user
$ rmplan ready --user alice

# Show only unassigned plans
$ rmplan ready --unassigned
```

**Releasing a Plan**:
```bash
# Remove workspace assignment (keeps status)
$ rmplan release 42

# Release and reset status to pending
$ rmplan release 42 --reset-status
```

**Assignment Information Display**:
- `rmplan show 42` displays workspace path and user (if assigned)
- `rmplan list` shows assignment indicator (icon or workspace name)
- `rmplan ready` table includes workspace column (abbreviated paths)

### Technical Plan & Risks

**Architecture Overview**:

1. **UUID Field in Plan Schema**
   - Add `uuid: z.string().uuid().optional()` to plan schema
   - Generate UUIDs automatically on plan creation
   - Migrate existing plans lazily (generate UUID on first read if missing)
   - UUID is immutable once assigned

2. **Shared Assignments File** (`~/.config/rmplan/shared/<repo-id>/assignments.json`)
   ```json
   {
     "repositoryId": "dimfeld/llmutils",
     "repositoryRemoteUrl": "https://github.com/dimfeld/llmutils.git",
     "assignments": {
       "uuid-1234-5678": {
         "workspacePath": "/Users/alice/work/myapp-feature-1",
         "user": "alice",
         "status": "in_progress",
         "assignedAt": "2025-01-26T10:00:00.000Z",
         "updatedAt": "2025-01-26T10:00:00.000Z"
       }
     }
   }
   ```

3. **Repository Identification**
   - Reuse existing `repository_config_resolver.ts` logic
   - Derive repo ID from git remote URL (owner/repo format)
   - Shared directory: `~/.config/rmplan/shared/<repo-id>/`

4. **Status Source of Truth**
   - Shared assignments file is authoritative for assigned plans
   - Plan file status is fallback for unassigned plans
   - `rmplan ready` reads both sources and merges

5. **Workspace Path Determination**
   - Use git root directory path as workspace identifier
   - Normalize paths (resolve symlinks, handle case sensitivity)
   - Store absolute paths in assignments file

6. **User Identification**
   - Check `RMPLAN_USER` environment variable first
   - Fallback to `USER`, `USERNAME`, `LOGNAME` if not set
   - Store in assignments file for audit trail

**Key Risks**:

1. **Concurrent Writes to Assignments File**
   - Multiple workspaces claiming plans simultaneously
   - Risk: Last write wins, one claim is lost
   - Mitigation: Implement optimistic locking with version field or timestamps
   - Alternative: Use file locking mechanism (leverage existing workspace lock code)

2. **Stale Assignments**
   - User abandons workspace without releasing plan
   - Risk: Plan appears "taken" but no work is happening
   - Mitigation: Add `lastActivityAt` timestamp, mark stale after N days
   - Add `rmplan assignments --clean-stale` command

3. **UUID Migration**
   - Existing plans don't have UUIDs
   - Risk: Assignment tracking doesn't work until migration
   - Mitigation: Generate UUIDs lazily on first read, auto-update plan files

4. **Path Portability**
   - Absolute paths don't work across users/machines
   - Risk: Alice's path `/Users/alice/work/...` doesn't help Bob
   - Mitigation: This is actually desired behavior (each user has their own workspace paths)

5. **Repository Identification Conflicts**
   - Multiple forks with same remote URL
   - Risk: Different repos share same assignments file
   - Mitigation: Include git root path hash in repo ID (like external storage does)

### Pragmatic Effort Estimate

**Small-Medium effort** (4-6 hours of focused development)

**Breakdown**:
1. UUID field addition and migration (1 hour)
2. Shared assignments file structure and I/O (1.5 hours)
3. Workspace/user identification utilities (1 hour)
4. Update `ready` command with filtering (1.5 hours)
5. Add `claim`/`release` commands (1 hour)
6. Testing and edge cases (2 hours)

**Complexity factors**:
- Reuses existing patterns (workspace locking, external storage, config loading)
- Schema changes are straightforward (UUID field, no breaking changes)
- Assignments file is simple JSON (not complex state machine)
- Most code is additive (new commands, new filters)

## Acceptance Criteria

**Functional Criteria**:
- [ ] Plans have optional UUID field that auto-generates on creation
- [ ] Existing plans without UUIDs get UUIDs generated on first read
- [ ] `rmplan claim <plan>` assigns plan to current workspace path and user
- [ ] `rmplan release <plan>` removes workspace assignment
- [ ] `rmplan ready` defaults to showing assigned (to current workspace) + unassigned plans
- [ ] `rmplan ready --all` shows all plans regardless of assignment
- [ ] `rmplan ready --unassigned` shows only unassigned plans
- [ ] `rmplan ready --user <name>` filters by user assignment
- [ ] Assignments stored in `~/.config/rmplan/shared/<repo-id>/assignments.json`
- [ ] Repository identification uses remote URL (reuses existing logic)
- [ ] When plan status changes to 'done', assignment is automatically removed
- [ ] `RMPLAN_USER` environment variable sets user identity (with fallback to USER/USERNAME/LOGNAME)

**UX Criteria**:
- [ ] `rmplan show` displays workspace and user assignment information
- [ ] `rmplan list` indicates which plans are assigned (icon or annotation)
- [ ] Clear error messages when assignments file is corrupted or inaccessible
- [ ] Helpful message when no plans are ready (suggests using --all or --unassigned)

**Technical Criteria**:
- [ ] UUID field added to plan schema with Zod validation
- [ ] JSON schema updated for IDE autocomplete
- [ ] Assignments file has atomic write operations (temp file + rename)
- [ ] Concurrent claim attempts are handled safely (optimistic locking or file locks)
- [ ] Stale assignments detected based on configurable timeout
- [ ] Workspace path normalization handles symlinks and case sensitivity
- [ ] All new code paths are covered by tests

## Dependencies & Constraints

**Dependencies**:
- Existing plan schema infrastructure (`planSchema.ts`)
- Repository identification logic (`repository_config_resolver.ts`)
- Workspace utilities (`src/rmplan/workspace/`)
- Current user detection patterns (environment variables)

**Technical Constraints**:
- Must maintain backward compatibility with plans without UUIDs
- Assignments file must handle concurrent access gracefully
- Path normalization must work across platforms (macOS, Linux, Windows)
- Shared directory must be created with appropriate permissions
- Cannot break existing single-user workflows

## Implementation Notes

### Recommended Approach

**Phase 1: UUID Infrastructure**
1. Add `uuid` field to plan schema (optional)
2. Generate UUID on plan creation (`rmplan add`, `rmplan generate`)
3. Add lazy UUID generation in `readPlanFile()` for existing plans
4. Write UUID back to plan file automatically

**Phase 2: Assignments File**
1. Create assignments file schema and I/O utilities
2. Implement repository ID resolution (reuse existing code)
3. Create shared directory if it doesn't exist
4. Implement atomic write operations for assignments file

**Phase 3: Claim/Release Commands**
1. Add `rmplan claim <plan>` command
2. Add `rmplan release <plan>` command
3. Implement workspace path resolution
4. Implement user identification logic
5. Update assignments file with concurrency handling

**Phase 4: Ready Command Updates**
1. Modify `ready` command to read assignments file
2. Implement filtering by workspace path (default)
3. Add `--all`, `--unassigned`, `--user` flags
4. Merge assignment status with plan file status

**Phase 5: Display Updates**
1. Update `show` command to display assignments
2. Update `list` command to indicate assigned plans
3. Add workspace/user columns to table formats

### Potential Gotchas

1. **UUID Generation Timing**: Generating UUIDs lazily means the first read after this feature ships will write to plan files. This could cause unexpected `git diff` output for users. Consider adding a `rmplan migrate-uuids` command for explicit migration.

2. **Assignments File Location**: `~/.config/rmplan/shared/<repo-id>/` assumes Unix-like systems. Windows uses different conventions (`%APPDATA%`). Use the existing config directory resolution logic.

3. **Path Normalization**: Symlinks, relative paths, and case-insensitive filesystems can cause path matching issues. Always normalize to absolute, resolved paths using `fs.realpathSync()`.

4. **Repository Forks**: If a user has multiple forks of the same upstream repo, they might share the same remote URL. Include git root path hash in repo ID to disambiguate.

5. **Concurrent Claims**: Two workspaces claiming the same plan simultaneously. Use optimistic locking (check `updatedAt` timestamp) or leverage existing workspace lock mechanisms.

6. **Status Divergence**: Assignment file says `in_progress`, plan file says `pending`. Clear rules needed: assignment file wins for assigned plans, plan file wins for unassigned plans.

7. **Cleanup on Done**: When a plan is marked done, should the assignment be automatically removed? Probably yes, to keep assignments file small and current.

8. **Git Operations**: `git checkout` changing branches might have different plan files. Assignments are by UUID, so they'll gracefully handle missing plans.

### Conflicting, Unclear, or Impossible Requirements

**All requirements are implementable with the refined understanding:**
- Primary tracking by workspace path (not just user) clarifies the model
- Shared directory location (`~/.config/rmplan/shared/`) solves multi-workspace coordination
- UUID provides stable identifier across git operations
- Supporting both workspace-based and user-based filtering covers all use cases

## Claiming Behavior (Updated)

**Claim = Workspace Assignment (No Status Change)**
- `rmplan claim <plan>` assigns plan to current workspace WITHOUT changing status
- Claiming is a lightweight "I'm working on this here" marker
- Status changes happen separately via other commands

**Auto-claiming:**
- `rmplan agent <plan>` - auto-claims before execution
- `rmplan run <plan>` - auto-claims before execution
- `rmplan generate <plan>` - auto-claims after generation completes
- MCP `rmplan:generate-plan` - instructs Claude Code to claim after generating

**Conflict handling:**
- Same workspace re-claiming: No-op (idempotent)
- Different workspace (same user): Allows with warning
- Different user: Allows with warning (team coordination)
- `--force` flag not needed (claiming is non-destructive)

**Example:**
```bash
# Generate and auto-claim
$ rmplan generate 42
✓ Generated plan 42
✓ Claimed plan 42 in workspace /Users/alice/work/myapp-feature-1

# Different workspace tries to claim
$ cd ~/work/myapp-feature-2
$ rmplan claim 42
⚠ Plan 42 is already claimed in /Users/alice/work/myapp-feature-1
✓ Claimed plan 42 in workspace /Users/alice/work/myapp-feature-2

# Now both workspaces show it (warns about conflict)
$ rmplan ready
⚠ Plan 42 is claimed in multiple workspaces
```

**Status vs Assignment:**
- Assignment: Which workspace(s) are working on this
- Status: Current state (pending/in_progress/done)
- Both stored in assignments file
- Plan file status becomes fallback/cache
<!-- rmplan-generated-end -->

## Research

### Summary

This feature enables multi-user coordination in rmplan by introducing user identity tracking via environment variables and a shared configuration directory for assignment and status tracking. The goal is to allow multiple users to work on different plans within the same repository without conflicting changes to plan files themselves.

**Critical Discoveries:**
- rmplan already has basic single-user assignment tracking via the `assignedTo` field in plan schemas
- The `--mine` and `--user` filters exist but rely solely on environment variables (`USER`, `USERNAME`, `LOGNAME`)
- Current architecture has NO concurrency protection for plan file updates (simple read-modify-write pattern)
- Plan status is currently stored only in individual plan files, not in any shared location
- No UUID or stable identifier exists beyond numeric IDs
- Configuration system supports external storage but is per-machine, not truly multi-user
- The codebase has workspace locking mechanisms that could be leveraged for coordination

### Findings

#### Plan Schema and Current Assignment Support

**Location**: `src/rmplan/planSchema.ts:75`

The plan schema already includes:
- `assignedTo: z.string().optional()` - stores username/identifier
- Status field with values: 'pending', 'in_progress', 'done', 'cancelled', 'deferred'
- Timestamps: `createdAt`, `updatedAt`, `planGeneratedAt`, `promptsGeneratedAt`

**Existing Commands:**
- `rmplan add --assign <username>` - Assign during creation
- `rmplan set <plan> --assign <username>` - Update assignment
- `rmplan set <plan> --no-assign` - Remove assignment
- `rmplan list --user <username>` - Filter by assignedTo
- `rmplan list --mine` - Filter by current user (uses `process.env.USER || process.env.USERNAME`)

**Implementation Files:**
- `src/rmplan/commands/list.ts:32-38` - User filtering logic
- `src/rmplan/commands/set.ts` - Assignment updates
- `src/rmplan/commands/show.ts` - Display assigned user
- `src/rmplan/planPropertiesUpdater.ts:59-64` - Property update utilities

**Documentation:**
- `docs/tutorials/adding-plan-schema-fields.md` - Complete tutorial using `assignedTo` as the example field

#### Ready Command Implementation

**Location**: `src/rmplan/commands/ready.ts`

The ready command currently:
1. Filters plans where all dependencies have status='done'
2. Shows both 'pending' and 'in_progress' plans by default (unlike list which only shows 'pending' as ready)
3. Supports `--pending-only` flag to exclude in_progress
4. Does NOT currently filter by user - shows all ready plans regardless of assignment

**Filtering Logic** (lines 41-74):
```typescript
function isReadyPlan(plan, allPlans, pendingOnly) {
  const validStatuses = pendingOnly ? ['pending'] : ['pending', 'in_progress'];
  if (!validStatuses.includes(plan.status)) return false;
  
  return plan.dependencies.every(depId => {
    const depPlan = allPlans.get(depId);
    return depPlan && depPlan.status === 'done';
  });
}
```

**Display Formats:**
- List format (default) - Shows ID, title, status, priority, tasks, deps, assigned user
- Table format - Compact table with columns
- JSON format - Machine-readable output

**Sort Options:**
- priority (default) - urgent > high > medium > low > maybe
- id, title, created, updated
- Secondary sort by createdAt for all except created field

**Test Coverage**: `src/rmplan/commands/ready.test.ts` - Comprehensive tests for filtering, sorting, formats

#### Configuration System Architecture

**Location**: `src/rmplan/configLoader.ts`, `src/rmplan/configSchema.ts`

**Configuration Files:**
- `.rmfilter/config/rmplan.yml` - Main configuration (in repo or external storage)
- `.rmfilter/config/rmplan.local.yml` - Local overrides (gitignored)

**Storage Modes:**
1. **Local (in-repo)**: `.rmfilter/config/` in git root
2. **External**: `~/.config/rmfilter/repositories/<repo-name>/`

**Merging Strategy:**
- Load main config, then merge local config on top
- Arrays are concatenated
- Objects are deep merged
- Primitives: local overrides main

**Multi-User Limitations:**
- External storage is per-machine in `~/.config/rmfilter/`
- Each user has separate external storage
- No shared state between users on different machines
- Config files are not designed for concurrent access
- No locking mechanism for configuration files

**Directory Structure (Local Storage):**
```
<git-root>/
  .rmfilter/
    config/
      rmplan.yml
      rmplan.local.yml
  tasks/                 # Default plan files location
```

**Relevant Files:**
- `src/rmplan/repository_config_resolver.ts` - Determines storage location
- `src/rmplan/external_storage_utils.ts` - Manages external storage metadata
- `src/rmplan/storage/storage_manager.ts` - Storage operations

#### Plan File Operations and Concurrency

**Location**: `src/rmplan/plans.ts`

**File Reading:**
- `readPlanFile(filePath)` - Reads individual plan (YAML frontmatter + markdown)
- `readAllPlans(directory)` - Scans for all `.plan.md`, `.yml`, `.yaml` files
- Supports caching via `cachedPlans` Map
- Can clear cache with `clearPlanCache()`

**File Writing:**
- `writePlanFile(filePath, plan)` - Writes YAML frontmatter + markdown body
- Automatically updates `updatedAt` timestamp
- Validates against schema before writing
- No file locking or atomic operations

**Concurrency Issues:**
- Simple read-modify-write pattern with NO locking
- Potential race conditions in multi-user scenarios:
  - Simultaneous status updates - last write wins
  - Parent-child relationship updates - can lose one child's update
  - Progress notes - can lose concurrent notes

**Mitigation Currently Used:**
- Cache invalidation (`clearPlanCache()`) before parent completion checks
- Sequential operations (not concurrent)
- Validation command can detect and fix orphaned relationships

**ID System:**
- Primary ID: Positive integer (1 to MAX_SAFE_INTEGER)
- Generated by `generateNumericPlanId()` - finds max ID + 1
- No UUID or stable cross-machine identifier
- IDs are immutable once assigned
- Duplicate detection in `readAllPlans()`

**Relevant Files:**
- `src/rmplan/plans.ts` - Core I/O operations
- `src/rmplan/id_utils.ts` - ID generation
- `src/rmplan/plans/mark_done.ts` - Complex metadata updates
- `src/rmplan/path_resolver.ts` - Path resolution

#### Workspace Locking System

**Location**: `src/rmplan/workspace/workspace_lock.ts`

rmplan already has a sophisticated locking system for workspace isolation:

**Lock Types:**
- `'pid'` - Process-based, auto-releases when process dies
- `'persistent'` - Manual lock requiring explicit release

**Lock Information Tracked:**
```typescript
{
  pid: number,
  command: string,
  startedAt: string,
  hostname: string,
  version: string,
  owner?: string  // Optional metadata
}
```

**Features:**
- Stale lock detection (24-hour timeout)
- Process liveness checks
- Force unlock support
- Lock file per workspace

**Commands:**
- `rmplan workspace lock`
- `rmplan workspace unlock --force`

**Workspace Tracking:**
- Per-user file: `~/.config/rmfilter/workspaces.json`
- Tracks all workspace clones
- Prevents concurrent access to same workspace

**Relevant Files:**
- `src/rmplan/workspace/workspace_lock.ts` - Lock implementation
- `src/rmplan/workspace/workspace_tracker.ts` - Workspace tracking
- `src/rmplan/workspace/workspace_manager.ts` - Workspace operations

### Risks & Constraints

#### Architectural Challenges

1. **Concurrency Control**
   - Plan files use simple read-modify-write with no locking
   - Multiple users modifying same plan simultaneously will have last-write-wins behavior
   - Parent-child relationship updates are particularly vulnerable to race conditions
   - Need to implement file locking or atomic update mechanisms

2. **UUID Generation and Stability**
   - Current numeric IDs are repository-scoped, not globally unique
   - Need UUID generation that works offline and doesn't require coordination
   - Must handle migration of existing plans to include UUIDs
   - Must decide if UUID should be immutable or can be regenerated

3. **Shared State Location**
   - `.rmplan/shared/` directory needs to be:
     - Accessible to all users (file permissions)
     - Located in git root (not external storage) for true sharing
     - Potentially tracked in git or explicitly ignored
   - Conflict with external storage model where each user has separate config

4. **Status Truth Source Ambiguity**
   - Plan files currently store status
   - Shared config will store status
   - Need clear precedence rules and migration path
   - Risk of divergence between file status and shared status
   - How to handle: plan file modified directly, shared config missing, etc.

5. **Environment Variable Fragmentation**
   - Currently uses `USER`, `USERNAME`, or `LOGNAME`
   - Adding `RMPLAN_USER` creates another option
   - Need clear precedence order
   - Must handle cases where variable is not set

#### Technical Constraints

1. **Backward Compatibility**
   - Existing plans without UUIDs need migration path
   - Commands must work with plans that don't have shared state entries
   - Can't break existing single-user workflows

2. **File System Permissions**
   - Shared directory needs proper permissions for team access
   - May require umask settings or explicit chmod operations
   - Different behavior on Windows vs Unix-like systems

3. **Git Integration**
   - Shared state files will create frequent small changes
   - May need `.gitignore` updates to prevent commit noise
   - Alternatively, could track shared state in git for persistence

4. **Performance**
   - Reading shared config file on every `ready` command
   - May need caching strategy similar to plan cache
   - Large teams = large shared config file

5. **Schema Validation**
   - Need Zod schema for shared config format
   - Need JSON schema for IDE support
   - Validation errors must be handled gracefully

#### Edge Cases

1. **Stale Assignments**
   - User claims plan but never finishes
   - Need timeout or manual override mechanism
   - Should `ready` command show "stale" assigned plans?

2. **Offline Work**
   - User modifies plan file directly without updating shared config
   - Shared config becomes out of sync
   - Need reconciliation strategy

3. **Duplicate Assignments**
   - Two users claim same plan simultaneously
   - Last write wins without coordination
   - May need optimistic locking (version numbers)

4. **Missing Shared Config**
   - Fresh clone of repository
   - `.rmplan/shared/` doesn't exist yet
   - Must gracefully fall back to plan file status

5. **UUID Collisions**
   - Extremely rare but theoretically possible with UUID v4
   - Detection and handling strategy needed

### Follow-up Questions

1. **Shared State Persistence Strategy**: Should the `.rmplan/shared/` directory be tracked in git (for history and backup) or gitignored (to prevent commit noise)? If gitignored, how do teams recover from lost shared state?

2. **Assignment Timeout Policy**: How long should a plan remain assigned to a user before it's considered "stale" and available for re-assignment? Should this be configurable?

3. **Status Migration**: When introducing shared config as source of truth, should we automatically migrate existing plan file statuses to the shared config on first read? Or require an explicit migration command?

4. **Conflict Resolution**: When plan file status and shared config status diverge, which takes precedence? Should there be a command to sync them explicitly?

5. **Multi-Machine Identity**: If a user works on multiple machines, should `RMPLAN_USER` be consistent across machines? How do we handle SSH sessions or remote development environments where `USER` might differ?

6. **Scope of Shared Config**: Should assignment/status tracking be per-plan only, or should it also track per-task and per-step assignments for fine-grained coordination?

7. **UUID Backfill**: Should UUID generation happen automatically on first read of a plan without UUID, or require explicit opt-in via a migration command?

8. **Locking Strategy**: Should we implement file locking for the shared config file itself (to prevent concurrent writes), or rely on git merge strategies to handle conflicts?

Implemented Task 1: Add UUID field to plan schema with auto-generation. Added an optional uuid field to phaseSchema/PlanSchema (src/rmplan/planSchema.ts) and propagated it into PlanSummary so callers can access the identifier. Updated the add and generate commands (src/rmplan/commands/add.ts, src/rmplan/commands/generate.ts) to issue crypto.randomUUID() when creating new plans, and taught readPlanFile (src/rmplan/plans.ts) to lazily backfill missing UUIDs with persistence and warning logging if the write fails. Regenerated the plan JSON schema (schema/rmplan-plan-schema.json) so editors pick up the new property. Extended the test suite to cover the behavior: add and generate command tests now assert UUID presence, plans.test.ts gained a migration test and expectations allow for UUIDs, and legacy round-trip assertions accept the new field. This work establishes the stable identifier required by the shared assignment tracking design.

Addressed reviewer feedback on Task 1 — Add UUID field to plan schema with auto-generation by ensuring readPlanFile does not return non-persisted UUIDs.

Updated src/rmplan/plans.ts so that when a legacy plan lacks a UUID, failure to write the backfilled UUID clears the temporary value, logs a warning, and throws a new Error that preserves the original cause message. This guarantees downstream callers never see a UUID unless it was successfully persisted and provides clear diagnostics if the filesystem rejects the write.

Extended src/rmplan/plans.test.ts within the plan UUID handling suite to cover the failure path by spying on writePlanFile, asserting readPlanFile rejects with the new error, and verifying the file remains unchanged. This regression test documents the expected behavior for future migrations and guards against reintroducing silent failures.

Implemented Task 2: Create assignments file schema and utilities by introducing src/rmplan/assignments/assignments_schema.ts with strict Zod definitions for the shared assignments JSON (including UUID-keyed records, planId normalization, and status reuse), and src/rmplan/assignments/assignments_io.ts with atomic read/write helpers, optimistic version checks, platform-aware config path resolution, and custom errors. Added src/rmplan/assignments/assignments_io.test.ts to validate missing-file defaults, persistence flow, corruption handling, and version conflict detection.

Implemented Task 3: Implement workspace and repository identification by creating src/rmplan/assignments/workspace_identifier.ts with helpers for resolving canonical workspace paths (using realpath normalization), deriving repository IDs via git remote parsing and fallback hashing, and computing user identity precedence. Added src/rmplan/assignments/workspace_identifier.test.ts with live git repository fixtures covering symlink normalization, remote-driven IDs, fallback behavior without remotes, and environment variable precedence.

Implemented a lock-based compare-and-swap for assignments persistence to prevent lost updates under concurrent writers. Added LOCK_* timing constants and the acquireFileLock helper in src/rmplan/assignments/assignments_io.ts, and now wrap the optimistic version re-read/write/rename flow in that lock so the last-in rename cannot silently discard a sibling write. Tasks: Task 2: Create assignments file schema and utilities. The lock is a temporary .lock file with retry/timeout and stale-lock cleanup; it stores the pid/timestamp for debugging and releases in a finally block to avoid wedges. Within the lock we re-parse existing state before the compare, then write a temp file and rename atomically, preserving version monotonicity and existing error handling for parse failures and temp cleanup. This keeps optimistic versioning semantics intact for sequential writers while ensuring concurrent claim/release calls get an AssignmentsVersionConflictError instead of clobbering newer data.

Task 4 – Added src/rmplan/assignments/uuid_lookup.ts with helpers for scanning UUIDs, verifying cached plan IDs, and resolving plan arguments, plus unit tests that exercise cache hit/miss paths and UUID persistence from legacy files. Task 5 – Introduced src/rmplan/assignments/claim_plan.ts and src/rmplan/commands/claim.ts to persist workspace/user claims via the shared assignments store, hooked the handler into rmplan.ts, and wrote targeted tests covering first-claim, no-op reclaims, and multi-workspace conflict warnings.
