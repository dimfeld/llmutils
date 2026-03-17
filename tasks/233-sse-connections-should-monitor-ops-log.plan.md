---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: sse connections should monitor ops log
goal: ""
id: 233
uuid: 11108c3f-ad1a-4489-9d88-a25aa089fd8b
status: pending
priority: medium
dependencies:
  - 232
references:
  "232": d8a6e9a4-4754-4f1a-9065-0eeb7a5db0b7
createdAt: 2026-03-17T09:26:45.559Z
updatedAt: 2026-03-17T09:26:45.560Z
tasks: []
tags: []
---

The ops log gives us a natural place to monitor to see what changed in the database. From there we can either send the
ops down to the client, or more simply just send the entire changed objects again.
