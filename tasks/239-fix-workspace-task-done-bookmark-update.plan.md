---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Update workspace bookmark management to prevent conflicts
goal: ""
id: 239
uuid: 63078b54-bf12-4ae9-977d-30dd1c2c7ec9
simple: true
status: done
priority: medium
createdAt: 2026-03-19T01:40:47.569Z
updatedAt: 2026-03-19T09:36:45.819Z
tasks:
  - title: "Address Review Feedback: `tim workspace add --reuse` can now succeed
      with a plan path that does not exist."
    done: true
    description: |-
      `tim workspace add --reuse` can now succeed with a plan path that does not exist. [workspace.ts](/Users/dimfeld/Documents/projects/llmutils/src/tim/commands/workspace.ts#L797) fabricates `planFilePathInWorkspace` for reused workspaces and passes it through without copying or verifying the file. The same command then only warns if [setPlanStatus()](/Users/dimfeld/Documents/projects/llmutils/src/tim/commands/workspace.ts#L1099) fails and still prints next steps pointing the user at that missing file in [workspace.ts](/Users/dimfeld/Documents/projects/llmutils/src/tim/commands/workspace.ts#L1141). The updated tests were changed to expect the file to be absent, e.g. [workspace.reuse.test.ts](/Users/dimfeld/Documents/projects/llmutils/src/tim/commands/workspace.reuse.test.ts#L558) and [workspace_setup.test.ts](/Users/dimfeld/Documents/projects/llmutils/src/tim/workspace/workspace_setup.test.ts#L114), so the regression is now encoded instead of caught.

      Suggestion: For reuse flows, restore plan copying

      Related file: src/tim/commands/workspace.ts:797-809
  - title: "Address Review Feedback: Git workspace creation no longer guarantees
      that the selected plan exists in the new workspace."
    done: true
    description: |-
      Git workspace creation no longer guarantees that the selected plan exists in the new workspace. In [workspace_manager.ts](/Users/dimfeld/Documents/projects/llmutils/src/tim/workspace/workspace_manager.ts#L718), the git path only does `git branch` plus `git push` from the primary workspace. That pushes existing commits only; it never switches to the new branch or stages/commits the plan file. Any new or modified local plan content therefore stays behind. [workspace_setup.ts](/Users/dimfeld/Documents/projects/llmutils/src/tim/workspace/workspace_setup.ts#L345) still returns the workspace-relative plan path unconditionally, and [agent.ts](/Users/dimfeld/Documents/projects/llmutils/src/tim/commands/agent/agent.ts#L380) immediately rereads that path. This breaks the intended "let git syncing handle it" flow for git repos whenever the plan exists only locally, which was previously covered by copying the file.

      Suggestion: Actually switch to the new branch in the primary workspace and ensure the plan file is committed/staged before pushing.

      Related file: src/tim/workspace/workspace_manager.ts:718-745
  - title: "Address Review Feedback: Primary-workspace branch creation is now
      brittle because it blindly creates refs with `git branch` / `jj bookmark
      create` in
      [workspace_manager.ts](/Users/dimfeld/Documents/projects/llmutils/src/tim\
      /workspace/workspace_manager.ts#L723)."
    done: true
    description: |-
      Primary-workspace branch creation is now brittle because it blindly creates refs with `git branch` / `jj bookmark create` in [workspace_manager.ts](/Users/dimfeld/Documents/projects/llmutils/src/tim/workspace/workspace_manager.ts#L723). That regresses behavior compared with creating the ref inside a fresh clone: rerunning workspace creation for the same task now fails if the branch/bookmark already exists locally, and git `--from-branch` now depends on the base ref existing locally in the primary workspace instead of being resolvable from fetched remote refs. There is no coverage for either case.

      Suggestion: Make branch creation idempotent in the primary workspace: reuse/update existing refs when appropriate, and resolve `fromBranch` against fetched remote refs instead of assuming a local branch exists.

      Related file: src/tim/workspace/workspace_manager.ts:723-745
  - title: "Address Review Feedback: The catch block for unexpected exceptions
      during branch creation logs the error and returns null, but does NOT clean
      up `targetClonePath`."
    done: true
    description: >-
      The catch block for unexpected exceptions during branch creation logs the
      error and returns null, but does NOT clean up `targetClonePath`. Compare
      this with the `exitCode !== 0` path at lines 748-755 which does
      `fs.rm(targetClonePath, ...)`. If `spawnAndLogOutput` throws (e.g. due to
      a missing binary), the cloned workspace directory is left behind as an
      orphan.


      Suggestion: Add `await fs.rm(targetClonePath, { recursive: true, force:
      true }).catch(() => {})` before returning null in the catch block.


      Related file: src/tim/workspace/workspace_manager.ts:757-759
changedFiles:
  - eslint.config.js
  - src/tim/commands/workspace.reuse.test.ts
  - src/tim/commands/workspace.ts
  - src/tim/tim.ts
  - src/tim/workspace/workspace_auto_selector.test.ts
  - src/tim/workspace/workspace_manager.test.ts
  - src/tim/workspace/workspace_manager.ts
  - src/tim/workspace/workspace_roundtrip.test.ts
  - src/tim/workspace/workspace_roundtrip.ts
  - src/tim/workspace/workspace_setup.test.ts
  - src/tim/workspace/workspace_setup.ts
tags: []
---

Two changes:

## Branch creation

Create the new branch in the current workspace and push it to origin, and then pull it from there in the new
workspace. Stop copying the plan file over to the new workspace; we let git syncing handle that. 
## Syncing back

If using jj, then when updating the bookmark at the end of a run in a workspace before pushing it back, we should commit if there are any changes to be committed, and then set it to "@-". Otherwise we can't push back because the bookmark points to an empty commit.

## Notes

If we are using jj, we need to see if there are any changes in the current revision. If so, then we can `jj commit` with an appropriate message and then
create or update the bookmark pointing to `@-`. If the current revision is empty, then just point the bookmark to `@-`,
no need to commit.

## Current Progress
### Current State
- All tasks complete. All review feedback addressed and verified.
### Completed (So Far)
- Branch creation now happens in primary workspace, pushed to origin, then fetched in new workspace
- Fixed bookmark sync-back: removed `ensureJjBookmarkAtCurrent: true` from post-execution push calls so bookmark stays at `@-`
- Fixed isJj detection: primary workspace VCS type (`isPrimaryJj`) used for branch creation, new workspace VCS type (`isJj`) used for checkout
- Added workspace_roundtrip.test.ts with bookmark handling tests
- Restored plan file copying in reuse flow (`tryReuseExistingWorkspace`) and workspace_setup for existing workspaces
- Git workspace creation now stages/commits plan file before branch creation so new workspace gets the plan
- Branch creation made idempotent: `git branch -f` and `jj bookmark set` instead of create; `fromBranch` falls back to `origin/<branch>` for git
- Added cleanup of `targetClonePath` in catch block during branch creation errors
- Updated tests in workspace_manager.test.ts, workspace_setup.test.ts, workspace.reuse.test.ts
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Two separate VCS type detections needed: one for primary workspace (branch creation/push) and one for new workspace (checkout/fetch), since cloneMethod='git' can produce a non-jj clone from a jj primary
### Lessons Learned
- When `ensureJjBookmarkAtCurrent` defaults to `@` revision, it silently overrides any prior bookmark positioning to `@-`. Any code that deliberately places a bookmark at a non-default revision must ensure downstream operations don't reset it.
### Risks / Blockers
- None
