---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: make sure switched-to workspaces are up to date
goal: ""
id: 200
uuid: 54af44f2-f84a-457c-a0e6-5d89b67d4b5d
status: pending
priority: medium
createdAt: 2026-02-18T08:55:10.767Z
updatedAt: 2026-02-18T08:55:10.767Z
tasks: []
tags: []
---

When doing commands that switch workspaces such as `generate` and `run` with the --auto-workspace
  flag or similar flags, we should make sure that the switched-to workspace is current in git/jj.

- do a "git pull && git checkout <trunk>" or "jj git fetch && jj new <trunk>"
- run arbitrary workspace update commands, which we should be able to define in the config file. These would be things
like "pnpm install" for example.

Only then should we proceed with doing whatever else the command does, e.g. copying plan files, running, etc.

Also add a --branch flag to these commands. This flag should allow specifying an alternate base instead of the trunk branch. For example, when doing stacked diffs we might want to work off of some other branch. Don't require it to be a branch, it could also be a git sha or jj change ID, but the way the commands work all of those should be interchangeable. 
