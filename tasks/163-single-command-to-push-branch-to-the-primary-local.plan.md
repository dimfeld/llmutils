---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: single command to push branch to the primary local repo
goal: ""
id: 163
uuid: d8000fcc-d6f2-427e-91db-b4029afa1791
status: pending
priority: medium
createdAt: 2026-01-05T06:40:39.303Z
updatedAt: 2026-01-05T06:40:39.303Z
tasks: []
tags: []
---

We have a concept of a primary checkout for a project. Add a command that will:
- Add a git remote to the current repo that points to the directory of the primary checkout
- Push the current branch to that primary checkout. For `jj` we will need to track the bookmark against the primary repo
remote too.
- Optionally push to origin as well.

We should add a command to `tim workspace` that will allow setting a particular checkout as the primary. This can
take the place of the current method which defines it in sourceDirectory in configSchema.ts.
