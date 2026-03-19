---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Update how workspace bookmarks work
goal: ""
id: 239
uuid: 63078b54-bf12-4ae9-977d-30dd1c2c7ec9
status: pending
priority: medium
createdAt: 2026-03-19T01:40:47.569Z
updatedAt: 2026-03-19T08:12:51.955Z
tasks: []
tags: []
---

Two changes:

## Branch creation

Create the new branch in the current workspace and push it to origin, and then pull it from there in the new
workspace. Stop copying the plan file over to the new workspace; we let git syncing handle that. Note that if we are
using jj, we need to see if there are any changes in the current revision. If so, then we can `jj commit` and then
create the bookmark pointing to `@-`. If there are no changes, then just create the bookmark pointing to `@-`.

## Syncing back

If using jj, then when updating the bookmark at the end of a run in a workspace before pushing it back, we should commit if there are any changes to be committed, and then set it to "@-". Otherwise we can't push back because the bookmark points to an empty commit.
