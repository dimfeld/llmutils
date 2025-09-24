---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Better handling of running in a specific branch
goal: ""
id: 123
status: pending
priority: medium
createdAt: 2025-09-24T09:39:53.535Z
updatedAt: 2025-09-24T09:39:53.535Z
tasks: []
---

This mostly is related to the `rmplan agent` command, adding a `--branch` flag to select a branch to run in.

We should be able to:
- Select a branch to run in when running in the current directory
- Select a branch to run in when using the --auto-workspace or similar options
- Gracefully handle the selected plan not existing in the branch, by copying it into that branch.

Implementation Challenges:
- Handle jj bookmarks as well as git branches. Make to sure run `git pull` and/or `jj git fetch && jj new <bookmark>` to ensure we have the
latest version of the repository.
- Handle the case where the plan needs to be copied into the new branch, but its ID is already in use, potentially
causing a conflict. I think here we want to choose the next available ID and write the plan into the workspace in the new branch with that ID.
