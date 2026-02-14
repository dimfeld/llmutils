---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: single command to push branch to the primary local repo
goal: ""
id: 163
uuid: d8000fcc-d6f2-427e-91db-b4029afa1791
status: done
priority: medium
createdAt: 2026-01-05T06:40:39.303Z
updatedAt: 2026-02-15T05:32:03.797Z
tasks:
  - title: Add findPrimaryWorkspaceForRepository helper
    done: true
    description: Added findPrimaryWorkspaceForRepository() to workspace_info.ts
  - title: Implement handleWorkspacePushCommand handler
    done: true
    description: Created handleWorkspacePushCommand in commands/workspace.ts
  - title: Register workspace push command in tim.ts
    done: true
    description: Added push subcommand to workspaceCommand in tim.ts
  - title: Write tests for workspace push command
    done: true
    description: Created workspace.push.test.ts with 7 passing tests
  - title: Update README with workspace push documentation
    done: true
    description: Added workspace push docs to README.md
tags: []
---

We have a concept of a primary checkout for a project. Add a command that will:
- Add a git remote to the current repo that points to the directory of the primary checkout
- Push the current branch to that primary checkout. For `jj` we will need to track the bookmark against the primary repo
remote too.
- Optionally push to origin as well.

We should add a command to `tim workspace` that will allow setting a particular checkout as the primary. This can
take the place of the current method which defines it in sourceDirectory in configSchema.ts.

## Current Progress
### Current State
- All 5 tasks are complete. The `tim workspace push` command is fully implemented and tested.
### Completed (So Far)
- findPrimaryWorkspaceForRepository helper in workspace_info.ts
- handleWorkspacePushCommand handler in commands/workspace.ts
- Command registration in tim.ts
- 7 integration tests passing in workspace.push.test.ts
- README documentation for the new command
### Remaining
- Optional future enhancement: `--origin` flag to also push to origin remote (mentioned in plan but not in task list)
### Next Iteration Guidance
- If adding `--origin` flag, add an option to the command registration in tim.ts and handle it in handleWorkspacePushCommand
### Decisions / Changes
- Git mode uses `git fetch` from the primary workspace side (instead of `git push` from secondary) to avoid non-bare repo push rejection when the branch is checked out
- jj mode uses the traditional remote add + `jj git push` approach since jj requires remotes for push
- Removed jj bookmark tracking step: `jj git push` handles creating refs on the remote without needing prior `jj bookmark track`
- jj ensurePrimaryJjRemote parses URL from `jj git remote list` output and skips set-url when URL already matches
### Lessons Learned
- Pushing to a non-bare git repo fails with receive.denyCurrentBranch when the pushed branch is checked out. Using fetch from the target side avoids this entirely.
- jj bookmark tracking is for the fetch direction (tracking remote bookmarks locally), not needed for the push direction. `jj git push` creates refs without prior tracking.
- jj bookmark track exits non-zero when already tracked, so treating it as fatal breaks idempotency.
### Risks / Blockers
- None
