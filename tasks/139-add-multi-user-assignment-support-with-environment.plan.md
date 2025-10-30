---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add multi-user assignment and status tracking with shared config
goal: Enable multi-user workflows in rmplan by supporting user identity via
  environment variables and tracking both plan assignments and status in a
  shared configuration
id: 139
uuid: 8b82a7c6-2182-48b7-af3e-2be853519242
generatedBy: agent
status: done
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
updatedAt: 2025-10-27T12:27:06.495Z
compactedAt: 2025-10-30T20:00:42.776Z
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
  - timestamp: 2025-10-27T09:03:38.989Z
    text: Reviewed claim workflow implementation/tests; identified missing coverage
      for multi-user warnings and no-user scenarios.
    source: "tester: Tasks 4-5"
  - timestamp: 2025-10-27T09:04:48.331Z
    text: Added coverage for claim conflicts with different users and missing user
      identity; verified bun test claim suite and bun run check succeed.
    source: "tester: Tasks 4-5"
  - timestamp: 2025-10-27T09:23:48.279Z
    text: Added releasePlan utility and CLI handler; release removes workspace/user
      assignments with warnings for remaining claims and supports optional
      status reset flag.
    source: "implementer: Task 6"
  - timestamp: 2025-10-27T09:23:52.452Z
    text: bun test src/rmplan/commands/release.test.ts and bun run check both
      succeed.
    source: "tester: Task 6"
  - timestamp: 2025-10-27T09:26:23.124Z
    text: Reviewed release command tests; identified missing coverage for
      non-workspace releases and UUID-only plans.
    source: "tester: Task 6"
  - timestamp: 2025-10-27T09:27:23.836Z
    text: Extended release command test suite to cover non-workspace claims,
      UUID-only plans, and pending reset messaging.
    source: "tester: Task 6"
  - timestamp: 2025-10-27T10:16:56.797Z
    text: Implemented ready command assignments filtering, updated list/show
      displays, and extended tests to cover new workspace/user behavior.
    source: "implementer: Tasks 7&8"
  - timestamp: 2025-10-27T10:21:18.863Z
    text: Moved the assignment-focused list command tests out of the mockTable
      helper so they actually execute, added coverage for the new
      filters/workspace column, and reran bun run check plus the relevant
      command suites.
    source: "tester: Task 8"
  - timestamp: 2025-10-27T10:39:48.538Z
    text: Added removeAssignment helper and wired automatic assignment cleanup into
      mark_done, set, and parent plan flows.
    source: "implementer: Task 9"
  - timestamp: 2025-10-27T10:49:53.112Z
    text: Added unit coverage across mark_step, mark_task, set, and setTask flows to
      confirm assignment cleanup triggers; bun run check and targeted test
      suites all pass.
    source: "tester: Task 9"
  - timestamp: 2025-10-27T11:03:19.390Z
    text: "Added regression coverage for assignment cleanup: verified
      removeAssignment IO helper, failure-to-remove warnings in mark_done/set
      commands, and agent parent completion dropping assignments. Updated set
      command no-op test to assert file unchanged. Targeted test suites pass."
    source: "tester: Task 9"
  - timestamp: 2025-10-27T11:12:55.374Z
    text: Added assignments.staleTimeout config schema + JSON schema entry and
      introduced stale_detection helpers with default constant.
    source: "implementer: Task 10"
  - timestamp: 2025-10-27T11:19:11.760Z
    text: Wired rmplan assignments command tree (list, clean-stale, show-conflicts);
      handlers load shared assignments, render summary/conflict tables, and
      support stale cleanup with confirmation.
    source: "implementer: Task 10"
  - timestamp: 2025-10-27T11:23:22.791Z
    text: Added stale detection unit tests and new assignments command suite
      covering list output, conflict display, and clean-stale
      confirmation/removal scenarios; all relevant tests and type-checks pass.
    source: "tester: Task 10"
  - timestamp: 2025-10-27T11:25:40.779Z
    text: Reviewed assignments command/stale detection code and current tests.
      Identified missing coverage for yes bypass, parse errors, empty/conflict
      outputs, and write conflicts.
    source: "tester: Task 10"
  - timestamp: 2025-10-27T11:27:43.646Z
    text: Extended assignments command tests to cover empty listings, --yes
      confirmation bypass, concurrent write conflicts, parse error handling,
      custom stale timeout, and conflict-free scenarios. Verified updates with
      bun run check and targeted bun test runs.
    source: "tester: Task 10"
  - timestamp: 2025-10-27T11:45:36.820Z
    text: "Assessed existing code/tests/documentation: core assignment tests already
      exist (assignments_io, workspace_identifier, uuid_lookup, claim, release,
      ready/list/show). Documentation updates for multi-workspace workflows and
      integration coverage for agent/generate auto-claiming remain absent.
      Discovered auto-claim functionality is not yet wired into generate/agent
      commands, so Task 11 will need to add that behavior before we can exercise
      it end-to-end."
    source: "implementer: Task 11"
  - timestamp: 2025-10-27T12:10:47.333Z
    text: "Implemented auto-claim toggles and new coverage: added enable/disable
      helpers so CLI invocations turn on shared assignments while unit tests
      stay stable, created integration tests asserting rmplan generate/agent
      invoke auto-claim, introduced direct auto-claim persistence tests, and
      documented multi-workspace workflows with a dedicated guide plus README
      entry."
    source: "implementer: Task 11"
  - timestamp: 2025-10-27T12:14:09.071Z
    text: Ran bun run check to ensure TypeScript types remain valid after multi-user
      assignment changes.
    source: "tester: Task 11"
  - timestamp: 2025-10-27T12:14:24.520Z
    text: Ran bun test; suite failed because configLoader default expectation does
      not include new assignments.staleTimeout default of 7, indicating tests
      need update.
    source: "tester: Task 11"
  - timestamp: 2025-10-27T12:15:09.174Z
    text: Updated configLoader default config test to include
      assignments.staleTimeout default and reran bun test; entire suite now
      passes.
    source: "tester: Task 11"
tasks:
  - title: Add UUID field to plan schema with auto-generation
    done: true
    description: Add `uuid` field to plan schema in `src/rmplan/planSchema.ts` as
      `z.string().uuid().optional()`. Update JSON schema generation. Implement
      UUID auto-generation in `rmplan add` and `rmplan generate` commands using
      `crypto.randomUUID()`. Add lazy UUID generation in `readPlanFile()` that
      generates and writes back UUID if missing (for existing plans). Include
      test coverage for UUID generation and persistence.
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
  - title: Implement workspace and repository identification
    done: true
    description: "Create `src/rmplan/assignments/workspace_identifier.ts` with:
      getCurrentWorkspacePath() that resolves git root to absolute normalized
      path using fs.realpathSync(), getRepositoryId() that reuses logic from
      repository_config_resolver.ts to derive repo ID from remote URL. Add
      getUserIdentity() that checks RMPLAN_USER, USER, USERNAME, LOGNAME in
      order. Include path normalization tests (symlinks, relative paths, case
      sensitivity) and repo ID tests (various remote URL formats)."
  - title: Implement plan UUID lookup utilities
    done: true
    description: "Create `src/rmplan/assignments/uuid_lookup.ts` with:
      findPlanByUuid(uuid, allPlans) that scans plans to find matching UUID,
      resolvePlanWithUuid(planArg) that resolves numeric ID/path to plan and
      returns {plan, uuid}, verifyPlanIdCache(planId, uuid, allPlans) that
      implements the fast-path verification logic (try planId first, fall back
      to UUID scan if mismatch, update cache if needed). Include tests for cache
      hit/miss scenarios and renumbering cases."
  - title: Implement rmplan claim command
    done: true
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
  - title: Implement rmplan release command
    done: true
    description: "Create `src/rmplan/commands/release.ts` with
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
    description: "Modify `src/rmplan/commands/ready.ts`: read assignments file,
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
    description: "Modify `src/rmplan/commands/list.ts`: read assignments file, add
      assignment indicator column (workspace names or icon), optionally filter
      by --assigned/--unassigned flags. Modify `src/rmplan/commands/show.ts`:
      display workspace paths and users if plan is assigned, show assignment
      timestamp, warn if claimed in multiple workspaces. Update display
      utilities in `src/rmplan/utils/display_utils.ts` if needed for formatting
      workspace paths (abbreviate home directory, show relative to current
      workspace). Include tests for display with and without assignments."
  - title: Add automatic cleanup when plans marked done
    done: true
    description: "Modify `src/rmplan/plans/mark_done.ts` and
      `src/rmplan/commands/set.ts`: when plan status changes to 'done' or
      'cancelled', automatically remove entire assignment entry from assignments
      file. Add removeAssignment(uuid) utility in assignments_io.ts. Ensure this
      works for both direct status changes and task completion. Include tests
      for automatic cleanup on done/cancelled."
  - title: Add stale assignment detection and cleanup
    done: true
    description: "Add configuration option `assignments.staleTimeout` (default 7
      days) to rmplan config schema. Create
      `src/rmplan/assignments/stale_detection.ts` with:
      isStaleAssignment(assignment, timeoutDays) that checks updatedAt
      timestamp, getStaleAssignments(assignments, timeoutDays). Add `rmplan
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
  - schema/rmplan-config-schema.json
  - schema/rmplan-plan-schema.json
  - src/rmplan/assignments/assignments_io.test.ts
  - src/rmplan/assignments/assignments_io.ts
  - src/rmplan/assignments/assignments_schema.ts
  - src/rmplan/assignments/auto_claim.test.ts
  - src/rmplan/assignments/auto_claim.ts
  - src/rmplan/assignments/claim_logging.ts
  - src/rmplan/assignments/claim_plan.ts
  - src/rmplan/assignments/release_plan.ts
  - src/rmplan/assignments/stale_detection.test.ts
  - src/rmplan/assignments/stale_detection.ts
  - src/rmplan/assignments/uuid_lookup.test.ts
  - src/rmplan/assignments/uuid_lookup.ts
  - src/rmplan/assignments/workspace_identifier.test.ts
  - src/rmplan/assignments/workspace_identifier.ts
  - src/rmplan/commands/add.test.ts
  - src/rmplan/commands/add.ts
  - src/rmplan/commands/agent/agent.auto_claim.integration.test.ts
  - src/rmplan/commands/agent/agent.ts
  - src/rmplan/commands/agent/parent_completion.test.ts
  - src/rmplan/commands/agent/parent_plans.ts
  - src/rmplan/commands/assignments.test.ts
  - src/rmplan/commands/assignments.ts
  - src/rmplan/commands/claim.test.ts
  - src/rmplan/commands/claim.ts
  - src/rmplan/commands/generate.auto_claim.integration.test.ts
  - src/rmplan/commands/generate.test.ts
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/list.test.ts
  - src/rmplan/commands/list.ts
  - src/rmplan/commands/ready.test.ts
  - src/rmplan/commands/ready.ts
  - src/rmplan/commands/release.test.ts
  - src/rmplan/commands/release.ts
  - src/rmplan/commands/renumber.test.ts
  - src/rmplan/commands/set.test.ts
  - src/rmplan/commands/set.ts
  - src/rmplan/commands/show.test.ts
  - src/rmplan/commands/show.ts
  - src/rmplan/configLoader.test.ts
  - src/rmplan/configSchema.ts
  - src/rmplan/display_utils.test.ts
  - src/rmplan/display_utils.ts
  - src/rmplan/planSchema.ts
  - src/rmplan/plans/mark_done.test.ts
  - src/rmplan/plans/mark_done.ts
  - src/rmplan/plans/mark_done_set_task.test.ts
  - src/rmplan/plans.test.ts
  - src/rmplan/plans.ts
  - src/rmplan/rmplan.ts
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
- Enabled multi-workspace and multi-user coordination in rmplan by introducing UUID-based plan identification, workspace-scoped assignment
  tracking via shared config, and filtering commands that prevent workspace conflicts.
- Developers can now work on multiple plans simultaneously in separate workspace clones while `rmplan ready` shows only relevant plans.
- Shared state stored in `~/.config/rmplan/shared/<repo-id>/assignments.json` tracks which workspace/user is working on each plan.

## Decisions
- **UUID as stable identifier**: Added optional `uuid` field to plan schema with lazy migration on first read; UUIDs are immutable once
  assigned and survive git operations/renumbering.
- **Workspace-first tracking**: Primary identifier is workspace absolute path (e.g., `/Users/alice/work/myapp-feature-1`), secondary is
  user via `RMPLAN_USER` environment variable with fallback to `USER`/`USERNAME`/`LOGNAME`.
- **Claim command does not change status**: `rmplan claim` only assigns workspace/user; status changes happen separately via existing
  commands to keep claiming lightweight and non-destructive.
- **Shared assignments file location**: `~/.config/rmplan/shared/<repo-id>/assignments.json` with atomic writes (temp file + rename) and
  file locking to prevent concurrent write conflicts.
- **Auto-claim behavior**: `rmplan generate` auto-claims after plan creation; `rmplan agent` auto-claims before execution; explicit
  `rmplan claim` available for manual assignment.
- **Automatic cleanup**: Assignment entries removed automatically when plan status changes to done/cancelled, keeping shared state small
  and current.
- **Stale detection**: Default 7-day timeout (configurable via `assignments.staleTimeout`) with `rmplan assignments clean-stale` command
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
- Workspace locking system (src/rmplan/workspace/workspace_lock.ts) provided pattern for file locking with stale detection; informed
  assignments file concurrency protection design.
- Configuration system's external storage per-machine model (src/rmplan/repository_config_resolver.ts) provided repository identity
  derivation pattern; shared assignments directory placed outside external storage to enable true multi-workspace coordination.
