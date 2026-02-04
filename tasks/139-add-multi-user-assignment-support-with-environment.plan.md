---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Add multi-user assignment and status tracking with shared config
goal: Enable multi-user workflows in tim by supporting user identity via
  environment variables and tracking both plan assignments and status in a
  shared configuration
id: 139
uuid: 8b82a7c6-2182-48b7-af3e-2be853519242
generatedBy: agent
status: done
priority: high
planGeneratedAt: 2025-10-27T08:01:47.867Z
promptsGeneratedAt: 2025-10-27T08:01:47.867Z
createdAt: 2025-10-27T05:51:22.359Z
updatedAt: 2025-10-27T12:27:06.495Z
compactedAt: 2025-10-30T20:00:42.776Z
tasks:
  - title: Add UUID field to plan schema with auto-generation
    done: true
    description: Add `uuid` field to plan schema in `src/tim/planSchema.ts` as
      `z.string().uuid().optional()`. Update JSON schema generation. Implement
      UUID auto-generation in `tim add` and `tim generate` commands using
      `crypto.randomUUID()`. Add lazy UUID generation in `readPlanFile()` that
      generates and writes back UUID if missing (for existing plans). Include
      test coverage for UUID generation and persistence.
  - title: Create assignments file schema and utilities
    done: true
    description: "Create `src/tim/assignments/assignments_schema.ts` with Zod
      schema for assignments file structure. Schema should include:
      repositoryId, repositoryRemoteUrl, version field for optimistic locking,
      and assignments map. Each assignment entry: {planId (cached),
      workspacePaths (array - supports multiple), users (array - who claimed
      it), status (optional override), assignedAt, updatedAt}. Create
      `src/tim/assignments/assignments_io.ts` with functions:
      readAssignments(), writeAssignments() using atomic writes (temp file +
      rename), getAssignmentsFilePath(). Include comprehensive tests for I/O
      operations and edge cases (missing file, corrupted JSON, concurrent
      writes)."
  - title: Implement workspace and repository identification
    done: true
    description: "Create `src/tim/assignments/workspace_identifier.ts` with:
      getCurrentWorkspacePath() that resolves git root to absolute normalized
      path using fs.realpathSync(), getRepositoryId() that reuses logic from
      repository_config_resolver.ts to derive repo ID from remote URL. Add
      getUserIdentity() that checks RMPLAN_USER, USER, USERNAME, LOGNAME in
      order. Include path normalization tests (symlinks, relative paths, case
      sensitivity) and repo ID tests (various remote URL formats)."
  - title: Implement plan UUID lookup utilities
    done: true
    description: "Create `src/tim/assignments/uuid_lookup.ts` with:
      findPlanByUuid(uuid, allPlans) that scans plans to find matching UUID,
      resolvePlanWithUuid(planArg) that resolves numeric ID/path to plan and
      returns {plan, uuid}, verifyPlanIdCache(planId, uuid, allPlans) that
      implements the fast-path verification logic (try planId first, fall back
      to UUID scan if mismatch, update cache if needed). Include tests for cache
      hit/miss scenarios and renumbering cases."
  - title: Implement tim claim command
    done: true
    description: "Create `src/tim/commands/claim.ts` with handleClaimCommand().
      Logic: resolve plan, ensure it has UUID (generate if missing), get
      workspace path and user, read assignments file, add workspace to
      workspacePaths array and user to users array (if not already present),
      warn if already claimed by different workspace/user. Do NOT change plan
      status. Write assignments file with atomic operation. Add CLI definition
      in tim.ts. Create shared utility claimPlan(planId, options) that can be
      called by other commands. Include tests for: claiming unassigned plans,
      already-claimed plans (same workspace = no-op, different workspace =
      warning), multiple workspace claims."
  - title: Implement tim release command
    done: true
    description: "Create `src/tim/commands/release.ts` with
      handleReleaseCommand(). Logic: resolve plan to UUID, read assignments
      file, remove current workspace from workspacePaths array and current user
      from users array. If arrays become empty, remove entire assignment entry.
      Optionally reset plan status to pending (with --reset-status flag). Write
      assignments file and plan file if status changed. Add CLI definition with
      options: --reset-status (reset to pending). Include tests for releasing
      assigned plans, already-released plans, partial releases (multiple
      workspaces), status handling."
  - title: Update ready command with assignment filtering
    done: true
    description: "Modify `src/tim/commands/ready.ts`: read assignments file,
      filter by current workspace path by default (show plans claimed here OR
      unassigned), add --all flag (ignore assignments), add --unassigned flag
      (only show unassigned), add --user <name> flag (filter by user). Use
      assignment status as source of truth if present, fall back to plan file
      status. Update display functions to show workspace/user info and warn
      about multi-workspace claims. Maintain backward compatibility (if
      assignments file doesn't exist, behave like before). Include comprehensive
      tests for all filtering modes."
  - title: Update list and show commands with assignment display
    done: true
    description: "Modify `src/tim/commands/list.ts`: read assignments file, add
      assignment indicator column (workspace names or icon), optionally filter
      by --assigned/--unassigned flags. Modify `src/tim/commands/show.ts`:
      display workspace paths and users if plan is assigned, show assignment
      timestamp, warn if claimed in multiple workspaces. Update display
      utilities in `src/tim/utils/display_utils.ts` if needed for formatting
      workspace paths (abbreviate home directory, show relative to current
      workspace). Include tests for display with and without assignments."
  - title: Add automatic cleanup when plans marked done
    done: true
    description: "Modify `src/tim/plans/mark_done.ts` and
      `src/tim/commands/set.ts`: when plan status changes to 'done' or
      'cancelled', automatically remove entire assignment entry from assignments
      file. Add removeAssignment(uuid) utility in assignments_io.ts. Ensure this
      works for both direct status changes and task completion. Include tests
      for automatic cleanup on done/cancelled."
  - title: Add stale assignment detection and cleanup
    done: true
    description: "Add configuration option `assignments.staleTimeout` (default 7
      days) to tim config schema. Create
      `src/tim/assignments/stale_detection.ts` with:
      isStaleAssignment(assignment, timeoutDays) that checks updatedAt
      timestamp, getStaleAssignments(assignments, timeoutDays). Add `tim
      assignments` command with subcommands: list (show all assignments with
      workspace/user details), clean-stale (remove stale assignments with
      confirmation), show-conflicts (list plans claimed in multiple workspaces).
      Include tests for stale detection and cleanup."
  - title: Add comprehensive tests and documentation
    done: true
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
changedFiles:
  - README.md
  - docs/multi-workspace-workflow.md
  - schema/tim-config-schema.json
  - schema/tim-plan-schema.json
  - src/tim/assignments/assignments_io.test.ts
  - src/tim/assignments/assignments_io.ts
  - src/tim/assignments/assignments_schema.ts
  - src/tim/assignments/auto_claim.test.ts
  - src/tim/assignments/auto_claim.ts
  - src/tim/assignments/claim_logging.ts
  - src/tim/assignments/claim_plan.ts
  - src/tim/assignments/release_plan.ts
  - src/tim/assignments/stale_detection.test.ts
  - src/tim/assignments/stale_detection.ts
  - src/tim/assignments/uuid_lookup.test.ts
  - src/tim/assignments/uuid_lookup.ts
  - src/tim/assignments/workspace_identifier.test.ts
  - src/tim/assignments/workspace_identifier.ts
  - src/tim/commands/add.test.ts
  - src/tim/commands/add.ts
  - src/tim/commands/agent/agent.auto_claim.integration.test.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/agent/parent_completion.test.ts
  - src/tim/commands/agent/parent_plans.ts
  - src/tim/commands/assignments.test.ts
  - src/tim/commands/assignments.ts
  - src/tim/commands/claim.test.ts
  - src/tim/commands/claim.ts
  - src/tim/commands/generate.auto_claim.integration.test.ts
  - src/tim/commands/generate.test.ts
  - src/tim/commands/generate.ts
  - src/tim/commands/list.test.ts
  - src/tim/commands/list.ts
  - src/tim/commands/ready.test.ts
  - src/tim/commands/ready.ts
  - src/tim/commands/release.test.ts
  - src/tim/commands/release.ts
  - src/tim/commands/renumber.test.ts
  - src/tim/commands/set.test.ts
  - src/tim/commands/set.ts
  - src/tim/commands/show.test.ts
  - src/tim/commands/show.ts
  - src/tim/configLoader.test.ts
  - src/tim/configSchema.ts
  - src/tim/display_utils.test.ts
  - src/tim/display_utils.ts
  - src/tim/planSchema.ts
  - src/tim/plans/mark_done.test.ts
  - src/tim/plans/mark_done.ts
  - src/tim/plans/mark_done_set_task.test.ts
  - src/tim/plans.test.ts
  - src/tim/plans.ts
  - src/tim/tim.ts
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

## Summary
- Enabled multi-workspace and multi-user coordination in tim by introducing UUID-based plan identification, workspace-scoped assignment
  tracking via shared config, and filtering commands that prevent workspace conflicts.
- Developers can now work on multiple plans simultaneously in separate workspace clones while `tim ready` shows only relevant plans.
- Shared state stored in `~/.config/tim/shared/<repo-id>/assignments.json` tracks which workspace/user is working on each plan.

## Decisions
- **UUID as stable identifier**: Added optional `uuid` field to plan schema with lazy migration on first read; UUIDs are immutable once
  assigned and survive git operations/renumbering.
- **Workspace-first tracking**: Primary identifier is workspace absolute path (e.g., `/Users/alice/work/myapp-feature-1`), secondary is
  user via `RMPLAN_USER` environment variable with fallback to `USER`/`USERNAME`/`LOGNAME`.
- **Claim command does not change status**: `tim claim` only assigns workspace/user; status changes happen separately via existing
  commands to keep claiming lightweight and non-destructive.
- **Shared assignments file location**: `~/.config/tim/shared/<repo-id>/assignments.json` with atomic writes (temp file + rename) and
  file locking to prevent concurrent write conflicts.
- **Auto-claim behavior**: `tim generate` auto-claims after plan creation; `tim agent` auto-claims before execution; explicit
  `tim claim` available for manual assignment.
- **Automatic cleanup**: Assignment entries removed automatically when plan status changes to done/cancelled, keeping shared state small
  and current.
- **Stale detection**: Default 7-day timeout (configurable via `assignments.staleTimeout`) with `tim assignments clean-stale` command
  for manual cleanup.
- **Concurrency protection**: File locking with retry/timeout prevents lost updates; optimistic versioning detects conflicts; stale lock
  cleanup after timeout.
- **Repository identity**: Reuse existing `repository_config_resolver.ts` logic; derive repo ID from git remote URL (owner/repo format);
  include git root path hash to disambiguate forks.
- **Backward compatibility**: Commands gracefully handle missing assignments file, plans without UUIDs, and single-user workflows; legacy
  `assignedTo` field filtering preserved.
- **Multi-workspace support**: Added workspaceOwners map to track which user owns each workspace path; ensures correct user removal when
  workspace released.
- **External storage fix**: Generate command passes `pathContext.gitRoot` to ensure repository identity resolves to actual checkout
  instead of external storage directory.

## Research
- Existing `assignedTo` field in plan schema provided single-user assignment; lacked workspace-scoped tracking or shared state.
- Workspace locking system (src/tim/workspace/workspace_lock.ts) provided pattern for file locking with stale detection; informed
  assignments file concurrency protection design.
- Configuration system's external storage per-machine model (src/tim/repository_config_resolver.ts) provided repository identity
  derivation pattern; shared assignments directory placed outside external storage to enable true multi-workspace coordination.
