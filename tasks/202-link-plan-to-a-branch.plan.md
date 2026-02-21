---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: link plan to a branch
goal: ""
id: 202
uuid: d9953b72-c29f-4c67-a6dc-4ba86692692f
status: pending
priority: medium
createdAt: 2026-02-21T21:41:54.726Z
updatedAt: 2026-02-21T21:41:54.727Z
tasks: []
tags: []
---

We should be able to link a plan to the latest branch on which work was done for it. Add a new `branch` field to the plan
schema and in the sqlite tasks schema as well.

When running `generate` or `agent` commands, if we are not on a trunk branch then set `branch` to the current branch name.

If `branch` is already set, then we should overwrite it since we always want the latest value.
