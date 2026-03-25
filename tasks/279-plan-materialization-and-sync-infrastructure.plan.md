---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Plan materialization and sync infrastructure
goal: Create the core infrastructure for materializing plan files from the
  database to disk and syncing changes back. This inverts the current
  architecture where files are source of truth and DB is a read cache.
id: 279
uuid: 9912c78d-87f8-4e88-987a-2b577ac925a6
generatedBy: agent
status: done
priority: high
parent: 278
references:
  "278": 8c8ba325-58ad-4033-b45a-a9a1efd654a6
planGeneratedAt: 2026-03-25T07:20:41.888Z
promptsGeneratedAt: 2026-03-25T07:20:41.888Z
createdAt: 2026-03-25T03:46:35.033Z
updatedAt: 2026-03-25T18:58:45.416Z
tasks:
  - title: Add missing DB columns and remove obsolete schema fields
    done: true
    description: "Add migration v9 to src/tim/db/migrations.ts with new columns:
      temp (INTEGER), docs (TEXT/JSON), changed_files (TEXT/JSON),
      plan_generated_at (TEXT), review_issues (TEXT/JSON). Update PlanRow and
      UpsertPlanInput interfaces in src/tim/db/plan.ts. Update upsertPlan() to
      handle new fields. Update toPlanUpsertInput() in plan_sync.ts. Remove
      obsolete fields (generatedBy, rmfilter, promptsGeneratedAt, compactedAt,
      statusDescription, references) from planSchema.ts. Do NOT add
      writePlanFile() stripping logic — deferred to plan 282."
  - title: Create shared planRowToSchemaInput() converter
    done: true
    description: "Create a planRowToSchemaInput(row, tasks, deps, tags,
      uuidToPlanId?) function that converts DB data to PlanSchemaInput. The
      uuidToPlanId map is optional — if not provided, query the DB for needed
      UUIDs to resolve parent_uuid and dependency UUIDs back to numeric plan
      IDs. Include all fields: title, goal, details, status, priority, branch,
      simple, tdd, discoveredFrom, baseBranch, epic, assignedTo, issue (parse
      JSON), pullRequest (parse JSON), temp, docs (parse JSON), changedFiles
      (parse JSON), planGeneratedAt, reviewIssues (parse JSON), tags, tasks,
      dependencies. Refactor loadPlansFromDb() in plans_db.ts to use this
      converter instead of its inline field mapping."
  - title: Implement materializePlan() and path helpers
    done: true
    description: "Create src/tim/plan_materialize.ts. Implement
      getMaterializedPlanPath(repoRoot, planId) returning
      {repoRoot}/.tim/plans/{planId}.plan.md, getMaterializedRefPath(repoRoot,
      planId) returning {planId}.ref.md, and ensureMaterializeDir(repoRoot)
      which creates .tim/plans/ and writes .gitignore with *.plan.md and
      *.ref.md entries. Implement materializePlan(planId, repoRoot, options?)
      which: queries plan from DB, uses planRowToSchemaInput() to reconstruct
      PlanSchemaInput, calls writePlanFile() with new skipSync option, returns
      the path. Add skipSync option to writePlanFile() in plans.ts to prevent
      circular syncPlanToDb() call."
  - title: Implement materializeRelatedPlans()
    done: true
    description: In plan_materialize.ts, implement materializeRelatedPlans(planId,
      repoRoot) which materializes parent, children, siblings (same parent), and
      dependency plans as .ref.md files. Query DB for related plan IDs, use
      planRowToSchemaInput() for each, write with writePlanFile() using skipSync
      to the ref path. This is always called alongside materializePlan().
  - title: Implement syncMaterializedPlan()
    done: true
    description: "In plan_materialize.ts, implement syncMaterializedPlan(planId,
      repoRoot) which: derives file path from getMaterializedPlanPath(), calls
      readPlanFile() to parse it, calls existing syncPlanToDb() to write changes
      to DB. Always re-reads and parses — no mtime tracking. The caller passes
      the plan ID; the file is just parsed for content."
  - title: Implement auto-sync wrapper withPlanAutoSync()
    done: true
    description: "In plan_materialize.ts, implement withPlanAutoSync(planId,
      repoRoot, fn) which: checks if materialized file exists at
      getMaterializedPlanPath(), if yes calls syncMaterializedPlan() first,
      executes fn() callback (the DB modification), then re-materializes via
      materializePlan(). This wrapper is used by tim commands that modify plans
      while agents may be editing the materialized file."
  - title: Add tim materialize CLI command
    done: true
    description: Create src/tim/commands/materialize.ts. Accepts a plan ID argument.
      Calls materializePlan() and materializeRelatedPlans() (always materializes
      related plans). Prints the primary plan path to stdout. Register in
      src/tim/tim.ts using the existing dynamic import pattern.
  - title: Add tim sync CLI command
    done: true
    description: Create src/tim/commands/sync.ts. Accepts a plan ID argument. Looks
      up file at getMaterializedPlanPath(repoRoot, planId). Calls
      syncMaterializedPlan(). Prints status. Register in src/tim/tim.ts.
  - title: Add cleanup for stale materialized files
    done: true
    description: Implement cleanupMaterializedPlans(repoRoot) which scans
      .tim/plans/ for *.plan.md and *.ref.md files, checks if each plan still
      exists in DB and is relevant (not done/cancelled for extended time),
      deletes stale files. Integrate into existing tim cleanup command.
  - title: Write comprehensive tests for materialize/sync round-trip
    done: true
    description: "Create src/tim/plan_materialize.test.ts with tests: (1)
      Round-trip: create plan in DB, materialize, read back, verify all fields
      match. (2) Edit and sync: materialize, edit file (change title, add task),
      sync, verify DB updated. (3) Auto-sync wrapper: materialize, edit file
      externally, call wrapper with DB modification, verify both preserved. (4)
      Cleanup: create stale materializations, run cleanup, verify deleted. (5)
      All fields: verify reviewIssues, changedFiles, docs, temp, tags, tasks,
      dependencies all survive round-trip. (6) Related plans: verify .ref.md
      files created for parent/children/siblings/dependencies. (7) .gitignore
      creation. Follow existing test patterns: temp dirs, real filesystem, real
      DB, clearAllTimCaches()."
  - title: "Address Review Feedback: The CLI contract does not match the plan
      requirements."
    done: true
    description: >-
      The CLI contract does not match the plan requirements. The implementation
      keeps `tim sync` as the legacy tasks-directory sync and introduces a
      separate `tim sync-materialized <planId>` command instead. The plan and
      acceptance criteria explicitly called for `tim sync <planId>` as the
      materialized-file sync entry point. The wrong interface is baked into the
      command registration, the using-tim docs, and the integration test, so
      this is not an incidental naming bug. As shipped, callers following the
      required interface cannot use the feature.


      Suggestion: Expose the materialized sync flow through the required `tim
      sync <planId>` interface, or otherwise reconcile the legacy/full-sync
      command shape with the required contract and update all docs/tests to
      match the final interface.


      Related file: src/tim/tim.ts:600-618
  - title: "Address Review Feedback: Missing ENOENT guard on `unlink` in
      `cleanupMaterializedPlans`."
    done: true
    description: >-
      Missing ENOENT guard on `unlink` in `cleanupMaterializedPlans`. The
      `pruneUnusedRefFiles` function at line 321-325 correctly wraps `unlink`
      with `.catch()` to handle ENOENT (file removed between `readdir` and
      `unlink`), but `cleanupMaterializedPlans` at line 506 does a bare `await
      unlink(entryPath)` without this guard. If another process removes the file
      between the `readdir` and `unlink` calls, cleanup will throw.


      Suggestion: Add the same ENOENT guard as pruneUnusedRefFiles: `await
      unlink(entryPath).catch((error) => { if ((error as
      NodeJS.ErrnoException).code !== 'ENOENT') throw error; });`


      Related file: src/tim/plan_materialize.ts:506
  - title: "Address Review Feedback: `changedFiles` missing from empty-array cleanup
      in `writePlanFile`."
    done: true
    description: >-
      `changedFiles` missing from empty-array cleanup in `writePlanFile`. The
      `arrayFields` list that strips empty arrays includes `dependencies`,
      `issue`, `pullRequest`, `docs`, `reviewIssues` but not `changedFiles`. An
      empty `changedFiles: []` will be written to the YAML, unlike the other
      array fields which get cleaned, creating cosmetic inconsistency in
      materialized files.


      Suggestion: Add 'changedFiles' to the arrayFields list: `const arrayFields
      = ['dependencies', 'issue', 'pullRequest', 'docs', 'reviewIssues',
      'changedFiles'] as const;`


      Related file: src/tim/plans.ts:701
  - title: "Address Review Feedback: Multiple `resolveProjectContext` calls in
      `withPlanAutoSync` spawn git subprocesses."
    done: true
    description: >-
      Multiple `resolveProjectContext` calls in `withPlanAutoSync` spawn git
      subprocesses. A single `withPlanAutoSync` execution can call
      `resolveProjectContext` up to 3 times (line 415, line 429, and once inside
      `syncMaterializedPlan` at line 376). Each call spawns a `git` subprocess
      via `getRepositoryIdentity`. The repository identity doesn't change
      between calls — only plan rows need refreshing.


      Suggestion: Consider caching the repository identity portion of
      ProjectContext and only refreshing plan rows on subsequent calls within
      the same operation.


      Related file: src/tim/plan_materialize.ts:404-443
  - title: "Address Review Feedback: Pre-existing: `tdd: false` not cleaned in
      `writePlanFile` unlike `simple: false`, `epic: false`, and `temp: false`."
    done: true
    description: >-
      Pre-existing: `tdd: false` not cleaned in `writePlanFile` unlike `simple:
      false`, `epic: false`, and `temp: false`. This creates an asymmetry where
      `tdd: false` survives round-trips while `simple: false` does not. Not
      introduced by this change.


      Suggestion: Add `if (cleanedPlan.tdd === false) { delete cleanedPlan.tdd;
      }` alongside the other boolean field cleanups.


      Related file: src/tim/plans.ts:689-698
changedFiles:
  - CLAUDE.md
  - README.md
  - claude-plugin/skills/using-tim/references/adding-plans.md
  - claude-plugin/skills/using-tim/references/cli-commands.md
  - docs/database.md
  - docs/tutorials/adding-plan-schema-fields.md
  - docs/web-interface.md
  - schema/tim-config-schema.json
  - src/lib/components/ReviewResultDisplay.svelte
  - src/lib/components/SessionMessage.svelte
  - src/lib/components/SessionMessage.test.ts
  - src/lib/server/session_integration.test.ts
  - src/lib/server/session_manager.test.ts
  - src/lib/server/session_manager.ts
  - src/lib/server/session_routes.test.ts
  - src/lib/server/ws_server.test.ts
  - src/lib/stores/session_notifications.test.ts
  - src/lib/stores/session_notifications.ts
  - src/lib/stores/session_state_events.test.ts
  - src/lib/types/session.ts
  - src/lib/utils/message_formatting.test.ts
  - src/lib/utils/message_formatting.ts
  - src/lib/utils/session_colors.ts
  - src/routes/api/sessions/events/events.server.test.ts
  - src/tim/commands/agent/agent.lifecycle.test.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/agent/agent_batch_mode.test.ts
  - src/tim/commands/agent/batch_mode.soft_failure.test.ts
  - src/tim/commands/agent/batch_mode.ts
  - src/tim/commands/agent/stub_plan.ts
  - src/tim/commands/cleanup-materialized.ts
  - src/tim/commands/materialize.ts
  - src/tim/commands/review.ts
  - src/tim/commands/sync.test.ts
  - src/tim/commands/sync.ts
  - src/tim/configLoader.test.ts
  - src/tim/configLoader.ts
  - src/tim/configSchema.test.ts
  - src/tim/configSchema.ts
  - src/tim/db/database.test.ts
  - src/tim/db/migrations.ts
  - src/tim/db/plan.ts
  - src/tim/db/plan_sync.ts
  - src/tim/lifecycle.test.ts
  - src/tim/lifecycle.ts
  - src/tim/notifications.ts
  - src/tim/planSchema.ts
  - src/tim/plan_materialize.test.ts
  - src/tim/plan_materialize.ts
  - src/tim/plans.test.ts
  - src/tim/plans.ts
  - src/tim/plans_db.test.ts
  - src/tim/plans_db.ts
  - src/tim/process_markdown.ts
  - src/tim/shutdown_state.test.ts
  - src/tim/shutdown_state.ts
  - src/tim/tim.signal_handlers.test.ts
  - src/tim/tim.ts
  - src/tim/workspace/workspace_lock.test.ts
  - src/tim/workspace/workspace_lock.ts
tags:
  - architecture
---

## Planned Work

1. **Verify DB schema covers full plan reconstruction** — Verify that the existing DB schema (title, goal, details, tasks, status, priority, tags, dependencies, etc.) is sufficient to fully reconstruct a plan file from DB data alone. The `details` column stores the markdown body. Identify any fields present in plan files but missing from the DB and add them if needed. No new content column is required.

2. **Implement materializePlan() function** — Create a function that takes a plan ID and repo root, reads the plan from the DB, and writes it as a properly-formatted plan file to `{repoRoot}/.tim/plans/{planId}.plan.md`. Also implement `materializeRelatedPlans()` to write parent/children/siblings as `.ref.md` files for agent context. Return the path where the file was written.

3. **Implement syncMaterializedPlan() function** — Create a function that reads a materialized plan file from `.tim/plans/{planId}.plan.md`, parses it, and updates the DB with any changes. This is essentially the reverse of the current syncPlanToDb() flow.

4. **Implement auto-sync wrapper for tim commands** — Create a wrapper/helper that tim commands can use when modifying a plan: (1) check if a materialized file exists at the well-known path, (2) if yes, sync file → DB first, (3) perform the DB modification, (4) re-materialize the file. This ensures agents editing the file and tim commands don't lose each other's changes.

5. **Add tim materialize and tim sync CLI commands** — Add explicit CLI commands: `tim materialize <planId>` to materialize a plan to `.tim/plans/`, and `tim sync <planId>` to sync a materialized file back to DB. The materialize command should print the path to stdout for easy piping. Update the using-tim skill's cli-commands.md reference to document the new commands.

6. **Add cleanup for stale materialized files** — Implement cleanup logic for `.tim/plans/` directory. Scan for files whose plans no longer need materialization. Can be integrated into existing `tim cleanup` command.

7. **Write tests for materialize/sync round-trip** — Test that materialize → edit → sync → materialize produces correct results. Test mtime detection, no-op sync when unchanged, conflict detection, and the auto-sync wrapper behavior.

## Expected Behavior/Outcome

After this plan is implemented:
- A `materializePlan(planId, repoRoot)` function can reconstruct a complete plan file from DB data alone and write it to `{repoRoot}/.tim/plans/{planId}.plan.md`.
- Related plans (parent, children, siblings, dependencies) are materialized as read-only reference files at `{repoRoot}/.tim/plans/{planId}.ref.md`.
- A `syncMaterializedPlan(planId, repoRoot)` function reads a materialized plan file and syncs changes back to the DB.
- An auto-sync wrapper allows tim commands to safely modify plans while agents are editing the materialized file — it syncs file→DB before the command's DB modification, then re-materializes DB→file after.
- `tim materialize <planId>` and `tim sync <planId>` CLI commands expose this to users/scripts.
- Stale materialized files are cleaned up.
- All plan file fields round-trip correctly through DB→file→DB.
- `.tim/plans/.gitignore` prevents materialized files from being committed.

**Relevant states:**
- **Not materialized**: Plan exists only in DB (or only as a tasks/ file, pre-migration).
- **Materialized**: File on disk at `.tim/plans/{planId}.plan.md`. May have been edited by an agent or user.
- **Reference**: Related plan at `.tim/plans/{planId}.ref.md`. Read-only context, not synced back.
- **Stale**: Materialized file exists but is no longer needed. Eligible for cleanup.

## Key Findings

### Product & User Story
This is infrastructure for the DB-first plan storage epic (278). The immediate users are:
1. **Agent processes** that need plan files materialized into workspaces for editing, then synced back.
2. **Web UI** that edits DB directly and needs to re-materialize files for agents.
3. **Tim CLI commands** that currently read/write files but will eventually operate DB-first (plan 280).
4. **Manual/scripted workflows** using `tim materialize` / `tim sync`.

### Design & UX Approach
- The CLI commands should be minimal: `tim materialize 279` prints the path, `tim sync 279` syncs back.
- Auto-sync is invisible to the user — it happens transparently when commands modify plans.
- Materialized files live at `{repoRoot}/.tim/plans/{planId}.plan.md` — a well-known path per repo.
- Reference plans (parent, children, siblings, dependencies) are materialized as `.ref.md` files alongside the primary plan.
- `.tim/plans/.gitignore` with `*.plan.md` and `*.ref.md` prevents accidental commits.

### Technical Plan & Risks

**DB schema gaps**: The current DB schema is missing several plan file fields that are needed for faithful round-trip materialization:
- `temp` (boolean) — Temporary plan flag.
- `docs` (string[]) — Documentation links.
- `changedFiles` (string[]) — Files affected by the plan.
- `planGeneratedAt` (timestamp) — When the plan was generated.
- `reviewIssues` (array of objects) — Review findings.
Obsolete fields to remove from schema: `generatedBy`, `rmfilter`, `promptsGeneratedAt`, `compactedAt`, `statusDescription`, `references`. The `references` field was only needed for cross-plan UUID lookups during file→DB sync, but the `idToUuid` map built from scanning all plans already handles this.

The `loadPlansFromDb()` function in `plans_db.ts` also omits several fields it could include from the DB: `tdd`, `discoveredFrom`, `baseBranch`, `issue`, `pullRequest`, `temp`. These need to be added for complete reconstruction.

**Materialization tracking**: No dedicated tracking table needed. `syncMaterializedPlan()` always re-reads the file, parses it, and syncs to DB. The materialized file path is deterministic: `{repoRoot}/.tim/plans/{planId}.plan.md`. The auto-sync wrapper checks for the file's existence at the well-known path and syncs if present.

**Conflict risk**: If an agent edits a materialized file while a web UI user also modifies the DB, the auto-sync wrapper needs a clear conflict resolution strategy. Since the auto-sync runs file→DB *before* the command's modification, the last-write-wins approach is inherent — the command's DB write overwrites whatever was synced.

### Pragmatic Effort Estimate
- DB migration + schema cleanup: Small (~1 task)
- Shared `planRowToSchemaInput()` converter: Small (~1 task)
- Core materialize/sync functions: Medium (~2 tasks)
- Auto-sync wrapper: Small-Medium (~1 task)
- CLI commands: Small (~1 task)
- Cleanup: Small (~1 task)
- Tests: Medium (~1-2 tasks, integrated with each feature)

## Acceptance Criteria

- [ ] `materializePlan()` writes a valid plan file that `readPlanFile()` can parse back identically.
- [ ] `syncMaterializedPlan()` reads a materialized file and updates DB with any changes.
- [ ] Auto-sync wrapper correctly syncs file→DB before command modifications and re-materializes after.
- [ ] `tim materialize <planId>` writes to `.tim/plans/{planId}.plan.md` and prints the path to stdout.
- [ ] `tim materialize` always materializes related plans (parent/children/siblings/dependencies) as `.ref.md` files.
- [ ] `tim sync <planId>` syncs a materialized file back to DB.
- [ ] Stale materialized files are cleaned up.
- [ ] `.tim/plans/.gitignore` is created with `*.plan.md` and `*.ref.md` patterns.
- [ ] All plan file fields round-trip through DB→file→DB (tags, tasks, dependencies, reviewIssues, etc.).
- [ ] DB migration adds missing columns needed for faithful materialization.
- [ ] All new code paths are covered by tests (round-trip, sync, auto-sync, cleanup).

## Dependencies & Constraints

- **Dependencies**: Relies on existing `readPlanFile()` / `writePlanFile()` in `src/tim/plans.ts`, existing DB layer in `src/tim/db/plan.ts`.
- **Technical Constraints**: Must not break existing `syncPlanToDb()` / `syncAllPlansToDb()` flows — the current file-first system must continue working until plan 280 migrates commands. All DB operations must remain synchronous (bun:sqlite).
- **Ordering**: This plan (279) must be completed before plans 280 (command migration), 281 (agent workspace integration), and 282 (deprecation).

## Research

### Overview
This plan inverts plan storage from file-first to DB-first. Currently, `writePlanFile()` writes YAML+markdown to disk and then calls `syncPlanToDb()` to update the DB cache. We need the reverse: read from DB, write to disk (materialize), and detect/sync external edits back.

### Critical Discoveries

**1. Plan file format is YAML frontmatter + markdown body.**
Files in `tasks/` use `---` delimiters. The YAML contains all metadata fields, and the markdown body after the closing `---` becomes the `details` field. The schema line `# yaml-language-server: $schema=...` is always the first line inside frontmatter. See `src/tim/planSchema.ts` for the Zod schema (`phaseSchema`).

**2. `writePlanFile()` is the canonical file writer** (`src/tim/plans.ts:652-744`).
It handles:
- Fancy quote normalization
- Schema validation via Zod
- Separating `details` from the rest of the plan for YAML/body split
- Cleaning up false defaults and empty arrays
- Adding the schema comment line
- Calling `syncPlanToDb()` after writing

For materialization, we should reuse `writePlanFile()` directly — just construct a `PlanSchemaInput` from DB data and call it. However, `writePlanFile()` currently calls `syncPlanToDb()` at the end, which would create a circular loop during materialization. We'll need to either add an option to skip the sync step, or call the lower-level YAML formatting + file write directly.

**3. `readPlanFile()` is the canonical file reader** (`src/tim/plans.ts:527-606`).
It handles parsing YAML frontmatter, extracting the markdown body into `details`, validating against `phaseSchema`, and auto-generating UUIDs if missing. For `syncMaterializedPlan()`, we can reuse this directly and then feed the result to the existing `syncPlanToDb()` flow.

**4. `toPlanUpsertInput()` in `plan_sync.ts:147-218` maps PlanSchema → DB input.**
This is the bridge between the file format and DB format. It resolves parent/dependency UUIDs from numeric IDs using the `references` field and `idToUuid` map. For sync, we can reuse this function.

**5. `loadPlansFromDb()` in `plans_db.ts` reconstructs PlanSchema from DB rows.**
This is the closest existing function to what materialization needs. However, it's incomplete — it omits: `tdd`, `discoveredFrom`, `baseBranch`, `issue`, `pullRequest`, `temp`, `docs`, `changedFiles`, `rmfilter`, `generatedBy`, `planGeneratedAt`, `promptsGeneratedAt`, `compactedAt`, `statusDescription`, `reviewIssues`. Some of these aren't in the DB at all (see schema gaps above).

**6. DB schema gaps are real but manageable.**
The plan table is missing columns for: `temp`, `docs`, `changedFiles`, `planGeneratedAt`, `reviewIssues`. These need new DB columns. The fields `generatedBy`, `rmfilter`, `promptsGeneratedAt`, `compactedAt`, and `statusDescription` are obsolete and should be dropped from the schema entirely (removed from `planSchema.ts` and plan files).
- JSON columns work well for array/object fields (like existing `issue` and `pull_request`).

**7. The `references` field is obsolete.**
`references` mapped numeric plan IDs to UUIDs for deterministic cross-plan linking. In the DB-first world, all relationships are stored as UUIDs in the DB. The `idToUuid` map built from scanning all plans already resolves numeric IDs during file→DB sync. The `references` field should be removed from the schema.

**8. `plan_merge.ts` handles content merging with delimiters.**
Generated content is wrapped in `<!-- tim-generated-start -->` / `<!-- tim-generated-end -->`. This is relevant because materialized files may be edited by agents who add Research sections etc. The existing merge utilities handle this properly.

### Notable Files and Modules

| File | Role | Key Functions |
|------|------|---------------|
| `src/tim/plans.ts` | File I/O | `readPlanFile()`, `writePlanFile()`, `readAllPlans()`, `resolvePlanFile()` |
| `src/tim/planSchema.ts` | Types/validation | `phaseSchema`, `PlanSchema`, `PlanSchemaInput`, `taskSchema` |
| `src/tim/db/plan.ts` | DB CRUD | `upsertPlan()`, `getPlanByUuid()`, `getPlansByProject()`, `UpsertPlanInput` |
| `src/tim/db/plan_sync.ts` | File→DB sync | `syncPlanToDb()`, `syncAllPlansToDb()`, `toPlanUpsertInput()` |
| `src/tim/db/migrations.ts` | Schema versioning | Migration functions, `CURRENT_VERSION` |
| `src/tim/plans_db.ts` | DB→PlanSchema | `loadPlansFromDb()` |
| `src/tim/plan_merge.ts` | Content merging | `mergeDetails()`, `mergeTasksIntoPlan()` |
| `src/common/config_paths.ts` | Path utilities | `getTimConfigRoot()` |
| `src/common/cleanup_registry.ts` | Cleanup pattern | `CleanupRegistry.register()` |
| `src/tim/tim.ts` | CLI registration | Dynamic `import()` pattern for commands |
| `src/tim/db/database.ts` | DB singleton | `getDatabase()`, WAL mode, auto-migration |

### Architectural Hazards

1. **Circular sync**: `writePlanFile()` calls `syncPlanToDb()`. If materialization uses `writePlanFile()`, it would trigger a DB sync right after reading from DB — wasteful and potentially conflicting. Need a `skipSync` option or use lower-level file writing.

2. **UUID generation side effect**: `readPlanFile()` auto-generates UUIDs and calls `writePlanFile()` to persist them. For syncing materialized files, the plan already has a UUID from the DB, so this shouldn't trigger. But edge cases exist if someone manually removes the UUID from a materialized file.

3. **`filename` column semantics**: Currently stores the basename of the file in the tasks directory (e.g., `279-plan-materialization-and-sync-infrastructure.plan.md`). For materialized files at `.tim/plans/{planId}.plan.md`, the `filename` column should remain the canonical tasks-dir name. The materialized path is derived from the plan ID.

4. **`references` removal**: The `references` field is being removed. Code that relies on it for UUID resolution (e.g., `getPlanReferenceUuid()` in `plan_sync.ts`) needs to fall back to the `idToUuid` map exclusively.

### Existing Patterns to Follow

**DB migrations** (`src/tim/db/migrations.ts`): Each migration is a function in the `migrations` array. Increment `CURRENT_VERSION`. Migrations run inside a transaction. Use `ALTER TABLE plan ADD COLUMN` for new columns. JSON columns are stored as TEXT.

**CLI command registration** (`src/tim/tim.ts`): Commands use dynamic `await import('./commands/cmd.js')` inside `.action()`. Options are pre-processed with `intArg()`. Wrap handler with `.catch(handleCommandError)`.

**Test setup** (`src/tim/db/plan_sync.test.ts`): Create temp dirs, write plan files with `stringifyPlanWithFrontmatter()`, clear caches with `clearAllTimCaches()` / `closeDatabaseForTesting()` / `clearPlanSyncContext()`. Use real filesystem and real DB.

**Synchronous DB**: All DB functions are synchronous (bun:sqlite native API). Write transactions use `db.transaction().immediate()`.

## Implementation Guide

### Step 1: Add missing DB columns via migration

Add a new migration (version 9) to `src/tim/db/migrations.ts` that adds the missing columns to the `plan` table:

```sql
ALTER TABLE plan ADD COLUMN temp INTEGER;
ALTER TABLE plan ADD COLUMN docs TEXT;              -- JSON array
ALTER TABLE plan ADD COLUMN changed_files TEXT;      -- JSON array
ALTER TABLE plan ADD COLUMN plan_generated_at TEXT;
ALTER TABLE plan ADD COLUMN review_issues TEXT;      -- JSON array of objects
```

Also remove obsolete fields (`generatedBy`, `rmfilter`, `promptsGeneratedAt`, `compactedAt`, `statusDescription`, `references`) from `planSchema.ts` and `toPlanUpsertInput()`. Do NOT add stripping logic to `writePlanFile()` yet — `.passthrough()` will silently preserve them in existing files. Stripping is deferred to plan 282 (deprecation phase).

Update `PlanRow` interface in `src/tim/db/plan.ts` to include the new columns. Update `UpsertPlanInput` similarly. Update `upsertPlan()` to handle the new fields. Follow the existing pattern where JSON arrays are stored as `JSON.stringify()` on write and parsed on read.

Update `toPlanUpsertInput()` in `src/tim/db/plan_sync.ts` to map the new PlanSchema fields to the new DB columns.

### Step 2: Implement `materializePlan()` function

Create `src/tim/plan_materialize.ts` as the main module for this feature.

**Helper: `getMaterializedPlanPath(repoRoot, planId)`** — returns `path.join(repoRoot, '.tim', 'plans', `${planId}.plan.md`)`. Similarly `getMaterializedRefPath(repoRoot, planId)` returns `.../{planId}.ref.md`.

**Helper: `ensureMaterializeDir(repoRoot)`** — creates `.tim/plans/` directory if needed and writes `.gitignore` with `*.plan.md` and `*.ref.md` entries if it doesn't exist.

The `materializePlan(planId, repoRoot, options?)` function should:

1. Query the plan from DB using `getPlanByUuid()` (look up UUID from plan_id), `getPlanTasksByUuid()`, `getPlanDependenciesByUuid()`, `getPlanTagsByUuid()`.
2. Reconstruct a `PlanSchemaInput` object from the DB data. This is the reverse of `toPlanUpsertInput()`. Include all fields.
3. No need to reconstruct `references` — it's been removed from the schema.
4. Determine the target path: `getMaterializedPlanPath(repoRoot, planId)`. Call `ensureMaterializeDir()`.
5. Write the file using `writePlanFile()` with a new `skipSync: true` option.
6. Return the path.

**`materializeRelatedPlans(planId, repoRoot)`** — materializes parent, children, sibling, and dependency plans as `.ref.md` files. Uses the same DB→PlanSchemaInput reconstruction via `planRowToSchemaInput()`, writes with `skipSync: true` to the ref path.

**Key decision**: Rather than duplicating file-writing logic, add an `options.skipSync` parameter to `writePlanFile()` so it skips the `syncPlanToDb()` call at the end. This keeps one canonical file writer.

### Step 3: Implement `syncMaterializedPlan()` function

In the same `src/tim/plan_materialize.ts` module:

1. Call `readPlanFile()` to parse the materialized file.
2. Call the existing `syncPlanToDb()` to write changes to DB. This reuses all the existing reference resolution and upsert logic.

No mtime tracking — always re-reads and compares. The `syncPlanToDb()` / `upsertPlan()` path handles the case where nothing changed (it's an upsert with the same data).

### Step 4: Implement auto-sync wrapper

Create a `withPlanAutoSync(planId, repoRoot, fn)` helper in `src/tim/plan_materialize.ts`:

1. Check if a materialized file exists at `getMaterializedPlanPath(repoRoot, planId)`.
2. If yes, call `syncMaterializedPlan()` to sync any file edits to DB first.
3. Execute the provided `fn()` callback (the actual DB modification).
4. If the file existed (or should be re-materialized), call `materializePlan()` to update the file.

This pattern lets commands do:
```typescript
await withPlanAutoSync(planId, repoRoot, () => {
  // modify plan in DB
});
```

### Step 5: Add `tim materialize` CLI command

Create `src/tim/commands/materialize.ts`:

- Accepts a plan ID argument (resolved to numeric ID, then look up in DB).
- Always materializes related plans (parent/children/siblings/dependencies) as `.ref.md` files.
- Calls `materializePlan()` and `materializeRelatedPlans()`.
- Prints the primary plan's path to stdout.

Register in `src/tim/tim.ts` following the existing dynamic import pattern.

### Step 6: Add `tim sync` CLI command

Create `src/tim/commands/sync.ts`:

- Accepts a plan ID argument.
- Looks up the materialized file at the well-known path (`getMaterializedPlanPath(repoRoot, planId)`).
- Calls `syncMaterializedPlan()`.
- Prints status.

Register in `src/tim/tim.ts`.

### Step 7: Add cleanup for stale materialized files

Add a `cleanupMaterializedPlans(repoRoot)` function:

1. Scan `.tim/plans/` for `*.plan.md` and `*.ref.md` files.
2. For each file, check if the plan still exists in the DB and is relevant (e.g., not done/cancelled for a long time).
3. Delete stale files from disk.
4. Log what was cleaned up.

This could be invoked from:
- Integrated into the existing `tim cleanup` command.
- Optionally called at startup of long-running commands (agent).

### Step 8: Write comprehensive tests

Create `src/tim/plan_materialize.test.ts`:

- **Round-trip test**: Create a plan in DB → materialize → read back → verify all fields match.
- **Edit and sync test**: Materialize → edit the file (change title, add a task) → sync → verify DB updated.
- **Auto-sync wrapper test**: Materialize → edit file externally → call wrapper with DB modification → verify both file edits and DB modification are preserved.
- **Cleanup test**: Create stale materializations → run cleanup → verify files deleted.
- **All fields test**: Verify that all plan schema fields (including `reviewIssues`, `changedFiles`, `docs`, `temp`, `tags`, tasks, dependencies, etc.) survive the round-trip.

Follow existing test patterns: temp dirs, real filesystem, real DB, `clearAllTimCaches()` setup.

### Step 9: Create shared `planRowToSchemaInput()` and update `loadPlansFromDb()`

Create a `planRowToSchemaInput(row, tasks, deps, tags, uuidToPlanId?)` function that converts a single plan's DB data to `PlanSchemaInput`. The `uuidToPlanId` map is optional — if not provided, the function queries the DB for the UUIDs it needs to resolve `parent_uuid` and dependency UUIDs back to numeric plan IDs.

Refactor `loadPlansFromDb()` in `src/tim/plans_db.ts` to use this shared converter instead of its inline field mapping. Include the fields it currently omits: `tdd`, `discoveredFrom`, `baseBranch`, `issue` (parse JSON), `pullRequest` (parse JSON), `temp`, plus all the new columns added in Step 1 (`docs`, `changedFiles`, `planGeneratedAt`, `reviewIssues`).

Both `materializePlan()` and `loadPlansFromDb()` use this converter, avoiding duplicated field mapping.

### Manual Testing Steps

1. `tim add "Test Plan" --priority high` → creates a plan file in tasks/.
2. `tim materialize <id>` → should print `.tim/plans/<id>.plan.md`.
3. `cat` the materialized file → verify it matches the original.
4. Edit the materialized file (change the title).
5. `tim sync <id>` → should report synced.
6. Check the DB (via `tim list` or direct query) → title should be updated.
7. Verify `.ref.md` files were created for parent/children/siblings/dependencies.
8. Verify `.tim/plans/.gitignore` exists with correct patterns.

### Rationale for Key Decisions

- **Reuse `writePlanFile()` with `skipSync`** rather than duplicating file-writing logic: keeps one canonical writer, reduces maintenance burden, ensures materialized files have identical format to tasks/ files.
- **No materialization tracking table**: `syncMaterializedPlan()` always re-reads and compares. Simpler than mtime tracking, avoids extra DB infrastructure, and the cost of re-parsing a YAML file is negligible.
- **`references` field removed entirely**: obsolete in DB-first world where all relationships use UUIDs natively. The `idToUuid` map handles resolution during file→DB sync.
- **Separate `plan_materialize.ts` module** rather than adding to `plan_sync.ts`: keeps the materialization concern separate from the existing file→DB sync. `plan_sync.ts` remains focused on the current file-first flow.

## Current Progress
### Current State
- All tasks (1-15) complete. Plan materialization infrastructure is fully implemented, tested, and reviewed. All review feedback addressed.
### Completed (So Far)
- Migration v9 adds temp, docs, changed_files, plan_generated_at, review_issues columns
- PlanRow, UpsertPlanInput, upsertPlan(), toPlanUpsertInput() all updated for new fields
- Obsolete fields (generatedBy, rmfilter, promptsGeneratedAt, compactedAt, statusDescription, references) removed from Zod schema; kept as passthrough TypeScript types for compatibility until plan 282
- planRowToSchemaInput() created in plans_db.ts - converts DB rows to PlanSchemaInput with full field coverage
- loadPlansFromDb() refactored to use planRowToSchemaInput()
- src/tim/plan_materialize.ts created with full infrastructure: materializePlan(), materializeRelatedPlans(), materializeAndPruneRelatedPlans(), syncMaterializedPlan(), withPlanAutoSync(), cleanupMaterializedPlans(), pruneUnusedRefFiles(), collectNeededRefPlanIds(), refreshRelatedRefs()
- writePlanFile() extended with skipSync option to prevent circular syncPlanToDb() calls
- getPlanByPlanId() and getPlanDependenciesByUuid() added to db/plan.ts
- syncPlanToDb() extended with throwOnError and cwdForIdentity options
- syncMaterializedPlan() preserves canonical tasks-dir filename in DB
- CLI commands: `tim materialize <planId>`, `tim sync <planId>` (materialized), `tim cleanup-materialized`
- ensureMaterializeDir() idempotently enforces .gitignore patterns
- 20 tests in plan_materialize.test.ts covering round-trip, sync, auto-sync, cleanup, refs, edge cases, and CLI command integration
- `tim sync <planId>` now routes to materialized sync (was previously `tim sync-materialized`); sync-materialized command removed
- ENOENT guards added on all unlink and file-read error paths in plan_materialize.ts
- `changedFiles` added to empty-array cleanup in writePlanFile()
- `tdd: false` added to boolean cleanup in writePlanFile()
- RepositoryIdentity cached and threaded through ProjectContext to reduce git subprocess spawns in withPlanAutoSync and syncMaterializedPlan
### Remaining
- None
### Next Iteration Guidance
- None — plan is complete. Downstream plans 280, 281, 282 can proceed.
### Decisions / Changes
- planRowToSchemaInput() accepts dependency UUIDs (not pre-resolved plan IDs) and resolves them internally, making it directly usable for both bulk loading and single-plan materialization
- Legacy passthrough fields kept on exported PlanSchema/PlanSchemaInput types for compatibility - code like plan_merge.ts actively sets generatedBy, rmfilter, promptsGeneratedAt. Removal deferred to plan 282
- Return type is PlanSchema (not PlanSchemaInput) because PlanWithFilename requires it and PlanSchema is assignable to PlanSchemaInput
- syncMaterializedPlan() pre-validates UUID from raw file content before calling readPlanFile() to avoid auto-UUID side effects
- withPlanAutoSync() uses try/finally with error suppression in finally block to prevent re-materialization errors from masking fn() errors
- buildPlanMaps() warns on duplicate plan IDs but continues (first-wins); getPlanByPlanId() throws on duplicates for safety
- syncPlanToDb() gained throwOnError option for callers that need error propagation (materialized sync path)
- Materialization passes skipUpdatedAt: true to preserve DB timestamps in files
- `tim sync [planId]` unified command: positional planId routes to materialized sync, --plan routes to tasks-dir sync, no args does full sync
- resolveProjectContext() accepts optional RepositoryIdentity to avoid redundant git subprocess spawns
### Lessons Learned
- PlanSchemaInput has `status: unknown` due to z.preprocess(), so it can't satisfy PlanWithFilename which needs the concrete status union. Use PlanSchema as the return type for planRowToSchemaInput.
- The Zod schema uses .passthrough() so removing fields from the schema shape doesn't strip them from parsed data at runtime - they remain on the object, just unvalidated.
- readPlanFile() has a UUID auto-generation side effect that writes back to disk - must pre-validate materialized files before calling it to avoid corrupting files with wrong UUIDs.
- writePlanFile() overwrites updatedAt by default - materialization must pass skipUpdatedAt: true or timestamps will drift on every materialize cycle.
- syncPlanToDb() swallows all errors by default (logs warning). New callers with correctness requirements need throwOnError: true.
- When catching filesystem errors, always check for ENOENT specifically rather than catching all errors — swallowing permission errors or I/O errors silently leads to correctness bugs.
- When multiple functions in a call chain need repository identity, cache it at the entry point and thread it through rather than calling getRepositoryIdentity() multiple times — each call spawns a git subprocess.
### Risks / Blockers
- None
