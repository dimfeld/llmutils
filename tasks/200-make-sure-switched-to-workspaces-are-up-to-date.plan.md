---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: make sure switched-to workspaces are up to date
goal: ""
id: 200
uuid: 54af44f2-f84a-457c-a0e6-5d89b67d4b5d
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-02-18T09:12:22.490Z
promptsGeneratedAt: 2026-02-18T09:12:22.490Z
createdAt: 2026-02-18T08:55:10.767Z
updatedAt: 2026-02-18T19:46:11.355Z
tasks:
  - title: Add workspaceUpdateCommands to config schema
    done: true
    description: In src/tim/configSchema.ts, add a workspaceUpdateCommands field to
      workspaceCreationConfigSchema as
      z.array(postApplyCommandSchema).optional(). Place it right after
      postCloneCommands for logical grouping. Also export the type. No defaults
      in the zod schema per CLAUDE.md instructions.
  - title: Add --base flag to generate and agent/run CLI commands
    done: true
    description: In src/tim/tim.ts, add .option('--base <ref>', 'Base branch or
      revision to checkout in workspace') to the generate command definition
      (around line 297) and to the createAgentCommand() function (around line
      570). The name --base matches existing conventions in review,
      pr-description, and other commands.
  - title: Plumb --base option through to setupWorkspace()
    done: true
    description: "Update WorkspaceSetupOptions in
      src/tim/workspace/workspace_setup.ts to include base?: string. Update both
      handleGenerateCommand() in generate.ts and timAgent() in agent.ts to pass
      options.base through to the setupWorkspace() call."
  - title: Create shared runWorkspaceUpdateCommands() helper
    done: true
    description: Create a shared helper function (e.g., in workspace_manager.ts or a
      new workspace_update.ts) that takes a workspace path, config, taskId, and
      optional plan file path, then iterates over
      config.workspaceCreation?.workspaceUpdateCommands and runs each via
      executePostApplyCommand() with LLMUTILS_TASK_ID and
      LLMUTILS_PLAN_FILE_PATH environment variables injected (same pattern as
      postCloneCommands in createWorkspace()). Returns false if any
      non-allowFailure command fails.
  - title: Add workspace preparation logic to setupWorkspace()
    done: true
    description: "Core change. In setupWorkspace(), after selecting an existing
      workspace but before copying the plan file, add preparation for existing
      workspaces (skip for isNewWorkspace=true): (1) Check for uncommitted
      changes using getWorkingCopyStatus(). If found, throw error. (2) Call
      prepareExistingWorkspace() with baseBranch from options.base, branchName
      from workspace.taskId, createBranch from config. (3) If preparation fails,
      always throw. (4) Call runWorkspaceUpdateCommands() helper. If it fails,
      throw. Keep lock acquisition AFTER preparation."
  - title: Add workspace update commands to workspace reuse flow
    done: true
    description: In src/tim/commands/workspace.ts, after the
      prepareExistingWorkspace() call in the reuse flow (around line 680), call
      the shared runWorkspaceUpdateCommands() helper. This ensures both
      setupWorkspace() and workspace reuse run the same update commands for
      consistency. If a non-allowFailure update command fails, treat it as a
      preparation failure (restore workspace state and release lock).
  - title: Write tests for workspace preparation in setupWorkspace()
    done: true
    description: "Add tests to src/tim/workspace/workspace_setup.test.ts covering:
      prepareExistingWorkspace() called for existing workspace (not new); NOT
      called for new workspace; uncommitted changes cause hard failure;
      workspace update commands executed after preparation; allowFailure: false
      aborts setup; allowFailure: true allows continuation; --base option passed
      as baseBranch; missing base defaults to trunk auto-detection. Use existing
      test patterns from workspace_prepare.test.ts and workspace_setup.test.ts."
  - title: Update README documentation
    done: true
    description: Document the new --base flag and workspaceUpdateCommands config
      option in the README, under the workspace configuration section. Include
      examples showing config YAML for workspaceUpdateCommands (e.g., pnpm
      install) and CLI usage of --base.
  - title: "Address Review Feedback: Race condition: setupWorkspace() runs
      preparation without holding a lock."
    done: true
    description: >-
      Race condition: setupWorkspace() runs preparation without holding a lock.
      In workspace_setup.ts, when reusing an existing workspace, all preparation
      steps (dirty check at line 139, prepareExistingWorkspace() at line 152,
      runWorkspaceUpdateCommands() at line 163, and plan file copy at line 193)
      execute BEFORE the lock is acquired at line 217. Another concurrent
      process could select the same workspace and start its own preparation
      concurrently, since neither process holds a lock during this phase. By
      contrast, tryReuseExistingWorkspace() in workspace.ts correctly acquires
      the lock at line 649 BEFORE calling prepareExistingWorkspace() at line
      680. While the lock ordering was pre-existing, plan 200 greatly expanded
      the unprotected window by adding prepareExistingWorkspace() and
      runWorkspaceUpdateCommands() (both involving git operations and command
      execution) into the unprotected phase.


      Suggestion: Move lock acquisition to immediately after workspace selection
      (around line 131-136), before the dirty check. If preparation fails,
      release the lock and throw. This matches the correct pattern already used
      in workspace.ts tryReuseExistingWorkspace().


      Related file: src/tim/workspace/workspace_setup.ts:138-173
  - title: "Address Review Feedback: workspace.ts computes the plan file path in the
      workspace twice with potentially different variable names but identical
      logic."
    done: true
    description: >-
      workspace.ts computes the plan file path in the workspace twice with
      potentially different variable names but identical logic.
      planFilePathInWorkspace at line 695-700 and copiedPlanFilePathInWorkspace
      at line 720-721 produce the same value. This duplication is error-prone if
      one path computation changes and the other doesn't.


      Suggestion: Reuse the planFilePathInWorkspace variable instead of
      computing copiedPlanFilePathInWorkspace separately. Just use
      planFilePathInWorkspace for both the update commands call and the plan
      file copy.


      Related file: src/tim/commands/workspace.ts:695-721
changedFiles:
  - CLAUDE.md
  - README.md
  - src/common/git.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/generate.ts
  - src/tim/commands/workspace.reuse.test.ts
  - src/tim/commands/workspace.ts
  - src/tim/configSchema.ts
  - src/tim/tim.ts
  - src/tim/workspace/workspace_manager.ts
  - src/tim/workspace/workspace_setup.test.ts
  - src/tim/workspace/workspace_setup.ts
  - tim-gui/TimGUI/SessionState.swift
  - tim-gui/TimGUITests/SessionStateTests.swift
tags: []
---

When doing commands that switch workspaces such as `generate` and `run` with the --auto-workspace
  flag or similar flags, we should make sure that the switched-to workspace is current in git/jj.

- do a "git pull && git checkout <trunk>" or "jj git fetch && jj new <trunk>"
- run arbitrary workspace update commands, which we should be able to define in the config file. These would be things
like "pnpm install" for example.

Only then should we proceed with doing whatever else the command does, e.g. copying plan files, running, etc.

Also add a --branch flag to these commands. This flag should allow specifying an alternate base instead of the trunk branch. For example, when doing stacked diffs we might want to work off of some other branch. Don't require it to be a branch, it could also be a git sha or jj change ID, but the way the commands work all of those should be interchangeable.

## Current Progress
### Current State
- All 10 tasks are complete. Plan is done.
- Latest review-fix iteration aligned workspace update-command ordering so plan-path env vars point to existing files.
- Latest review-fix iteration aligned both reuse entry points on branch-creation defaults: `setupWorkspace()` and `workspace add --reuse` now both default `createBranch` to `true` when unset.
- Latest review-fix iteration ensures failed plan-copy fallback does not pass a source-repo plan path to workspace update commands.
- README workspace reuse flow steps now match the implemented ordering: copy plan file before running `workspaceUpdateCommands`.
- `setupWorkspace()` now makes new-vs-existing plan-copy behavior explicit, removing reliance on a redundant second call for existing workspaces.

### Completed (So Far)
- Added `workspaceUpdateCommands` to `workspaceCreationConfigSchema` in `src/tim/configSchema.ts`
- Added `--base <ref>` CLI option to `generate` and `agent/run` commands in `src/tim/tim.ts`
- Plumbed `options.base` through `handleGenerateCommand()` and `timAgent()` to `setupWorkspace()`
- Created shared `runWorkspaceUpdateCommands()` helper in `src/tim/workspace/workspace_manager.ts` that iterates over config commands, injects env vars, and returns false on non-allowFailure failures
- Added workspace preparation logic to `setupWorkspace()`: checks dirty state via `getWorkingCopyStatus()`, calls `prepareExistingWorkspace()`, then runs update commands — all skipped for new workspaces
- Added workspace update commands to workspace reuse flow in `src/tim/commands/workspace.ts`, treating failures as preparation failures (restore/release lock)
- Exported `getWorkingCopyStatus` from `src/common/git.ts`
- Wrote 25 passing tests in `workspace_setup.test.ts` covering all scenarios
- README documentation added for `--base` flag and `workspaceUpdateCommands` (commit 48d8def7)
- Fixed race condition in `setupWorkspace()`: lock now acquired immediately after workspace selection, before dirty check and preparation steps. Lock released on failure. Matches pattern in `tryReuseExistingWorkspace()`
- Removed duplicate plan file path computation in `workspace.ts`: reuse `planFilePathInWorkspace` instead of separate `copiedPlanFilePathInWorkspace`
- Added regression tests for lock ordering and plan path deduplication
- Fixed README workspace flow ordering so docs match lock-before-prepare behavior in `setupWorkspace()`
- Fixed inherited `setupWorkspace()` plan copy path bug by preserving plan path relative to the base directory instead of using `path.basename()`
- Ensured nested plan path directories are created before copying plan files in `setupWorkspace()`
- Added regression coverage for nested plan file copy paths in `workspace_setup.test.ts`
- Added regression coverage for nested plan file copy paths when reusing existing/manual workspaces, and verified the same nested path is passed to workspace update commands
- Removed unreachable defensive guard in `tryReuseExistingWorkspace()` after plan path dedup refactor; `planFilePathInWorkspace` is guaranteed when `resolvedPlanFilePath` is set
- Kept the deduplicated path flow and satisfied TypeScript narrowing with a local invariant-based non-null assertion (`resolvedPlanPathInWorkspace`) in the `resolvedPlanFilePath` branch
- Reordered workspace reuse/update flow so copied plan files exist before `runWorkspaceUpdateCommands()` runs:
- In `setupWorkspace()`, existing workspaces now copy the plan into the workspace before update commands and pass the actual existing path to `LLMUTILS_PLAN_FILE_PATH`
- In `workspace add --reuse`, plan files are copied before update commands, and rollback now also removes newly copied plan files when update commands fail
- Added/updated regression coverage to assert the plan file exists when update commands run in both `setupWorkspace()` and `workspace add --reuse` flows
- Corrected README existing-workspace flow step order so docs reflect actual execution order (copy plan file, then run `workspaceUpdateCommands`)
- Simplified `setupWorkspace()` plan-copy control flow so the post-validation copy step runs only for new workspaces; existing workspaces perform the copy in their preparation branch only
- Fixed default mismatch for reused workspaces: `setupWorkspace()` now passes `createBranch: config.workspaceCreation?.createBranch ?? true` to `prepareExistingWorkspace()`
- Updated `workspace_setup.test.ts` expectations so default reuse behavior asserts `createBranch: true` when unset
- Fixed default mismatch in `workspace add --reuse`: `tryReuseExistingWorkspace()` now passes the already-defaulted `shouldCreateBranch` to `prepareExistingWorkspace()` instead of raw `options.createBranch`
- Added regression coverage in `workspace.reuse.test.ts` for default reuse behavior when `createBranch` is omitted, asserting branch creation and tracked branch updates
- Updated existing-workspace fallback behavior in `setupWorkspace()` so if plan copy fails, `runWorkspaceUpdateCommands()` is invoked with `planFilePath` omitted (`undefined`) instead of the source-repo plan path
- Added regression coverage in `workspace_setup.test.ts` for the plan-copy failure path, asserting update commands run without a plan-file env path

### Remaining
- Decide whether git workspace preparation should move to remote tip after fetch (`checkout` + `reset --hard origin/<base>` or equivalent), since current fetch + local checkout can leave stale local branches.

### Next Iteration Guidance
- If plan scope expands beyond review-fix parity, address the pre-existing git reuse freshness gap in `prepareExistingWorkspace()` and add regression coverage for local-behind-remote scenarios.

### Decisions / Changes
- `runWorkspaceUpdateCommands()` placed in `workspace_manager.ts` (not a new file) to keep related workspace management logic together
- `getWorkingCopyStatus()` exported from `src/common/git.ts` so `setupWorkspace()` can check for uncommitted changes
- Lock acquisition in `setupWorkspace()` moved before preparation to match `tryReuseExistingWorkspace()` pattern
- For the dead-guard cleanup, retained single-source plan path computation and used a local asserted variable instead of reintroducing duplicate path construction
- `workspaceUpdateCommands` now receive `LLMUTILS_PLAN_FILE_PATH` that points to an already-copied file in reuse flows, matching `postCloneCommands` expectations
- Explicitly guarded the post-validation `copyPlanIntoWorkspace()` call with `isNewWorkspace` to remove a redundant existing-workspace invocation path and keep control flow intent clear
- In existing-workspace fallback paths where plan copy fails, update commands now run without `LLMUTILS_PLAN_FILE_PATH` rather than with a path outside the workspace
- `workspace add --reuse` now uses its computed `shouldCreateBranch` value for preparation so defaulting behavior is applied consistently at the call boundary

### Lessons Learned
- When adding operations to an existing code path, check whether the surrounding locking/synchronization assumptions still hold. Adding git operations and command execution to a previously-lightweight unlocked phase turned a minor race window into a significant one.
- When copying plan files into workspaces, keep the path mapping consistent across code paths (`path.relative(baseDir, planFile)`), otherwise nested plan files silently move to the workspace root and break env/path assumptions.
- Coverage for a path fix should include both auto-created and reused workspace flows; only testing one selection mode can miss regressions in shared setup behavior.
- After simplifying duplicate path-computation logic, re-check defensive assertions for reachability; stale guards can become dead code and obscure real invariants.
- In strict TypeScript code, removing unreachable runtime guards may require explicit invariant expression (`!`) to preserve type safety without duplicating logic.
- If command hooks use a path env var, pass a path that already exists at execution time. Passing a "future" path creates nondeterministic behavior when old files happen to exist from prior runs.
- In copy-failure fallbacks, avoid reusing the original source-repo plan path for workspace hooks; omitting the env var is safer and makes hook behavior explicit.
- After reordering runtime operations, update workflow docs in the same pass; otherwise docs can lag behind code even when behavior is correct.
- Avoid control flow that depends on a no-op guard (`planFile === workspacePlanFile`) for correctness; explicit branch structure is clearer and less fragile to later refactors.
- When two entry points share reuse semantics, keep default values identical in both paths or users will see behavior drift depending on which command they used.
- If a function computes an effective default (like `shouldCreateBranch`), pass that computed value downstream rather than the raw optional input, or defaults can silently diverge.

### Risks / Blockers
- None

