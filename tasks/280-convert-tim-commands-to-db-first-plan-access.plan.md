---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Convert tim commands to DB-first plan access
goal: Update all tim CLI commands and MCP tools to read/write plan data from the
  DB as source of truth, using the materialization infrastructure from plan 279.
id: 280
uuid: 6de3727b-1e50-4cee-80ea-786d92db3a6c
status: done
priority: high
dependencies:
  - 279
parent: 278
planGeneratedAt: 2026-03-25T22:39:50.190Z
createdAt: 2026-03-25T03:46:35.916Z
updatedAt: 2026-03-27T08:22:42.131Z
tasks:
  - title: Extend resolveProjectContext() and create DB-first plan resolution
    done: true
    description: "Extend resolveProjectContext() in plan_materialize.ts to include
      maxNumericId computed from loaded plan rows. Create a new
      resolvePlanFromDb() function that takes a plan argument (numeric ID, UUID,
      or file path) and project context, queries the DB using getPlanByPlanId()
      or getPlanByUuid(), converts the DB row to PlanSchema using
      planRowToSchemaInput() plus task/dependency/tag fetching, and returns {
      plan: PlanSchema, planPath: string | null } where planPath is derived from
      getMaterializedPlanPath() if a materialized file exists on disk. Errors if
      plan not found in DB (no file fallback). Update resolvePlan() in
      plan_display.ts to use the new DB-first resolution. Update
      buildPlanContext() to handle null planPath by displaying plan ID instead
      of file path. Update generateNumericPlanId() in id_utils.ts to use
      resolveProjectContext().maxNumericId instead of
      readAllPlans().maxNumericId."
  - title: Create writePlanToDb() and invert writePlanFile() to DB-first
    done: true
    description: Create a writePlanToDb() function that takes PlanSchemaInput and
      project context, validates with phaseSchema.safeParse(), applies
      normalizations (fancy quotes, deprecated field removal), and calls
      upsertPlan() + upsertPlanTasks() + upsertPlanDependencies() +
      upsertPlanTags() within a single db.transaction().immediate(). Handles
      skipUpdatedAt option. Does NOT handle file materialization. Then update
      writePlanFile() to write DB first via writePlanToDb(), then optionally
      write to file. Rename skipSync option to skipFile. Phase out
      PlanWithFilename type - DB-first functions return PlanSchema directly,
      callers derive file paths from getMaterializedPlanPath(repoRoot, planId)
      when needed.
  - title: Consolidate checkAndMarkParentDone() and simplify ensureReferences()
    done: true
    description: "Merge the two checkAndMarkParentDone() implementations (local
      function in src/tim/plans/mark_done.ts and exported function in
      src/tim/commands/agent/parent_plans.ts) into a single shared
      implementation in a new file (e.g. src/tim/plans/parent_cascade.ts).
      Convert to DB queries: query children by parent_uuid, check statuses from
      DB, write parent update to DB in a transaction. Also convert
      markParentInProgress() to DB queries. Simplify ensureReferences() to just
      do DB UUID lookups via resolveProjectContext().planIdToUuid since all
      plans now have UUIDs at creation time. Simplify or remove
      writePlansWithGeneratedUuids()."
  - title: Update MCP tools to DB-first pattern
    done: true
    description: "Update all MCP tools in src/tim/tools/: get_plan.ts uses DB-first
      resolvePlan(), read-only. update_plan_details.ts uses withPlanAutoSync()
      wrapper, loads from DB, calls updateDetailsWithinDelimiters(), writes to
      DB. update_plan_tasks.ts uses withPlanAutoSync(), loads from DB, calls
      mergeTasksIntoPlan(), writes to DB. manage_plan_task.ts uses
      withPlanAutoSync() for each operation. create_plan.ts writes new plan
      directly to DB, generates numeric ID from
      resolveProjectContext().maxNumericId, handles parent updates in
      transaction, no tasks dir requirement. list_ready_plans.ts removes
      readAllPlans() fallback, DB only."
  - title: Update tim add and tim edit commands for DB-first
    done: true
    description: "Update add.ts: Write new plan to DB instead of creating file in
      tasks dir. Use resolveProjectContext().maxNumericId for ID generation.
      Handle parent updates via DB in a transaction. Remove fs.mkdir(targetDir)
      requirement. When --edit flag used: materialize to
      .tim/plans/{planId}.plan.md, open editor, sync back to DB via
      syncMaterializedPlan(), then delete the materialized file. Update edit.ts:
      Resolve plan from DB. Materialize to .tim/plans/{planId}.plan.md. Open
      $EDITOR. After editor closes, sync back to DB. Delete materialized file
      after successful sync."
  - title: Update tim set command for DB-first
    done: true
    description: Update set.ts to load plan from DB instead of resolvePlanFile() +
      readPlanFile(). Apply metadata changes in-memory. Write to DB via
      writePlanToDb(), re-materialize if materialized file exists.
      Parent/dependency cascading updates use DB queries instead of
      readAllPlans(). Use consolidated checkAndMarkParentDone() from
      parent_cascade.ts. Wrap multi-plan updates in DB transactions for
      atomicity.
  - title: Update tim done / mark_done.ts for DB-first
    done: true
    description: Update done.ts and all functions in mark_done.ts (markStepDone,
      markTaskDone, setTaskDone) to load plan from DB instead of readPlanFile().
      Mark task done, update changedFiles from Git, write to DB via
      writePlanToDb(). Re-materialize if materialized file exists. Use
      consolidated checkAndMarkParentDone() for parent cascade. Also update
      set-task-done.ts and add-task.ts commands.
  - title: Update tim list, ready, and display commands for DB-first
    done: true
    description: "Update list.ts: Remove readAllPlans() fallback, make
      loadPlansFromDb() the only path (except --local flag retains file
      scanning). Update ready.ts: Same pattern, DB is primary, --local for file
      scanning. Update show.ts to use DB queries instead of readPlanFile() and
      readAllPlans(). Update plan_display.ts functions not already covered."
  - title: Update generate, chat, and setupWorkspace for DB-first materialization
    done: true
    description: "Update generate.ts: Resolve plan from DB. Materialize plan into
      workspace .tim/plans/{planId}.plan.md instead of copying task file. After
      executor finishes, use syncMaterializedPlan() to sync back to DB. Update
      chat.ts with same pattern. Update setupWorkspace() in workspace_setup.ts
      to drop file-copy logic. Workspace gets plan via materialization instead
      of file copy. planFile parameter becomes optional or replaced with
      planId."
  - title: Update agent command, batch_mode, and stub_plan for DB-first
    done: true
    description: "Update agent.ts, batch_mode.ts, and stub_plan.ts for DB-first plan
      access. Agent resolves plan from DB. Materializes plan into workspace via
      materializePlan() instead of file copy. batch_mode.ts uses DB for plan
      state updates via consolidated checkAndMarkParentDone(). stub_plan.ts
      reads/writes plan state via DB. markParentInProgress() converted to DB
      queries. Post-agent sync: materialized file changes synced back to DB.
      Ensure session info uses plan DB ID/UUID rather than file path. Absorbs
      scope of cancelled plan 281."
  - title: Update remaining commands for DB-first
    done: true
    description: "Convert all remaining commands using resolvePlanFile(),
      readPlanFile(), readAllPlans(), or writePlanFile() to DB-first: branch.ts,
      review.ts, compact.ts, remove.ts, remove-task.ts, split.ts, extract.ts,
      merge.ts, promote.ts, pr.ts, release.ts, cleanup-temp.ts,
      update-lessons.ts, update-docs.ts, assignments.ts, prompts.ts,
      subagent.ts, import/import.ts, find_next_dependency.ts, workspace.ts. Each
      follows same pattern: replace file resolution with DB resolution, replace
      file writes with DB writes plus optional materialization."
  - title: Update validate and renumber commands for DB-first
    done: true
    description: Convert validate.ts to query all plans from DB instead of
      readAllPlans(). Remove file-based validation concerns handled by DB schema
      (missing UUIDs, missing parent references). Keep circular dependency
      detection. renumber.ts updates DB records and re-materializes any existing
      files. Multi-plan renumber operations wrapped in DB transaction.
  - title: Update tests and verify cross-interface integration
    done: true
    description: "Update existing tests for DB-first plan access. Cross-interface
      integration tests in task-management.integration.test.ts must pass. Update
      test fixtures using readAllPlans(), readPlanFile(), writePlanFile() to set
      up plans in DB. Write new tests for: DB-first resolution (by ID, UUID),
      DB-first writes (verify DB updated), withPlanAutoSync() integration,
      parent cascade with DB-only plans, tim add creates DB record without tasks
      dir, tim edit materialize-edit-sync-delete cycle, multi-plan transaction
      atomicity. Update review.test.ts mocks to use DB-first equivalents."
  - title: "Fix cleanup-temp.ts: DB row deleted before file unlink confirmed"
    done: true
    description: "Bug: cleanup-temp.ts removes the DB row before confirming the
      backing file was deleted. At lines 37-49, removePlanFromDb() runs first
      and any non-ENOENT failure from fs.unlink() is only logged afterward. If
      unlink fails (permissions, busy file, transient FS errors), the plan
      disappears from the DB but remains on disk — orphaned plan file,
      non-retryable through tim. Fix: Only delete from DB after a successful
      unlink, or treat ENOENT as the special case where DB deletion can proceed.
      For other unlink failures, keep the DB row intact so the user can retry
      cleanup safely."
  - title: Wrap multi-plan imports in a DB transaction
    done: true
    description: "Bug: import.ts has no DB transaction for multi-plan imports.
      importHierarchicalIssue creates/updates multiple plans (parent + N
      children) via individual writePlanFile calls in a loop (lines 483, 500).
      If the process fails midway, the DB will be in an inconsistent state with
      some children present and others missing. Other multi-plan commands
      (remove, merge, promote, split) all use db.transaction().immediate() for
      atomicity. Fix: Wrap the multi-plan import in a DB transaction, writing
      all plans atomically, then write files outside the transaction."
  - title: Fix stale allPlans snapshot in multi-issue import runs
    done: true
    description: "Bug: tim import uses a single stale allPlans snapshot for an
      entire interactive multi-issue import run. Existing-plan detection inside
      importSingleIssue() only consults that snapshot (lines 695-701), while the
      caller loops over selected issues without refreshing it (lines 1001-1014).
      If the first import in the batch creates a plan, the second import cannot
      see it, causing duplicate plans instead of updating the just-created one.
      Hierarchical imports make this worse. Fix: Refresh the plan map after each
      successful import so subsequent iterations see the current DB state. Add a
      test that imports multiple related issues in one invocation and verifies
      no duplicate plans are created."
  - title: Convert review.ts plan auto-detection to DB-first using branch name
    done: true
    description: "Compliance: review.ts findBranchSpecificPlan and
      findSingleModifiedPlanOnBranch remain file-first. When no plan file is
      specified, the review command auto-detects plans via these functions
      (defined in plans.ts:1301-1395) which scan git for files and call
      readPlanFile() — not converted to DB-first, bypassing the DB entirely.
      Fix: Update this code to instead try to infer the plan from the start of
      the branch name /^(\\d+)-/ and resolve via DB lookup."
  - title: Fix resolveReviewPlanForWrite git root resolution regression
    done: true
    description: "Bug: resolveReviewPlanForWrite uses
      getGitRoot(dirname(resolve(planArg))) which fails for non-git temp
      directories (e.g., test fixtures), falling back to process.cwd(). This
      causes resolvePlanFromDbOrSyncFile to look up the plan in the wrong
      project context. The test at review.test.ts:202-203 fails because
      reviewIssues is undefined after save. This is a regression introduced by
      the DB-first conversion. Fix: Use resolveRepoRootForPlanArg() (which
      handles the config path and has proper fallback logic) instead of raw
      getGitRoot, or accept repoRoot as a parameter."
  - title: Remove dead find_next_dependency.ts module
    done: true
    description: "Compliance: find_next_dependency.ts is dead production code. No
      production module imports findNextReadyDependency — it has been fully
      replaced by findNextReadyDependencyFromDb in plan_discovery.ts. Only test
      files reference it. Fix: Remove the module and its tests."
  - title: "Address Review Feedback: No test coverage for
      findNextReadyDependencyFromDb, findLatestPlanFromDb, or
      findNextPlanFromDb."
    done: true
    description: >-
      No test coverage for findNextReadyDependencyFromDb, findLatestPlanFromDb,
      or findNextPlanFromDb. The old findNextReadyDependency had 45 unit tests
      (1,757 lines in find_next_dependency.test.ts) covering BFS traversal,
      circular dependency handling, priority ordering, empty plans, multi-level
      dependency chains, and edge cases. The replacement functions have zero
      dedicated test coverage — they are only mocked in consuming test files.
      The BFS logic and cycle detection are non-trivial and completely untested.


      Suggestion: Create plan_discovery.test.ts with tests that exercise the
      actual DB-backed functions against a real (in-memory) database. Port the
      key scenarios from the deleted find_next_dependency.test.ts.


      Related file: src/tim/commands/plan_discovery.ts:1-200
  - title: "Address Review Feedback: `resolvePlanFromDbOrSyncFile()` makes any
      passed file path authoritative again and hides failures."
    done: true
    description: |-
      `resolvePlanFromDbOrSyncFile()` makes any passed file path authoritative again and hides failures. At [src/tim/ensure_plan_in_db.ts:17](/Users/dimfeld/Documents/projects/llmutils-projects-1774226734072/src/tim/ensure_plan_in_db.ts#L17) it force-syncs the file into SQLite, and `syncPlanToDb()` turns that into `forceOverwrite` at [src/tim/db/plan_sync.ts:261](/Users/dimfeld/Documents/projects/llmutils-projects-1774226734072/src/tim/db/plan_sync.ts#L261). A stale task/materialized file therefore overwrites newer DB state just because the caller referenced a path. The blanket catch at [src/tim/ensure_plan_in_db.ts:23](/Users/dimfeld/Documents/projects/llmutils-projects-1774226734072/src/tim/ensure_plan_in_db.ts#L23) then suppresses the sync error and returns the file plan anyway, so callers cannot detect the conflict. This helper is now the shared entry point for multiple commands, so the damage is not localized.

      Suggestion: Do not force file->DB sync during generic resolution. Only sync from a file in explicit edit/import flows with conflict detection, and surface unexpected sync failures instead of swallowing them.

      Related file: src/tim/ensure_plan_in_db.ts:17
  - title: "Address Review Feedback: syncMaterializedPlan unconditionally overwrites
      DB with force: true, risking data loss on workspace reuse."
    done: true
    description: >-
      syncMaterializedPlan unconditionally overwrites DB with force: true,
      risking data loss on workspace reuse. When reusing an existing workspace
      branch, syncMaterializedPlan is called (file → DB) before materializePlan
      (DB → file). syncMaterializedPlan calls syncPlanToDb with force: true,
      which bypasses the timestamp guard in upsertPlanInTransaction. A stale
      materialized file on disk will unconditionally overwrite newer DB data.
      Scenario: Agent A materializes plan 42 into workspace. A CLI command marks
      a task done (updating DB). Agent A's workspace is reused — the stale
      .tim/plans/42.plan.md overwrites the newer DB state, losing the task
      completion.


      Suggestion: Either remove force: true from syncMaterializedPlan so the
      normal timestamp guard applies, or compare file mtime/updatedAt against DB
      updated_at before syncing.


      Related file: src/tim/workspace/workspace_setup.ts:346-355
  - title: "Address Review Feedback: generate.ts and chat.ts have no defensive guard
      for empty currentPlanFile."
    done: true
    description: >-
      generate.ts and chat.ts have no defensive guard for empty currentPlanFile.
      currentPlanFile is initialized to initialPlanFile ?? ''. If
      materialization somehow fails silently, readPlanFile('') and
      syncPlanToDb(..., '', ...) would be called with empty string. In practice,
      materialization either returns a valid path or throws, but the lack of an
      explicit guard means a future refactor could easily introduce a crash.


      Suggestion: Add if (!currentPlanFile) throw new Error('Plan file not
      materialized') before the first use of currentPlanFile.


      Related file: src/tim/commands/generate.ts:177, 303, 331
  - title: "Address Review Feedback: persistPlanPullRequests uses stale plan data
      resolved at command start rather than re-reading from DB before writing."
    done: true
    description: >-
      persistPlanPullRequests uses stale plan data resolved at command start
      rather than re-reading from DB before writing. The old code called
      readPlanFile(planPath) inside persistPlanPullRequests to get a fresh copy.
      The new code passes the currentPlan object from command start. Since
      writePlanFile does a full plan upsert with forceOverwrite: true, every
      field is written — not just pullRequest. If another process modified the
      plan between resolution and write (the window includes GitHub API calls
      for PR status refresh), those changes are silently overwritten.


      Suggestion: Re-read the plan from DB inside persistPlanPullRequests before
      writing, or do a targeted field update on just the pullRequest-related
      columns.


      Related file: src/tim/commands/pr.ts:430-461
  - title: "Address Review Feedback: MCP generate mode still pulls parent/sibling
      context and plan resources from filesystem scans instead of the DB."
    done: true
    description: |-
      MCP generate mode still pulls parent/sibling context and plan resources from filesystem scans instead of the DB. Parent/sibling prompt context uses `readAllPlans()` at [src/tim/mcp/generate_mode.ts:145](/Users/dimfeld/Documents/projects/llmutils-projects-1774226734072/src/tim/mcp/generate_mode.ts#L145), and the `tim://plans/list` / `tim://plans/ready` resources do the same at [src/tim/mcp/generate_mode.ts:772](/Users/dimfeld/Documents/projects/llmutils-projects-1774226734072/src/tim/mcp/generate_mode.ts#L772) and [src/tim/mcp/generate_mode.ts:824](/Users/dimfeld/Documents/projects/llmutils-projects-1774226734072/src/tim/mcp/generate_mode.ts#L824). Plans created DB-only by `tim add` or `create-plan` therefore disappear from MCP prompt context and resource output until a file happens to exist. That is still file-first behavior in a batch that is supposed to make the MCP surface DB-first.

      Suggestion: Replace these `readAllPlans()` calls with DB-backed loading (`loadPlansFromDb()` / direct DB queries) and add DB-only coverage for parent/sibling prompt context plus MCP resources.

      Related file: src/tim/mcp/generate_mode.ts:145
  - title: "Address Review Feedback: writePlanFile(null, ...) without cwdForIdentity
      silently uses process.cwd() for project resolution."
    done: true
    description: >-
      writePlanFile(null, ...) without cwdForIdentity silently uses
      process.cwd() for project resolution. When filePath is null and no
      cwdForIdentity option is provided, repository identity resolution falls
      through to process.cwd(). In workspace scenarios where the CWD differs
      from the target project root, this resolves against the wrong project.


      Suggestion: Make cwdForIdentity required when filePath is null, or throw
      if neither is provided.


      Related file: src/tim/plans.ts:996-1002
  - title: "Address Review Feedback: `tim validate` is still file-driven, so DB-only
      plans are not actually validated/fixed correctly and `--fix` can recreate
      task files."
    done: true
    description: |-
      `tim validate` is still file-driven, so DB-only plans are not actually validated/fixed correctly and `--fix` can recreate task files. The command still enumerates only filesystem plans at [src/tim/commands/validate.ts:583](/Users/dimfeld/Documents/projects/llmutils-projects-1774226734072/src/tim/commands/validate.ts#L583) and schema-validates only `planFiles` at [src/tim/commands/validate.ts:770](/Users/dimfeld/Documents/projects/llmutils-projects-1774226734072/src/tim/commands/validate.ts#L770). But `loadValidationPlanState()` seeds `planMap` from DB rows, so DB-only plans still reach the fix passes. Those fixes still go back through file APIs, for example [src/tim/commands/validate.ts:408](/Users/dimfeld/Documents/projects/llmutils-projects-1774226734072/src/tim/commands/validate.ts#L408) and [src/tim/utils/references.ts:383](/Users/dimfeld/Documents/projects/llmutils-projects-1774226734072/src/tim/utils/references.ts#L383). On DB-only plans that means either silent failures on missing files or writing new synthetic `tasks/<id>.plan.md` files, which violates the DB-first design this plan was supposed to deliver.

      Suggestion: Convert validation and autofix paths to operate on DB rows directly. Only materialize/write files when the user explicitly asks for a file edit, and add DB-only validate/fix tests.

      Related file: src/tim/commands/validate.ts:583
  - title: "Address Review Feedback: show.ts duplicates plan discovery logic with
      divergent priority values."
    done: true
    description: >-
      show.ts duplicates plan discovery logic with divergent priority values.
      Defines its own findNextPlanFromPlans and findNextReadyDependencyFromPlans
      that duplicate logic from plan_discovery.ts. The priority maps differ
      (show.ts omits 'maybe', uses different scale), creating behavioral
      divergence risk.


      Suggestion: Extract shared priority constants, or have show.ts call the
      DB-backed functions from plan_discovery.ts.


      Related file: src/tim/commands/show.ts:1-50
  - title: "Address Review Feedback: parsePlanIdentifier accepts '0' as a valid plan
      ID via the string path."
    done: true
    description: >-
      parsePlanIdentifier accepts '0' as a valid plan ID via the string path.
      The regex /^\d+$/.test('0') returns true, so parsePlanIdentifier('0')
      returns { planId: 0 }. The number type path has a > 0 check, but the
      string path does not.


      Suggestion: Add parsedId > 0 check in the string path.


      Related file: src/tim/plans.ts:259-260
  - title: "Address Review Feedback: writePlansWithGeneratedUuids is now a no-op
      (voids all arguments)."
    done: true
    description: >-
      writePlansWithGeneratedUuids is now a no-op (voids all arguments). The
      plansWithGeneratedUuids array from ensureReferences is always empty in the
      new code. This dead code should be cleaned up.


      Suggestion: Remove the function and its callers.


      Related file: src/tim/utils/references.ts:355-361
  - title: "Address Review Feedback: `review`/`prompts review` are not actually
      DB-first."
    done: true
    description: >-
      `review`/`prompts review` are not actually DB-first.
      `buildReviewPromptFromOptions()` still goes straight through
      `gatherPlanContext()`, and that helper still resolves plans via
      `resolvePlanFile()` and loads hierarchy via `readAllPlans(tasksDir)`. That
      means `tim prompts review <db-only-plan-id>` still fails when no task file
      exists, and even normal review flows still drop DB-only parent/child
      context because hierarchy is read only from the filesystem. This misses
      the stated DB-first conversion for review/prompt flows.


      Suggestion: Replace the file-based `gatherPlanContext()` path with
      DB-backed plan resolution/hierarchy loading. Thread
      DB-resolved/materialized paths into review prompt generation instead of
      calling `resolvePlanFile()`.


      Related file: src/tim/commands/review.ts:1884
  - title: "Address Review Feedback: `tim chat` still uses the current working tree
      instead of the configured repo when `--plan` is provided."
    done: true
    description: >-
      `tim chat` still uses the current working tree instead of the configured
      repo when `--plan` is provided. It resolves the plan with
      `getGitRoot(process.cwd())` and also seeds workspace setup from
      `getGitRoot(process.cwd())`, even though config has already been loaded.
      `tim --config /other/repo/.tim.yml chat --plan 123` will look up plan 123
      in the wrong project and prepare the wrong workspace root.


      Suggestion: Derive the repo root from the loaded config
      (`resolvePlanPathContext(config)`) or `resolveRepoRootForPlanArg()`, then
      use that repo root for both plan resolution and workspace setup.


      Related file: src/tim/commands/chat.ts:196
  - title: "Address Review Feedback: `resolvePlanFromDbOrSyncFile()` resolves direct
      paths with `path.resolve(planArg)`, which is anchored to the process CWD,
      not the target repo root/config root."
    done: true
    description: >-
      `resolvePlanFromDbOrSyncFile()` resolves direct paths with
      `path.resolve(planArg)`, which is anchored to the process CWD, not the
      target repo root/config root. Under `--config`, a relative plan path from
      another repo is resolved against the wrong directory, so commands either
      fail to find the file or sync the wrong file. This helper is now the
      shared entry point for many DB-first commands, so the regression is
      widespread.


      Suggestion: Resolve relative paths against `repoRoot` (or an explicit
      config-base dir) instead of `process.cwd()`. Add coverage for `--config`
      plus relative plan paths.


      Related file: src/tim/ensure_plan_in_db.ts:17
  - title: "Address Review Feedback: `list_ready_plans` still returns bogus
      filenames for DB-only plans."
    done: true
    description: >-
      `list_ready_plans` still returns bogus filenames for DB-only plans.
      `loadPlansFromDb()` synthesizes a filename for rows without a backing
      file, and `formatReadyPlansAsJson()` serializes that path unconditionally.
      Consumers get fake `filename` values for plans that do not exist on disk.
      The MCP generate-mode resources already guard this with `fs.existsSync()`,
      so this tool is inconsistent with the intended DB-first behavior.


      Suggestion: Blank or omit `filename` unless the file actually exists, and
      add DB-only tool coverage matching the generate-mode resource tests.


      Related file: src/tim/ready_plans.ts:219
  - title: "Address Review Feedback: `tim review --autofix` is still not DB-first
      for DB-only plans."
    done: true
    description: >-
      `tim review --autofix` is still not DB-first for DB-only plans.
      `gatherPlanContext()` returns the numeric plan ID string when there is no
      materialized file, and `handleReviewCommand()` passes that string through
      as `planFilePath` for autofix. Normal/simple executor paths then treat it
      as a real file path and call `readPlanFile(planInfo.planFilePath)`. For
      DB-only plans this is an ENOENT crash in Codex flows, and Claude
      normal/simple mode is also given a nonexistent file path to update. The
      only place that materializes a DB-only review plan is the branch-name
      auto-select path; explicit `tim review 123 --autofix` is still broken.


      Suggestion: Before invoking normal/simple autofix execution, materialize
      the plan when `planPath` is null and pass the materialized path through
      the review/autofix pipeline. Add a DB-only autofix test instead of only
      testing that `resolvedPlanFile` becomes `'123'`.


      Related file: src/tim/commands/review.ts:713-719
  - title: "Address Review Feedback: Relative plan-path resolution is still anchored
      to `process.cwd()` instead of the target repo/config root, and the write
      path can now corrupt the wrong project."
    done: true
    description: >-
      Relative plan-path resolution is still anchored to `process.cwd()` instead
      of the target repo/config root, and the write path can now corrupt the
      wrong project. `resolveRepoRootForPlanArg()` checks
      `path.resolve(planArg)` before honoring `configPath`,
      `resolvePlanFromDbOrSyncFile()` does the same and then calls
      `syncPlanToDb()`, and `resolvePlanFromDb()` also treats a CWD-relative hit
      as authoritative. Running something like `tim --config
      /other/repo/.tim.yml ... tasks/123.plan.md` from a different repo will
      resolve the local `tasks/123.plan.md` first; in write flows that file is
      then synced into SQLite for the wrong project. This is a
      correctness/data-loss bug, not just a lookup quirk.


      Suggestion: Resolve relative plan paths against an explicit repo/config
      base instead of `process.cwd()`, or disable direct-path short-circuiting
      when a different `configPath`/`repoRoot` is in play. Apply the same fix
      consistently in plan root resolution and DB lookup helpers.


      Related file: src/tim/ensure_plan_in_db.ts:17-52
  - title: "Address Review Feedback: The standalone `update-docs` and
      `update-lessons` commands still execute in the current repo instead of the
      resolved target repo."
    done: true
    description: >-
      The standalone `update-docs` and `update-lessons` commands still execute
      in the current repo instead of the resolved target repo. Both handlers
      correctly resolve `repoRoot` for the requested plan, but then immediately
      compute `baseDir` from `(await getGitRoot()) || process.cwd()` and pass
      that to the executor. With `--config` or any cross-repo invocation, the
      LLM runs against the wrong working tree and can modify the wrong
      repository's docs.


      Suggestion: Use the resolved `repoRoot` consistently as `baseDir` in both
      command handlers and helper entry points. Mirror the same fix in
      `update-lessons.ts`.


      Related file: src/tim/commands/update-docs.ts:157-167,234-246
  - title: "Address Review Feedback: `resolvePlanRowForTransaction` parameter is
      named `uuidToPlanId: Map<number, string>` but it actually receives a
      planId→uuid map."
    done: true
    description: >-
      `resolvePlanRowForTransaction` parameter is named `uuidToPlanId:
      Map<number, string>` but it actually receives a planId→uuid map. The
      function internally builds a reverse map before passing to
      `planRowToSchemaInput`. The logic works correctly, but the misleading name
      will cause bugs when a future caller passes an actual uuid→planId map. The
      same pattern appears in `planRowForTransaction` in `plans_db.ts`.


      Suggestion: Rename the parameter to `planIdToUuid: Map<number, string>` in
      both `resolvePlanRowForTransaction` (create_plan.ts) and
      `planRowForTransaction` (plans_db.ts) to match the actual data direction.


      Related file: src/tim/tools/create_plan.ts:207
  - title: "Address Review Feedback: Workspace reuse still overwrites existing
      workspace plan files without the stale-file protection added elsewhere."
    done: true
    description: >-
      Workspace reuse still overwrites existing workspace plan files without the
      stale-file protection added elsewhere. In `workspace.ts`, the
      reused-workspace path blindly copies `options.resolvedPlanFilePath` into
      the workspace with `fs.writeFile()`. There is no equivalent of the
      `syncMaterializedPlan()` + re-materialize flow that was added in
      `workspace_setup.ts` for reused agent/generate/chat workspaces. If the
      reused workspace already contains local plan edits from a previous
      session, they are silently discarded.


      Suggestion: On reuse, detect an existing workspace plan file and sync or
      compare it before overwriting. Reuse the same pre-sync/rematerialize logic
      already implemented in `workspace_setup.ts` instead of raw file copying.


      Related file: src/tim/commands/workspace.ts:837-849
  - title: "Address Review Feedback: DB-only plans still leak bogus file paths in
      user-facing output."
    done: true
    description: >-
      DB-only plans still leak bogus file paths in user-facing output.
      `loadPlansFromDb()` fabricates `filename` values for every row, and `tim
      list --show-files` plus `tim ready --verbose` print those paths without
      checking whether the file exists. That contradicts the DB-first behavior
      already fixed in other surfaces and sends users to nonexistent files.


      Suggestion: Only render a filename when it actually exists on disk,
      matching the `existsSync` guards already added in other DB-first outputs.
      The same guard is needed in `ready.ts` verbose output.


      Related file: src/tim/commands/list.ts:482-483
  - title: "Address Review Feedback: `isPlanNotFoundError` uses broad string
      matching (`error.message.includes('not found')`) which could match
      unrelated errors like 'Module not found' or 'File not found'."
    done: true
    description: >-
      `isPlanNotFoundError` uses broad string matching
      (`error.message.includes('not found')`) which could match unrelated errors
      like 'Module not found' or 'File not found'. This function is the
      gatekeeper for `resolvePlanFromDbOrSyncFile` fallback behavior — a false
      positive causes the function to attempt file sync instead of propagating a
      real error.


      Suggestion: Create a `PlanNotFoundError` class and throw it from
      `resolvePlanFromDb()` instead of generic Error. Then check `instanceof
      PlanNotFoundError` instead of string matching.


      Related file: src/tim/ensure_plan_in_db.ts:5-11
  - title: "Address Review Feedback: `readPlanFile` generates a UUID and calls
      `writePlanFile()` when a plan file lacks one (line 745-758)."
    done: true
    description: >-
      `readPlanFile` generates a UUID and calls `writePlanFile()` when a plan
      file lacks one (line 745-758). In the DB-first architecture, this means a
      nominally read-only operation triggers a DB insert as a side effect.
      Callers expecting a pure read may be surprised by DB mutations.


      Suggestion: Consider separating UUID generation into an explicit step, or
      documenting the write side effect prominently so callers are aware.


      Related file: src/tim/plans.ts:745-758
changedFiles:
  - .tim/plans/.gitignore
  - CLAUDE.md
  - claude-plugin/skills/using-tim/references/cli-commands.md
  - docs/database.md
  - docs/implementer-instructions.md
  - docs/import_command.md
  - docs/multi-workspace-workflow.md
  - docs/next-ready-feature.md
  - docs/parent-child-relationships.md
  - docs/reviewer-instructions.md
  - src/tim/assignments/uuid_lookup.ts
  - src/tim/commands/add-task.test.ts
  - src/tim/commands/add-task.ts
  - src/tim/commands/add.db-first.test.ts
  - src/tim/commands/add.details.test.ts
  - src/tim/commands/add.test.ts
  - src/tim/commands/add.ts
  - src/tim/commands/agent/agent.auto_claim.integration.test.ts
  - src/tim/commands/agent/agent.notifications.test.ts
  - src/tim/commands/agent/agent.serial.capture_output.test.ts
  - src/tim/commands/agent/agent.test.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/agent/agent_batch_mode.test.ts
  - src/tim/commands/agent/batch_mode.ts
  - src/tim/commands/agent/batch_tasks_unit.test.ts
  - src/tim/commands/agent/parent_completion.test.ts
  - src/tim/commands/agent/parent_plans.ts
  - src/tim/commands/agent/stub_plan.test.ts
  - src/tim/commands/agent/stub_plan.ts
  - src/tim/commands/assignments.ts
  - src/tim/commands/branch.test.ts
  - src/tim/commands/branch.ts
  - src/tim/commands/chat.test.ts
  - src/tim/commands/chat.ts
  - src/tim/commands/cleanup-temp.test.ts
  - src/tim/commands/cleanup-temp.ts
  - src/tim/commands/compact.test.ts
  - src/tim/commands/compact.ts
  - src/tim/commands/description.test.ts
  - src/tim/commands/description.ts
  - src/tim/commands/done.test.ts
  - src/tim/commands/done.ts
  - src/tim/commands/edit.test.ts
  - src/tim/commands/edit.ts
  - src/tim/commands/extract.ts
  - src/tim/commands/generate.auto_claim.integration.test.ts
  - src/tim/commands/generate.test.ts
  - src/tim/commands/generate.ts
  - src/tim/commands/import/import.integration.test.ts
  - src/tim/commands/import/import.test.ts
  - src/tim/commands/import/import.ts
  - src/tim/commands/import/import_hierarchical.test.ts
  - src/tim/commands/import/integration_linear.test.ts
  - src/tim/commands/list.test.ts
  - src/tim/commands/list.ts
  - src/tim/commands/materialized_edit.ts
  - src/tim/commands/merge.test.ts
  - src/tim/commands/merge.ts
  - src/tim/commands/plan_discovery.test.ts
  - src/tim/commands/plan_discovery.ts
  - src/tim/commands/pr.test.ts
  - src/tim/commands/pr.ts
  - src/tim/commands/promote.test.ts
  - src/tim/commands/promote.ts
  - src/tim/commands/prompts.ts
  - src/tim/commands/ready.test.ts
  - src/tim/commands/ready.ts
  - src/tim/commands/release.ts
  - src/tim/commands/remove-task.ts
  - src/tim/commands/remove.db-cleanup-order.test.ts
  - src/tim/commands/remove.test.ts
  - src/tim/commands/remove.ts
  - src/tim/commands/renumber.test.ts
  - src/tim/commands/renumber.ts
  - src/tim/commands/review.notifications.test.ts
  - src/tim/commands/review.test.ts
  - src/tim/commands/review.ts
  - src/tim/commands/review.tunnel.test.ts
  - src/tim/commands/set-task-done.test.ts
  - src/tim/commands/set-task-done.ts
  - src/tim/commands/set.db-first.test.ts
  - src/tim/commands/set.test.ts
  - src/tim/commands/set.ts
  - src/tim/commands/show.test.ts
  - src/tim/commands/show.ts
  - src/tim/commands/split.test.ts
  - src/tim/commands/split.ts
  - src/tim/commands/subagent.test.ts
  - src/tim/commands/subagent.ts
  - src/tim/commands/task-management.integration.test.ts
  - src/tim/commands/tools.test.ts
  - src/tim/commands/update-docs.test.ts
  - src/tim/commands/update-docs.ts
  - src/tim/commands/update-lessons.test.ts
  - src/tim/commands/update-lessons.ts
  - src/tim/commands/validate.test.ts
  - src/tim/commands/validate.ts
  - src/tim/commands/workspace.reuse.test.ts
  - src/tim/commands/workspace.ts
  - src/tim/commands/workspace.update.test.ts
  - src/tim/db/plan.ts
  - src/tim/db/plan_sync.ts
  - src/tim/ensure_plan_in_db.test.ts
  - src/tim/ensure_plan_in_db.ts
  - src/tim/id_utils.test.ts
  - src/tim/id_utils.ts
  - src/tim/mcp/README.md
  - src/tim/mcp/generate_mode.test.ts
  - src/tim/mcp/generate_mode.ts
  - src/tim/mcp/prompts/compact_plan.ts
  - src/tim/plan_display.test.ts
  - src/tim/plan_display.ts
  - src/tim/plan_materialize.test.ts
  - src/tim/plan_materialize.ts
  - src/tim/plan_repo_root.test.ts
  - src/tim/plan_repo_root.ts
  - src/tim/plans/mark_done.test.ts
  - src/tim/plans/mark_done.ts
  - src/tim/plans/parent_cascade.ts
  - src/tim/plans/resolve_writable_path.ts
  - src/tim/plans/yaml_passthrough.ts
  - src/tim/plans.test.ts
  - src/tim/plans.ts
  - src/tim/plans_db.ts
  - src/tim/ready_plans.test.ts
  - src/tim/ready_plans.ts
  - src/tim/review_runner.ts
  - src/tim/tags.integration.test.ts
  - src/tim/tim.integration.test.ts
  - src/tim/tools/create_plan.test.ts
  - src/tim/tools/create_plan.ts
  - src/tim/tools/list_ready_plans.test.ts
  - src/tim/tools/list_ready_plans.ts
  - src/tim/tools/manage_plan_task.ts
  - src/tim/tools/update_plan_details.ts
  - src/tim/tools/update_plan_tasks.ts
  - src/tim/utils/context_gathering.test.ts
  - src/tim/utils/context_gathering.ts
  - src/tim/utils/references.ts
  - src/tim/workspace/workspace_setup.test.ts
  - src/tim/workspace/workspace_setup.ts
tags:
  - architecture
references:
  "278": 8c8ba325-58ad-4033-b45a-a9a1efd654a6
  "279": 9912c78d-87f8-4e88-987a-2b577ac925a6
---

## Planned Work

1. **Update resolvePlan() to load from DB instead of file scanning** — Currently resolvePlan() scans the tasks directory for plan files. Change it to query the DB by plan ID, UUID, or title search. The function should return plan data from the DB along with the materialized file path (if one exists). This is the central change that most commands depend on.

2. **Update writePlanFile() to write DB first, then materialize** — Invert the current flow: instead of writing the file and then syncing to DB, write to DB first and then materialize the file if one exists. This ensures DB is always up-to-date even if file write fails. Keep the function signature compatible so callers don't all need to change at once.

3. **Update tim tools commands to use DB-first pattern** — Update update-plan-tasks, manage-plan-task, update-plan-details, get-plan, and create-plan to use the auto-sync wrapper from plan 279. They should: sync any existing materialized file → DB, modify DB, re-materialize. This replaces the current read-file/modify/write-file pattern.

4. **Update tim set command for DB-first** — The set command modifies plan metadata (status, priority, dependencies, tags, etc.). Update it to modify the DB directly and re-materialize if needed, instead of reading/writing plan files.

5. **Update tim add / create-plan to write DB only** — New plans should be created in the DB without requiring a tasks directory or file. The file path in DB can be null/empty for plans that haven't been materialized yet. Print the plan ID and optionally materialize if --edit flag is used.

6. **Update tim edit to use materialize/edit/sync cycle** — The edit command should: materialize the plan to a temp or cache path, open $EDITOR, then sync the result back to DB on editor close. This replaces direct file editing.

7. **Update plan list/display commands to use DB** — Update tim list, tim ready, and plan_display.ts to query from DB instead of scanning files. Most of these already have DB paths (loadPlansFromDb) — make DB the primary path and remove file-scanning fallbacks.

8. **Update done/set-task-done commands for DB-first** — These commands mark tasks/plans as done. Update to modify DB directly, using the auto-sync wrapper to handle any existing materialized files.

## Research

### Overview

This plan converts all tim CLI commands and MCP tools from a file-first to a DB-first plan access pattern. Currently, the source of truth is YAML plan files on disk in a `tasks/` directory. The DB (SQLite) is a synchronized cache. Plan 279 built the materialization infrastructure (`materializePlan`, `syncMaterializedPlan`, `withPlanAutoSync`) that enables bidirectional DB↔file sync. This plan uses that infrastructure to make the DB the authoritative source for all plan reads and writes.

### Critical Discoveries

#### Current Data Flow (File-First)
1. **Reading**: `resolvePlanFile()` (in `src/tim/plans.ts:236-308`) finds plans by scanning the `tasks/` directory. It resolves paths, filenames, and numeric IDs by calling `readAllPlans()` which glob-scans all `*.plan.md`/`*.yml` files. Then `readPlanFile()` parses the YAML frontmatter + markdown body.
2. **Writing**: `writePlanFile()` (in `src/tim/plans.ts:652-756`) writes YAML to disk, then calls `syncPlanToDb()` to update the DB cache. The DB is always secondary.
3. **Listing**: `list.ts` and `ready.ts` already have dual paths — they try `loadPlansFromDb()` first and fall back to `readAllPlans()` if DB returns empty. The `--local` flag forces file scanning.

#### Plan Resolution Chain
The central resolution chain is:
- `resolvePlan()` in `plan_display.ts:94-101` → calls `resolvePlanFile()` → calls `readPlanFile()`
- `resolvePlanFile()` in `plans.ts:236-308` → tries file path, filename in tasks dir, then numeric ID lookup via `readAllPlans()`
- Every MCP tool and most CLI commands use either `resolvePlan()` or `resolvePlanFile()` + `readPlanFile()`

#### Materialization Infrastructure (Plan 279)
Already built in `src/tim/plan_materialize.ts`:
- `materializePlan(planId, repoRoot, options)` — DB → `.tim/plans/{planId}.plan.md`
- `syncMaterializedPlan(planId, repoRoot, options)` — `.tim/plans/{planId}.plan.md` → DB
- `withPlanAutoSync(planId, repoRoot, fn)` — Pre-syncs file→DB, runs fn(), post-syncs DB→file. Checks file existence before syncing. Error in finally block doesn't mask fn() errors.
- `getMaterializedPlanPath(repoRoot, planId)` — Returns `.tim/plans/{planId}.plan.md`
- `resolveProjectContext(repoRoot)` — Caches DB queries for project, plans, UUID maps

#### DB CRUD Layer
`src/tim/db/plan.ts` provides synchronous (bun:sqlite) operations:
- `getPlanByPlanId(db, projectId, planId)` — Look up by numeric ID
- `getPlanByUuid(db, uuid)` — Look up by UUID
- `upsertPlan(db, projectId, input)` — INSERT...ON CONFLICT upsert with timestamp comparison
- `upsertPlanTasks(db, planUuid, tasks)` — Replace all tasks
- `upsertPlanDependencies(db, planUuid, depUuids)` — Replace all dependencies
- `getPlanTasksByUuid(db, uuid)` — Get tasks for a plan
- `getPlanDependenciesByUuid(db, uuid)` — Get dependencies
- `getPlanTagsByUuid(db, uuid)` — Get tags

`src/tim/plans_db.ts` provides:
- `loadPlansFromDb(searchDir, repositoryId)` — Loads all plans from DB, converts to `PlanWithFilename` format
- `planRowToSchemaInput(row, tasks, deps, tags, uuidToPlanId)` — Converts DB row to `PlanSchemaInput`

#### Command-by-Command Analysis

| Command | Current Loading | Current Writing | Key Concern |
|---------|----------------|-----------------|-------------|
| **add** | `readAllPlans()` for ID generation, parent lookup | `writePlanFile()` (new plan + parent update) | Must write DB only, no tasks dir requirement |
| **set** | `resolvePlanFile()` + `readPlanFile()` + `readAllPlans()` for parents | `writePlanFile()` (plan + parent updates) | Complex bidirectional parent/dep updates |
| **done** | `resolvePlanFile()` + `readPlanFile()` via `mark_done.ts` | `writePlanFile()` | Also updates changedFiles from Git, cascades to parent |
| **edit** | `resolvePlanFile()` + `readPlanFile()` (twice) | `writePlanFile()` after editor | Must materialize→edit→sync |
| **generate** | `resolvePlanFile()` + `readPlanFile()` | Executor writes file, then `syncPlanToDb()` | Special: executor modifies file directly |
| **chat** | `resolvePlanFile()` + `readPlanFile()` | Executor writes file | Similar to generate |
| **list** | Already DB-first with file fallback | None (read-only) | Remove fallback, make DB primary |
| **ready** | Already DB-first with file fallback | None (read-only) | Same as list |
| **validate** | `readAllPlans()` | `writePlanFile()` if renumbering | Needs DB-first validation approach |
| **MCP tools** | `resolvePlan()` or `readAllPlans()` | `writePlanFile()` | All need `withPlanAutoSync` wrapper |

#### MCP Tools Analysis
- `create_plan.ts` — Uses `readAllPlans()` for ID gen and parent lookup, writes via `writePlanFile()`
- `update_plan_details.ts` — Uses `resolvePlan()`, modifies details, writes via `writePlanFile()`
- `update_plan_tasks.ts` — Uses `resolvePlan()`, merges tasks, writes via `writePlanFile()`
- `manage_plan_task.ts` — Uses `resolvePlan()` for add/update/remove task, writes via `writePlanFile()`
- `get_plan.ts` — Uses `resolvePlan()`, read-only
- `list_ready_plans.ts` — Already DB-first with file fallback

#### Web Interface
The web interface (`src/lib/server/db_queries.ts`) already reads exclusively from the DB — no file access. It does not write plans; modifications happen via spawned CLI commands. This means the web interface is already DB-first and needs no changes for this plan.

#### Parent-Child Relationship Management
Several commands maintain bidirectional parent-child relationships:
- `add.ts` — Updates parent's dependencies when creating a child
- `set.ts` — Updates old/new parent when changing parent, handles `checkAndMarkParentDone()`
- `mark_done.ts` — Cascades done status to parent via `checkAndMarkParentDone()`
- `checkAndMarkParentDone()` exists in two places: `mark_done.ts` (local function) and `commands/agent/parent_plans.ts` (exported). The `set.ts` command imports from `parent_plans.ts`.

These functions use `readAllPlans()` to find parent and children — they need to switch to DB queries.

#### UUID/Reference Management
`ensureReferences()` and `writePlansWithGeneratedUuids()` from `src/tim/utils/references.ts` handle UUID generation and cross-plan reference tracking. These currently operate on plan files. They'll need to work with DB-sourced plans.

#### The `readAllPlans()` Cache
`readAllPlans()` in `plans.ts:69-174` maintains an in-memory cache keyed by directory. It returns `{ plans, maxNumericId, duplicates, uuidToId, idToUuid, erroredFiles }`. Many commands depend on this cache for ID generation, parent lookup, and cross-plan operations. The DB-first equivalent needs to provide the same data structure.

### Notable Files

- `src/tim/plans.ts` — Core plan I/O: `resolvePlanFile()`, `readPlanFile()`, `writePlanFile()`, `readAllPlans()`, `clearPlanCache()`
- `src/tim/plan_display.ts` — `resolvePlan()`, `buildPlanContext()`
- `src/tim/plans_db.ts` — `loadPlansFromDb()`, `planRowToSchemaInput()`
- `src/tim/plan_materialize.ts` — `materializePlan()`, `syncMaterializedPlan()`, `withPlanAutoSync()`
- `src/tim/db/plan.ts` — DB CRUD operations
- `src/tim/db/plan_sync.ts` — `syncPlanToDb()`, `syncAllPlansToDb()`
- `src/tim/plan_merge.ts` — `mergeTasksIntoPlan()`, `updateDetailsWithinDelimiters()`
- `src/tim/ready_plans.ts` — `filterAndSortReadyPlans()`, `isReadyPlan()`
- `src/tim/plans/mark_done.ts` — `markStepDone()`, `markTaskDone()`, `setTaskDone()`, local `checkAndMarkParentDone()`
- `src/tim/commands/agent/parent_plans.ts` — Exported `checkAndMarkParentDone()`, `markParentInProgress()`
- `src/tim/utils/references.ts` — `ensureReferences()`, `writePlansWithGeneratedUuids()`
- `src/tim/id_utils.ts` — `generateNumericPlanId()`
- `src/tim/commands/` — All CLI command handlers
- `src/tim/tools/` — All MCP tool handlers
- `src/tim/configSchema.ts` — `resolveTasksDir()` config resolution

### Architectural Hazards & Edge Cases

1. **Executor writes to plan files directly** — The `generate` and `chat` commands use an executor (Claude Code, Codex CLI) that modifies the plan file on disk. This file is inside a workspace. After execution, `generate` does `readPlanFile(currentPlanFile)` + `syncPlanToDb()`. With DB-first, the plan file in the workspace IS the materialized file, so the existing `syncPlanToDb()` post-execution call already handles this.

2. **Parent cascade reads all plans** — `checkAndMarkParentDone()` calls `readAllPlans()` to find all children and check their statuses. This needs to become a DB query, but the two copies (mark_done.ts and parent_plans.ts) need to be kept in sync or consolidated.

3. **`writePlanFile()` signature change** — Currently `writePlanFile(filePath, plan, options)` writes a file then syncs to DB. Inverting this to "write DB then materialize" changes the semantics. The `filePath` parameter becomes the materialization target rather than the source of truth. The `skipSync` option becomes `skipFile`.

4. **ID generation** — `generateNumericPlanId()` in `id_utils.ts` gets the max ID from `readAllPlans()`. This needs to use `max(plan_id)` from DB instead.

5. **Transaction boundaries** — Multi-plan updates (e.g., creating child + updating parent, marking done + cascading to parent) should be wrapped in DB transactions for atomicity.

6. **Validate/renumber commands** — Convert to DB-first. Many file-based validation concerns (missing UUIDs, missing parent references) become non-issues with DB schema constraints. Circular dependency detection still relevant.

### Dependencies & Prerequisites

- **Plan 279 (done)**: Provides `materializePlan`, `syncMaterializedPlan`, `withPlanAutoSync`, `resolveProjectContext`
- **DB must be populated**: Plans must exist in DB. If a plan isn't found in DB, it's an error — no file fallback. Users must run `tim sync` first if DB is empty.
- **Existing tests**: Cross-interface integration tests in `src/tim/commands/task-management.integration.test.ts` must continue to pass

## Implementation Guide

### Strategy Overview

The implementation follows a bottom-up approach: first update the core resolution and write functions, then update commands that depend on them. The key insight is that `resolvePlan()` and `writePlanFile()` are the two central chokepoints — most commands go through them. By making these DB-first, many commands get the new behavior with minimal changes.

### Phase 1: Core Resolution — Make `resolvePlan()` DB-First

**Goal**: `resolvePlan()` returns plan data from the DB instead of scanning files.

#### Step 1.1: Create a DB-first plan resolution function

Create a new function `resolvePlanFromDb()` in `src/tim/plans.ts` (or a new file) that:
1. Takes a plan argument (numeric ID, UUID, or file path) and project context
2. Queries the DB using `getPlanByPlanId()` or `getPlanByUuid()`
3. Converts the DB row to `PlanSchema` using `planRowToSchemaInput()` plus task/dependency/tag fetching
4. Returns `{ plan: PlanSchema, planPath: string | null }` where planPath is the materialized file path (derived from `getMaterializedPlanPath()` using the plan ID) if one exists on disk
5. Errors if the plan is not found in DB — no file fallback

**Why this approach**: Rather than modifying `resolvePlanFile()` directly (which would break everything at once), create a parallel function and migrate callers incrementally.

**Key detail**: The function needs project context (project ID) to query by plan ID. Use `resolveProjectContext()` from `plan_materialize.ts` which already provides plan rows and UUID maps, extended with `maxNumericId`.

#### Step 1.2: Update `resolvePlan()` in `plan_display.ts`

Change `resolvePlan()` to use the new DB-first resolution. This is the function used by all MCP tools. Update it to:
1. Query DB via `resolvePlanFromDb()`
2. Error if plan not found in DB
3. Return `{ plan, planPath }` where planPath may be null

**Important**: `buildPlanContext()` uses `planPath` to compute a relative path for display. If the plan hasn't been materialized, display the plan ID instead of a path.

#### Step 1.3: Extend `resolveProjectContext()` with `maxNumericId`

Update `resolveProjectContext()` in `plan_materialize.ts` to also compute `maxNumericId` from the loaded plan rows. This replaces the `readAllPlans().maxNumericId` used by `generateNumericPlanId()`.

### Phase 2: Invert `writePlanFile()` to DB-First

#### Step 2.1: Create a `writePlanToDb()` function

Create a new function that:
1. Takes `PlanSchemaInput` and project context
2. Validates the plan (same `phaseSchema.safeParse()` as current `writePlanFile`)
3. Applies normalizations (fancy quotes, deprecated fields) that `writePlanFile()` currently does
4. Calls `upsertPlan()` to write to DB in a transaction
5. Calls `upsertPlanTasks()`, `upsertPlanDependencies()`, `upsertPlanTags()` for related data within the same transaction
6. Handles `skipUpdatedAt` option like current `writePlanFile()`
7. Does NOT handle file materialization — that's the caller's responsibility

#### Step 2.2: Update `writePlanFile()` to write DB first

Modify `writePlanFile()`:
1. Write to DB first (via the new `writePlanToDb()`)
2. Then write to file (for plans that have a file path / are materialized)
3. The `skipSync` option becomes `skipFile` — skip the file write (useful when only the DB matters)

**Signature consideration**: Keep the `filePath` parameter but allow it to influence whether a file is written. If no file path is provided, only DB is updated. If a file path is provided, both DB and file are updated.

**Note on `PlanWithFilename`**: Phase out this type. DB-first functions return `PlanSchema` directly. When a file path is needed, derive it from `getMaterializedPlanPath(repoRoot, planId)`. The `filename` DB field becomes vestigial — materialized paths are deterministic from plan ID.

### Phase 3: Update MCP Tools

MCP tools are the simplest to convert because they all follow the same pattern: `resolvePlan()` → modify → `writePlanFile()`.

#### Step 3.1: Update `get_plan.ts`
- Replace `resolvePlan()` with DB-first resolution
- Read-only, no write changes needed

#### Step 3.2: Update `update_plan_details.ts`
- Use `withPlanAutoSync()` wrapper around the modification
- Inside the wrapper: load from DB, call `updateDetailsWithinDelimiters()`, write to DB

#### Step 3.3: Update `update_plan_tasks.ts`
- Use `withPlanAutoSync()` wrapper
- Inside: load from DB, call `mergeTasksIntoPlan()`, write to DB

#### Step 3.4: Update `manage_plan_task.ts` (add/update/remove task)
- Use `withPlanAutoSync()` for each operation
- Inside: load from DB, modify task array, write to DB

#### Step 3.5: Update `create_plan.ts`
- Write new plan directly to DB via `upsertPlan()`
- No file creation needed (no tasks dir requirement)
- Generate numeric ID from `max(plan_id)` in DB instead of `readAllPlans()`
- Handle parent updates via DB reads/writes
- Optionally materialize if caller needs a file

#### Step 3.6: Update `list_ready_plans.ts`
- Already DB-first with fallback — remove the `readAllPlans()` fallback
- Make DB the only path

### Phase 4: Update CLI Commands

#### Step 4.1: Update `add.ts`
- Write new plan to DB instead of creating a file in tasks dir
- Use `max(plan_id)` from DB for ID generation
- Handle parent updates via DB reads/writes instead of `readAllPlans()`
- Remove `fs.mkdir(targetDir)` requirement
- Optionally materialize with `--edit` flag

#### Step 4.2: Update `set.ts`
- Load plan from DB instead of `readPlanFile()`
- Apply metadata changes in-memory
- Write to DB, then re-materialize if file exists
- Parent/dependency cascading updates use DB queries instead of `readAllPlans()`
- Wrap in `withPlanAutoSync()` if plan has a materialized file

#### Step 4.3: Update `edit.ts`
- Materialize plan to `.tim/plans/{planId}.plan.md`
- Open `$EDITOR` on the materialized file
- After editor closes, sync the file back to DB via `syncMaterializedPlan()`
- Delete the materialized file after successful sync
- This replaces the current direct-file editing pattern

#### Step 4.4: Update `done.ts` / `mark_done.ts`
- Load plan from DB
- Mark task done, update changedFiles from Git
- Write to DB, re-materialize if file exists
- Parent cascade uses DB instead of `readAllPlans()` (via consolidated `checkAndMarkParentDone()`)

#### Step 4.5: Update `list.ts`
- Remove the `readAllPlans()` fallback — make `loadPlansFromDb()` the only path
- Keep `--local` flag for backward compatibility (still uses file scanning)

#### Step 4.6: Update `ready.ts`
- Same as list — remove file fallback, DB is primary

#### Step 4.7: Update `generate.ts`
- Resolve plan from DB instead of `resolvePlanFile()`
- Materialize plan into workspace's `.tim/plans/{planId}.plan.md` instead of copying task file
- Update `setupWorkspace()` to drop the file-copy logic — workspace gets the plan via materialization
- Executor modifies the materialized file in the workspace
- After executor finishes: `syncMaterializedPlan()` to sync back to DB

#### Step 4.8: Update `chat.ts`
- Same pattern as generate — resolve from DB, materialize into workspace, executor works with file, sync back to DB

#### Step 4.9: Update `branch.ts`
- Resolve plan from DB instead of `resolvePlanFile()` + `readPlanFile()`
- Replace `readAllPlans()` with DB query for plan lookup
- Read-only plan access (creates Git branches, doesn't modify plans)

#### Step 4.10: Update `agent.ts` / `batch_mode.ts` / `stub_plan.ts`
- Agent resolves plan from DB instead of file
- Materializes plan into workspace via `materializePlan()` instead of file copy
- `batch_mode.ts` uses DB for plan state updates (marking done, parent cascade) via consolidated `checkAndMarkParentDone()`
- `stub_plan.ts` reads/writes plan state via DB
- `markParentInProgress()` in `parent_plans.ts` also converted to DB queries
- Post-agent sync: materialized file changes synced back to DB
- Ensure session info (sent to web UI via WebSocket) uses plan DB ID/UUID rather than relying on file path

**Note**: This step absorbs the scope of plan 281 (Agent workspace materialization integration), which has been cancelled.

#### Step 4.11: Update `validate.ts`
- Convert to DB-first: query all plans from DB instead of `readAllPlans()`
- Remove file-based validation concerns that DB schema handles (missing UUIDs, missing parent references)
- Keep circular dependency detection
- Renumbering updates DB records and re-materializes any existing files

### Phase 5: Update Support Functions

#### Step 5.1: Consolidate and convert `checkAndMarkParentDone()`
- Merge the two copies (mark_done.ts local function and parent_plans.ts exported function) into a single shared implementation
- Use DB queries instead of `readAllPlans()`: query children by `parent_uuid`, check statuses from DB
- Write parent update to DB in a transaction
- Place in a shared location (e.g., `src/tim/plans/parent_cascade.ts`) importable by both mark_done.ts and agent code

#### Step 5.2: Update ID generation
- `generateNumericPlanId()` should use `resolveProjectContext().maxNumericId` from DB instead of `readAllPlans().maxNumericId`

#### Step 5.3: Simplify `ensureReferences()`
- All plans now have UUIDs (generated at creation time), so UUID generation is not needed
- `ensureReferences()` becomes a simple DB lookup: resolve numeric plan IDs to UUIDs via `resolveProjectContext().planIdToUuid`
- `writePlansWithGeneratedUuids()` can be simplified or removed since UUIDs are always present

### Phase 6: Testing

#### Step 6.1: Update existing tests
- The cross-interface integration tests in `task-management.integration.test.ts` must pass
- Update test fixtures that mock `readAllPlans()` or `readPlanFile()` to work with DB

#### Step 6.2: Write new tests
- Test DB-first resolution: plan by ID, UUID, and file path
- Test DB-first writes: verify DB is updated before file
- Test `withPlanAutoSync()` integration with modified commands
- Test parent cascade with DB-only plans (no files on disk)
- Test `tim add` creates DB record without tasks dir
- Test `tim edit` materialize→edit→sync cycle

### Manual Testing Steps
1. `tim add "Test Plan"` — verify plan appears in DB, no file created in tasks/
2. `tim list` — verify DB-created plan appears
3. `tim set 123 --status in_progress` — verify DB updated
4. `tim edit 123` — verify materializes, opens editor, syncs back
5. `tim generate 123` — verify resolves from DB, executor writes file, syncs back
6. Create a plan with parent, mark child done — verify parent cascade works via DB

### Rationale for Approach

**Why bottom-up (core functions first)?** Changing `resolvePlan()` and `writePlanFile()` gives the widest impact with the fewest code changes. Most commands use these functions, so updating them propagates DB-first behavior throughout.

**Why no file fallback?** The DB has been populated for all existing plans. If a plan isn't in the DB, it's an error — the user should run `tim sync` to populate the DB. This keeps the code simple and avoids dual-path complexity.

**Why use `withPlanAutoSync()` for MCP tools?** MCP tools run during agent sessions where materialized files may exist in the workspace. The auto-sync wrapper ensures file edits by the agent are captured before the tool modifies the plan, and the modified plan is re-materialized after.

### Expected Behavior/Outcome

After implementation:
- All `tim` CLI commands and MCP tools read plan data from SQLite DB as the source of truth
- New plans created with `tim add` exist only in DB — no tasks directory or file required
- `tim edit` materializes plans on-demand for editing, then syncs back to DB
- Materialized files (in `.tim/plans/`) are kept in sync via `withPlanAutoSync()`
- The `--local` flag on `list` and `ready` commands retains file-scanning behavior for backward compatibility
- The web interface continues to work without changes (already DB-first)
- `generate` and `chat` commands work with materialized files in workspaces, syncing back to DB after execution

### Acceptance Criteria

- [ ] `resolvePlan()` queries DB by plan ID and UUID (errors if not found, no file fallback)
- [ ] `writePlanFile()` writes DB first, then materializes to file
- [ ] `tim add` creates plans in DB without requiring a tasks directory
- [ ] `tim set` modifies plan metadata via DB, re-materializes if file exists
- [ ] `tim edit` materializes → opens editor → syncs back to DB
- [ ] `tim done` marks tasks/plans done via DB, handles parent cascade via DB queries
- [ ] `tim list` and `tim ready` use DB as primary source (file fallback only via --local)
- [ ] All MCP tools (create, update-details, update-tasks, manage-task, get-plan, list-ready) use DB-first pattern
- [ ] `tim generate` resolves plan from DB, executor writes file, result syncs to DB
- [ ] Parent-child cascade operations use DB queries instead of `readAllPlans()`
- [ ] `checkAndMarkParentDone()` consolidated into a single shared DB-backed implementation
- [ ] `tim validate` and renumbering work with DB records
- [ ] `generate`, `chat`, and `agent` materialize plans into workspace instead of copying task files
- [ ] `setupWorkspace()` no longer copies plan files — materialization replaces file copy
- [ ] Cross-interface integration tests pass (`task-management.integration.test.ts`)
- [ ] All new code paths are covered by tests

### Dependencies & Constraints

- **Dependencies**: Plan 279 (done) — provides materialization infrastructure
- **Technical Constraints**: bun:sqlite is synchronous; DB operations must not be awaited. `writePlanFile()` is async (for file I/O), so the DB write happens synchronously within an async function.
- **No Backward Compatibility**: Plans must exist in DB. No file fallback. Users must run `tim sync` if DB is empty.
- **Executor Constraint**: `generate` and `chat` executors write directly to plan files in workspaces. Plans are materialized into workspace before execution, then synced back to DB after.

### Implementation Notes

- **Recommended Approach**: Start with Phase 1 (core resolution) to establish the pattern, then migrate MCP tools (Phase 3) as they're simpler and more uniform, then CLI commands (Phase 4).
- **Potential Gotchas**:
  - `resolveProjectContext()` (extended with `maxNumericId`) replaces `readAllPlans()` for cross-plan lookups. It provides `planIdToUuid` and `uuidToPlanId` maps.
  - `writePlanFile()` normalizes fancy quotes, strips deprecated fields, and applies YAML formatting. The new `writePlanToDb()` must apply the same normalizations for DB values.
  - `checkAndMarkParentDone()` must be consolidated from two separate implementations into one shared DB-backed version.
  - The `filename` DB field becomes vestigial — materialized paths are derived from plan ID via `getMaterializedPlanPath()`. Phase out `PlanWithFilename` type; return `PlanSchema` directly from DB functions.
  - `ensureReferences()` simplifies to a DB UUID lookup since all plans now have UUIDs at creation time.

## Current Progress
### Current State
- All tasks complete. Full DB-first conversion of tim CLI commands and MCP tools is done.
### Completed (So Far)
- Task 1: Extend resolveProjectContext() and create DB-first plan resolution
- Task 2: Create writePlanToDb() and invert writePlanFile() to DB-first
- Task 3: Consolidate checkAndMarkParentDone() into shared `src/tim/plans/parent_cascade.ts`; simplify ensureReferences() to use planIdToUuid map
- Task 4: MCP tools (manage_plan_task, update_plan_tasks, update_plan_details) wrapped with `withPlanAutoSync()`; create_plan rewritten with atomic DB transaction for child+parent; list_ready_plans DB-only (removed readAllPlans fallback)
- Task 5: `add.ts` writes to DB without tasks dir, atomic parent transaction with sync/rematerialize; `edit.ts` uses materialize/edit/sync cycle via `editMaterializedPlan()` helper; both honor `--config` for repo root
- Task 6: `set.ts` loads from DB, applies changes in-memory, writes via atomic DB transaction for parent/child updates, refreshes context before final write, uses `checkAndMarkParentDone()` from parent_cascade
- Task 7: `mark_done.ts` (markStepDone, markTaskDone, setTaskDone), `done.ts`, `set-task-done.ts`, `add-task.ts` all converted to DB-first with `resolvePlanFromDbOrSyncFile()` pattern
- Task 8: `list.ts` and `ready.ts` removed readAllPlans() fallback (DB-only unless --local); `show.ts` fully converted to DB-first using loadPlansFromDb() and resolvePlanFromDb(); duplicate local loadPlansFromDb removed; tests updated to seed DB fixtures
- Task 9: `generate.ts` and `chat.ts` resolve plans from DB via `resolvePlanFromDbOrSyncFile()`. `setupWorkspace()` accepts `planId` option and materializes plans into workspace `.tim/plans/{id}.plan.md` instead of copying files. Post-execution sync uses `syncPlanToDb()` on the actual edited file. New `plan_discovery.ts` module provides DB-backed `findNextReadyDependencyFromDb()`, `findLatestPlanFromDb()`, `findNextPlanFromDb()`
- Task 10: `agent.ts` uses DB-backed plan discovery and `resolvePlanFromDbOrSyncFile()` for all plan resolution modes (--next-ready, --latest, --next, --current, direct arg). `batch_mode.ts` uses `setPlanStatusById()` for completion. `stub_plan.ts` uses `setPlanStatusById()`. Workspace reuse path syncs existing materialized files before re-materializing. `ensure_plan_in_db.ts` promotes UUID-less file plans into DB state
- Task 12: `validate.ts` loads plans from DB via `loadPlansFromDb()` with file overlay for YAML validation. `renumber.ts` loads from DB, wraps multi-plan writes in DB transaction with snapshot-based rollback, refreshes materialized `.tim/plans/` files after ID changes. Both handle DB-only plans and ENOENT when tasks dir doesn't exist.
- Task 13: Fixed ~144 test failures down to 1 pre-existing cross-contamination flake. All critical test suites pass individually. Cross-interface integration tests (`task-management.integration.test.ts`) pass. Fixed workspace reuse branching bug, updated mocks for DB-first imports, fixed update-lessons test for PlanSchema API.
- Task 14: cleanup-temp.ts inverted to unlink file first, then DB. Uses configBaseDir for repo identity. removePlanFromDb supports throwOnError option
- Task 15: importHierarchicalIssue() uses writeImportedPlansToDbTransactionally() for atomic multi-plan DB writes, then writes files with skipDb:true
- Task 16: allPlans snapshot refreshed via refreshPlanSnapshot() after each successful import; importHierarchicalIssue refreshes currentPlans after each child write
- Task 17: review.ts plan auto-detection uses DB-first branch name inference (`/^(\d+)-/` → `resolvePlanFromDb()`), falls back to file-scanning. `autoSelectPlanForReview()` centralizes selection logic with `cwd` and `configPath` threading. Branch-name path materializes fresh from DB to avoid stale file overwrites.
- Task 18: `resolveReviewPlanForWrite()` uses `resolveRepoRootForPlanArg()` with configPath instead of raw `getGitRoot(dirname(...))`. All call sites (save, clear, append) thread `globalOpts.config`.
- Task 19: Removed dead find_next_dependency.ts and find_next_dependency.test.ts; updated agent.auto_claim.integration.test.ts mocks
- Task 23: Added defensive guard `if (!currentPlanFile) throw` in generate.ts before readPlanFile (chat.ts already had guard)
- Task 26: `writePlanFile(null, ...)` now throws if neither `cwdForIdentity` nor `context` is provided
- Task 29: `parsePlanIdentifier('0')` now returns `{}` (string path has same `> 0` check as number path)
- Task 30: Removed dead `writePlansWithGeneratedUuids` and cleaned up `plansWithGeneratedUuids` from `ensureReferences()` return type and all callers (ensureAllReferences, renumber.ts)
- Task 21: `resolvePlanFromDbOrSyncFile()` no longer force-syncs files to DB. Removed `force: true`, narrowed error handling to only catch plan-not-found errors, skips sync for timestamp-less files when DB already has the plan
- Task 22: `syncMaterializedPlan()` removed `force: true` and rejects materialized files missing `updatedAt` when DB has valid timestamp, preventing stale workspace files from overwriting newer DB state
- Task 24: `persistPlanPullRequests()` re-reads fresh plan from DB before writing, merges YAML-only passthrough fields from file when available, documents acceptable TOCTOU race window
- Task 20: `plan_discovery.test.ts` created with 18+ tests covering BFS traversal, circular deps, priority ordering (all 5 levels), empty plans filtering, parent fallback, child plan traversal, blocked dependency messaging, and DB wrapper functions
- Task 25: `generate_mode.ts` replaced all `readAllPlans()` with `loadPlansFromDb()` for parent/sibling prompt context and `tim://plans/list`/`tim://plans/ready` resources; removed `clearPlanCache()` calls; DB-only plans handled with `fs.existsSync()` checks on paths; sibling status uses actual status instead of done/pending binary
- Task 28: Extracted `findNextPlanFromCollection()` and `findNextReadyDependencyFromCollection()` as shared in-memory helpers in `plan_discovery.ts`; show.ts now imports and calls these instead of maintaining duplicate implementations; unified priority scale to `{ urgent: 5, high: 4, medium: 3, low: 2, maybe: 1 }`; child plan traversal included in BFS (matching `dependency_traversal.ts` semantics); `--latest` path in show.ts uses shared `findMostRecentlyUpdatedPlan()`
- Task 27: `validate.ts` now schema-validates DB-only plans and routes fix passes through `writePlanToDb()` for DB-only plans instead of `readPlanFile()`/`writePlanFile()`. `references.ts` fix functions (`fixMissingUuids`, `fixReferenceIssues`, `ensureAllReferences`) handle DB-only plans. `ensureAllReferences` skips DB-only plans since `references` is a YAML-only field. DB-only validate fixes preserve existing DB filename metadata.
- Task 32: `chat.ts` now uses `resolveRepoRootForPlanArg(options.plan, undefined, globalOpts.config)` for config-aware repo root derivation, computed once and shared between plan resolution and workspace setup. Replaces `getGitRoot(process.cwd())`.
- Task 33: `resolvePlanFromDbOrSyncFile()` resolves relative file paths against CWD (preserving subdirectory usage). Callers use `resolveRepoRootForPlanArg` with `configPath` to get the correct `repoRoot` for DB lookups under `--config`. The `--config` + relative file path edge case remains a pre-existing limitation across multiple resolution functions.
- Task 34: `formatReadyPlansAsJson()` and `displayJsonFormat()` in `ready.ts` now check `fs.existsSync()` before including filenames, matching the generate-mode pattern. DB-only plans get empty filename instead of bogus synthesized paths. MCP `list_ready_plans` tool inherits the fix.
- Task 31: `gatherPlanContext()` converted to DB-first: uses `resolvePlanFromDbOrSyncFile()` + `loadPlansFromDb()` instead of `resolvePlanFile()` + `readAllPlans()`. `PlanContext` now includes `repoRoot` and `gitRoot`. `handleReviewCommand()` and `buildReviewPromptFromOptions()` use `context.gitRoot` instead of re-deriving from CWD. `description.ts` similarly updated. `autoSelectPlanForReview()` catch narrowed to plan-not-found errors only.
- Task 38: Renamed `uuidToPlanId` to `planIdToUuid` in `create_plan.ts:resolvePlanRowForTransaction`; deduplicated by delegating to `planRowForTransaction(row, invertPlanIdToUuidMap(planIdToUuid))`
- Task 40: Added `fs.existsSync()` guards in `list.ts` (--show-files column) and `ready.ts` (verbose File: line) to suppress bogus paths for DB-only plans
- Task 41: Created `PlanNotFoundError` class in `plans.ts`, thrown from `resolvePlanFromDb()`. Updated `isPlanNotFoundError()` in `ensure_plan_in_db.ts` to use `instanceof`. Updated `review.ts` `autoSelectPlanForReview()` inline string matching to use `isPlanNotFoundError()`.
- Task 35: `ensureReviewPlanFilePath()` materializes DB-only plans before review/autofix executor invocation. Memoized to avoid redundant materialization. Post-autofix sync-back to DB via `syncPlanToDb(force: true)` when executor edited a materialized file. Notification payloads use materialized path instead of raw ID string. Both explicit `tim review 123 --autofix` and branch-name auto-selected DB-only paths covered.
- Task 37: `runUpdateDocs()` and `runUpdateLessons()` helpers accept `configPath` option and use `resolveRepoRootForPlanArg()` with it when `baseDir` is omitted. Command handlers thread `globalOpts.config` into helpers. Both helpers and handlers now use resolved repoRoot as executor baseDir for cross-repo correctness.
- Task 36: `resolveRepoRootForPlanArg()` now checks absolute plan paths before configPath (absolute paths are authoritative for repo root derivation). `resolvePlanFromDbOrSyncFile()` accepts `configBaseDir` to resolve relative paths against config base instead of CWD. `resolvePlanFromDb()` accepts `resolveDir` option. All callers threaded with appropriate base directories.
- Task 39: Workspace reuse in `workspace.ts` now syncs existing workspace plan files back to DB before overwriting. On sync failure, skips the file copy to avoid data loss (planFilePathInWorkspace set to undefined). Uses `options.mainRepoRoot` for `cwdForIdentity` for correct repository identity.
- Task 42: Added prominent JSDoc warning to `readPlanFile()` documenting its UUID generation write side effect (triggers DB insert for UUID-less plans).
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- `resolvePlan()` returns `planPath: string | null` (not always a string). Callers must handle null.
- `writePlanFile()` accepts `string | null` for filePath. Null means DB-only write.
- `writeValidatedPlanToDb()` is an internal function that skips validation (called by both `writePlanToDb()` and `writePlanFile()` to avoid double validation)
- `resolvePlanFromDb()` and `writePlanToDb()` accept optional `ProjectContext` to avoid redundant all-plans queries
- DB `filename` field is preserved as-is during writes (not overwritten with synthetic values) until all consumers are migrated
- `writePlanFile()` derives repository identity from filePath directory when available, not from process.cwd()
- `compact_plan.ts` and `generate_mode.ts` research prompt materialize DB-only plans explicitly when they need a file path
- `parent_cascade.ts` uses `ParentCascadeOptions` with callbacks for logging, allowing CLI and agent to provide different logging
- `create_plan` uses `reserveNextPlanId()` directly (avoids double resolveProjectContext from `generateNumericPlanId`)
- `create_plan` syncs parent materialized file before transaction, re-materializes after (async I/O outside synchronous transaction)
- MCP tools resolve plan once for ID extraction, then again inside `withPlanAutoSync()` (accepted double resolution for correctness)
- `getPlansByParentUuid()` requires `projectId` parameter to avoid cross-project children
- `resolveRepoRootForPlanArg()` accepts optional `configPath` to honor `--config` flag
- `resolvePlanFromDbOrSyncFile()` in `ensure_plan_in_db.ts` syncs file paths to DB without `force: true`, relying on timestamp guard to protect newer DB state. Files without `updatedAt` are treated as non-authoritative when the plan already exists in DB.
- `resolveWritablePath()` extracted to shared `src/tim/plans/resolve_writable_path.ts` used by set, mark_done, and add-task
- `mergeYamlPassthroughFields()` in `src/tim/plans/yaml_passthrough.ts` preserves YAML-only fields (rmfilter, generatedBy, etc.) through DB round-trips
- `planRowForTransaction()` and `invertPlanIdToUuidMap()` extracted to shared `plans_db.ts` to eliminate duplication across add.ts, set.ts, and parent_cascade.ts
- `editMaterializedPlan()` preserves pre-existing materialized files and only deletes temp files it created; checks editor exit code before syncing
- Dependency IDs validated upfront in both add.ts and set.ts before DB writes
- `setupWorkspace()` now accepts `planId` in options; materializes from DB instead of copying files when planId provided
- Post-execution sync in generate/chat/agent uses `syncPlanToDb()` on the actual edited file path, not `syncMaterializedPlan()` on assumed materialized path
- `setPlanStatusById()` added to plans.ts for DB-first status updates; used by stub_plan.ts and batch_mode.ts
- Workspace branch reuse path syncs existing materialized files back to DB before re-materializing to prevent data loss
- `resolvePlanFromDbOrSyncFile()` generates UUIDs for UUID-less file plans before syncing, ensuring they are promotable to DB state
- DB-backed plan discovery functions in `plan_discovery.ts` replace file-scanning equivalents (`findNextReadyDependency`, `findMostRecentlyUpdatedPlan`, `findNextPlan`). Shared in-memory collection helpers (`findNextPlanFromCollection`, `findNextReadyDependencyFromCollection`) exported for callers that already have loaded plans (e.g., show.ts)
- User-facing surfaces (show.ts discovery flags, MCP resources/prompts) check `fs.existsSync()` before emitting plan file paths, returning `Plan <id>` or empty string for DB-only plans
- `removePlanFromDb()` supports `throwOnError` option to allow callers to detect DB deletion failures
- `cleanup-temp.ts` uses `configBaseDir` from `resolvePlanPathContext()` for `getRepositoryIdentity()` to ensure correct repo context
- `writeImportedPlansToDbTransactionally()` batches all hierarchical import DB writes in one transaction; file writes happen after with `skipDb: true`
- Import `dbPath` uses `path.basename()` to store repo-relative filenames in DB, not absolute paths
- Validate fix functions for DB-only plans use `writePlanToDb()` without passing `filename`, preserving the existing DB filename. For file-backed plans, existing `writePlanFile()` path is used.
- `ensureAllReferences()` and `fixReferenceIssues()` skip `references` map updates for DB-only plans since `references` is a YAML-only field not persisted in the DB. `fixReferenceIssues()` still fixes parent/dep ID mismatches for DB-only plans.
- `chat.ts` uses `resolveRepoRootForPlanArg()` (not `resolvePlanPathContext()`) for repo root, because `resolvePlanPathContext()` ignores `--config` when deriving gitRoot. `resolveRepoRootForPlanArg()` correctly handles `--config` via the configPath branch.
- `resolvePlanFromDbOrSyncFile()` keeps CWD-based `path.resolve(planArg)` for file existence checks. Config-aware resolution is handled by callers passing the correct `repoRoot` from `resolveRepoRootForPlanArg()`. For numeric IDs (common case), file check fails and falls through to DB lookup.
- `formatReadyPlansAsJson()` and `displayJsonFormat()` in ready.ts use `fs.existsSync()` to suppress bogus filenames for DB-only plans, matching the generate-mode pattern.
- `PlanContext` returns `repoRoot` and `gitRoot` so callers (`handleReviewCommand`, `buildReviewPromptFromOptions`, `handleDescriptionCommand`) don't need to re-derive them from CWD. This ensures `--config` cross-repo works correctly throughout the review/description pipeline.
- `autoSelectPlanForReview()` catch narrowed to only swallow plan-not-found errors. Unexpected DB failures are re-thrown instead of silently falling back to file-based selection.
- `ensureReviewPlanFilePath()` memoizes materialization for DB-only plans, used across review execution and autofix paths. Returns the materialized path if plan has no file, or passes through existing paths.
- Post-autofix sync uses `force: true` intentionally because the executor just edited the file, so it contains the latest state. Comment documents this decision.
- `runUpdateDocs()` and `runUpdateLessons()` accept `configPath` in options, threaded to `resolveRepoRootForPlanArg()` for cross-repo resolution. `baseDir` defaults to resolved repoRoot instead of `getGitRoot()/process.cwd()`.
- `resolveRepoRootForPlanArg()` checks absolute plan paths before `configPath`. Absolute paths are authoritative — their repo root is derived from their location. `configPath` only anchors relative paths. This prevents syncing plans from repo B into repo A's DB.
- `resolvePlanFromDbOrSyncFile()` accepts `configBaseDir` parameter. When provided, relative paths resolve against it instead of CWD. All callers with access to configPath now pass the appropriate base directory.
- `resolvePlanFromDb()` accepts `resolveDir` option for resolving relative file paths. Defaults to CWD for backward compatibility.
- Workspace reuse sync failure in `workspace.ts` aborts the file copy (sets `planFilePathInWorkspace = undefined`) instead of overwriting. This prevents data loss from discarding unsynced workspace edits.
### Lessons Learned
- TypeScript non-null assertions (`planPath!`) only affect compile time. At runtime, null values still cause crashes in subsequent operations like `path.relative()`. When changing a return type to nullable, all runtime usages must be audited, not just type-level callers.
- When inverting a write path (file-first to DB-first), the repository identity resolution must be derived from the target file path (when available), not from process.cwd(), to handle cross-workspace writes correctly.
- Preserving the existing DB `filename` field during the transition period is important because existing consumers (loadPlansFromDb, list, ready) still rely on it to reconstruct paths.
- Async I/O (file sync, materialization) cannot run inside bun:sqlite synchronous transactions. Pattern: sync before → synchronous transaction → re-materialize after.
- `writeValidatedPlanToDb()` must look up existing DB filename when none provided, not fall back to synthetic `${id}.plan.md`.
- When using `parsePlanIdentifier` for MCP tools, UUID support breaks because it only returns planId for numeric inputs. Use `resolvePlan()` for initial resolution instead.
- Dependency IDs must be validated upfront before creating a plan, since `toPlanUpsertInput()` silently drops unresolvable UUID mappings.
- YAML-only fields (rmfilter, generatedBy, promptsGeneratedAt, compactedAt, statusDescription) are not stored in the DB. When writing plans back to files after a DB round-trip, these fields must be merged back from the original file content. Use `mergeYamlPassthroughFields()` for this. Long-term fix: add a JSON column to the plan table for these fields.
- When tests reference dependency plan IDs, those plans must actually exist in the DB now that dependency validation is enforced.
- Duplicated utility functions across commands (planRowForTransaction, invertPlanIdToUuidMap, resolveWritablePath) should be extracted early to prevent divergent bugs.
- When replacing a recursive file-based helper (like findNextReadyDependency) with a DB-backed version, verify all exit paths match — especially fallback returns (e.g., returning the parent plan when all deps are done).
- Post-execution sync must target the actual file the executor edited, not an assumed materialized path. When a file-backed plan runs in the primary repo (no workspace), `currentPlanFile` points at `tasks/...`, not `.tim/plans/...`. Use `syncPlanToDb()` on the actual path.
- When reusing a workspace branch, existing materialized files may contain unsynced edits from a previous agent run. Always sync existing files back to DB before re-materializing.
- Test files that mock agent.ts dependencies need updating whenever agent.ts imports change. The ModuleMocker pattern means every `.test.ts` file that mocks `plans.js` or `plan_discovery.js` must be individually updated.
- When DB functions internally swallow errors (like `removePlanFromDb`), callers can't distinguish success from failure. Add `throwOnError` options to make error handling observable.
- When storing file paths in DB, always use `path.basename()` not absolute paths, since `loadPlansFromDb()` later joins `searchDir + row.filename`. Absolute paths get double-prefixed.
- Commands using `--config` for cross-repo work must thread `configBaseDir` into `getRepositoryIdentity()`, not rely on `process.cwd()`.
- For DB-first auto-selection (branch-name path), never route a DB-resolved plan back through `resolvePlanFromDbOrSyncFile()` which could sync a stale materialized file back to DB. Always materialize fresh via `materializePlan()` (DB→file direction).
- `findBranchSpecificPlan()` and `findSingleModifiedPlanOnBranch()` resolve their own repo root internally via `resolvePlanPathContext(config)`. They don't accept a `cwd` parameter. The `configPath` parameter handles cross-repo scenarios; `cwd` is for git diff context only.
- When adding fields to a shared context type (like `PlanContext`), all mock sites across test files must be updated. With 23+ mock sites for `gatherPlanContext` across review/description tests, this is easy to miss and causes subtle `undefined` propagation bugs.
- When building ID→UUID maps for DB writes (e.g., renumber), always include ALL project plans, not just the changed set. `toPlanUpsertInput()` silently drops parent/dependency references that can't be resolved to UUIDs.
- For multi-plan DB mutations with file I/O, snapshot exact original DB rows before mutating. Reconstructing DB state from file paths on rollback loses stored filenames, parent UUIDs, and dependency relationships.
- After renumbering plan IDs, stale materialized files at `.tim/plans/{oldId}.plan.md` must be cleaned up and re-materialized with new IDs, or `syncMaterializedPlan()` will fail because the old plan ID no longer exists in DB.
- `force: true` in file→DB sync paths is dangerous because it bypasses the timestamp guard. Only use it when the caller is certain the file content should overwrite DB (e.g., explicit edit/import flows). For generic resolution/sync paths, let the timestamp guard protect newer DB state.
- When a plan field isn't stored in the DB (YAML-only fields), reading from DB and writing back to file loses those fields. Always merge YAML passthrough fields from the file when the file exists, even when the DB provides the authoritative base for stored fields.
- Error type discrimination via string matching is fragile. The `PlanNotFoundError` class (task 41) replaced broad `msg.includes('not found')` checks with `instanceof`, eliminating false positive risk from unrelated errors like 'Module not found'.
- When extracting duplicated logic into shared helpers, verify semantic differences (like priority scales or dependency traversal scope) between the duplicates. The show.ts priority map omitted 'maybe' and used a different scale than plan_discovery.ts, and the local `getDirectDependencies` in plan_discovery.ts missed child plan traversal that `dependency_traversal.ts` included. Both caused regressions.
- `loadPlansFromDb()` synthesizes `filename` for all plans including DB-only ones. Any user-facing code path that displays file paths must check `fs.existsSync()` before rendering — otherwise agents/users get pointed to nonexistent files.
- When routing DB-only plan writes through `writePlanToDb()`, don't pass a `filename` option unless intentionally changing it. The DB write path prefers caller-supplied filename over the existing DB value, so passing `path.basename(plan.filename)` from a synthesized path can clobber a non-basename stored filename.
- YAML-only fields like `references` cannot be persisted for DB-only plans. Fix functions that update these fields should skip DB-only plans rather than reporting false success. Always verify the DB schema actually stores the field you're trying to fix.
- `resolvePlanPathContext()` ignores `--config` for gitRoot derivation — it always calls `getGitRoot()` from CWD. Use `resolveRepoRootForPlanArg()` instead when `--config` must be honored.
- Multiple resolution functions (`resolvePlanFromDbOrSyncFile`, `resolveRepoRootForPlanArg`, `resolvePlanFromDb`) each use `path.resolve(planArg)` from CWD for file existence checks. Fixed by threading `configBaseDir`/`resolveDir` through all resolution layers. Absolute plan paths must remain authoritative for repo root derivation even when `configPath` is set, to prevent cross-repo data corruption.
- When a function has both command handler callers and exported helper callers, fixing only the command handler is insufficient. The helper entry point must also resolve context correctly for direct callers. Always check all call sites, not just the CLI path.
- For executor-driven plan modifications (autofix, generate, etc.), always sync the edited file back to DB after execution. Materializing before execution is only half the fix — the return path matters equally.
### Risks / Blockers
- `resolvePlanFromDb()` only reliably resolves numeric IDs and UUIDs. File path resolution extracts numeric prefix from basename, which doesn't support non-numeric filenames. This is acceptable for DB-first since plans should be referenced by ID/UUID, but is a known limitation during transition.
- PR commands (link/unlink/status) will fail for DB-only plans that haven't been materialized. This is expected and will be addressed in future tasks.
- YAML-only fields are lost for DB-only plans (no file backing). Commands that set rmfilter or statusDescription on DB-only plans will silently succeed but the data is not persisted. Future task: add DB columns for these fields.
- `ensure_plan_in_db.ts` syncs files to DB when a path is passed, but now respects the timestamp guard. Files without `updatedAt` defer to DB when the plan already exists. Remaining risk: a file with a valid but stale `updatedAt` that's still newer than an old DB row could overwrite a concurrent modification made between the DB write and the next file sync.
- `planRowToSchemaInput()` silently drops unresolved dependency UUIDs when loading from DB. This means dangling dependencies don't block readiness. Acceptable during transition but should be addressed in plan 282 or later.
- `loadPlansFromDb()` synthesizes file paths for all plans via `PlanWithFilename`. DB-only plans get bogus paths. This is a known limitation until `PlanWithFilename` is phased out (plan 282 scope).
- `resolvePlan()` in plan_display.ts doesn't thread `configPath` through to DB resolution. This is a task 1 limitation; callers using `--config` for cross-repo resolution may resolve against wrong project.
- `validate --fix` auto-fixers now handle DB-only plans via `writePlanToDb()`, but `references` map updates are skipped for DB-only plans since the field isn't persisted in the DB. `ensureUuidsAndReferences()` (used by agent) still uses `readAllPlans()` and doesn't handle DB-only plans.
- 1 remaining cross-contamination test flake: `WorkspaceAutoSelector > selectWorkspace returns unlocked workspace when available` — passes individually but fails in full suite due to DB state leak from another test. Pre-existing, not caused by DB-first changes.
- `--config` + relative file plan paths that escape the configured repo (e.g., `../other-repo/tasks/1.plan.md`) may still resolve the repo root from the config rather than from the file's actual location. Numeric IDs, UUIDs, and same-repo relative paths work correctly. This is a remaining edge case for cross-repo relative paths.
- Review autofix paths now handle DB-only plans via `ensureReviewPlanFilePath()` materialization. The PlanSchema-object overloads of `runUpdateDocs`/`runUpdateLessons` still fall back to `getGitRoot()/process.cwd()` for baseDir when omitted, but all current callers provide baseDir explicitly.
