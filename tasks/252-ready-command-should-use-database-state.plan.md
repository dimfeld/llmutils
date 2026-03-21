---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: ready command should use database state
goal: ""
id: 252
uuid: 33f4731f-f5f6-4b0a-91a9-4c1bbb7b78fe
status: pending
priority: medium
createdAt: 2026-03-21T08:06:15.269Z
updatedAt: 2026-03-21T08:06:15.269Z
tasks: []
tags: []
---

In the same way that `tim list` uses database state by default, `tim ready` should do the same
unless a `--local` flag is provided.
