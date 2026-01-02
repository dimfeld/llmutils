---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: option for workspace add to reuse existing workspace
goal: ""
id: 159
uuid: 2e7fd645-2945-4e49-a485-3cf5a4ba81ff
status: pending
priority: medium
createdAt: 2026-01-02T19:34:21.192Z
updatedAt: 2026-01-02T19:34:21.192Z
tasks: []
tags: []
---

This should work similarly to the `workspace lock` command, in that it can find and reuse an existing workspace if there is one available that is unlocked.

In this case, we also want to make sure the reused workspace is up to date:
- `jj git fetch` or `git pull`
- `jj new main` or `git checkout main`
- And then create the new branch and do everything else we tend to do

We should also add a `--from-branch` argument which allows it to create the new branch off of a different base instead of main.
