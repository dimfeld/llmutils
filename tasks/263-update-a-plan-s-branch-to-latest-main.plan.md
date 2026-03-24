---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: update a plan's branch to latest main
goal: ""
id: 263
uuid: c564c53e-15e7-4de3-8b03-84682cbb2cb7
status: pending
priority: medium
createdAt: 2026-03-24T02:06:55.395Z
updatedAt: 2026-03-24T02:06:55.395Z
tasks: []
tags: []
---

This should:
- Select the branch, using either the `branch` in the plan file or the calculated branch name.
- Pull the branch to make sure it's up to date
- rebase the branch to be on top of main
- Fix conflicts, if any (use a prompt with the executor system for this)
- Push the branch back

This should be a CLI command since that's how most everything else works

## Conflicts Prompt

For `jj` repos you can use this prompt

```
The current repo status is:

!`jj status`

Examine the conflicts and make a todo list of conflicts to fix. 

For each conflict, examine each side and the commits lower in the commit tree that modified the lines to get the context for each one.  Unless there's an obvious merge, these conflicts were likely caused by rebasing this branch on top of another (likely main), and so the conflicting changes from the other branch are probably on "main" somewhere. 

As you make edits, describe your reasoning. If it is not clear to you how a conflict should be resolved, stop and ask me what to do, and I will try to provide guidance or resolve it myself. 

When you use `jj squash` as part of this process, do not give it any arguments since the squash message will overwrite
the original commit message.

```

For git you can use similar guidance but with the specific process matching Git commands.
