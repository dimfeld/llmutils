---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: fix workspace task done bookmark update
goal: ""
id: 239
uuid: 63078b54-bf12-4ae9-977d-30dd1c2c7ec9
status: pending
priority: medium
createdAt: 2026-03-19T01:40:47.569Z
updatedAt: 2026-03-19T01:40:47.569Z
tasks: []
tags: []
---

When updating the jj bookmark at the end of a run in a workspace before pushing it back, we should commit if there are any changes to be committed, and then set it to "@-". Otherwise we can't push back because the bookmark points to an empty commit.
