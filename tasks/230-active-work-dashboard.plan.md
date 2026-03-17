---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Active work dashboard
goal: ""
id: 230
uuid: 0a5407ee-b3bb-4dff-9790-68f54c8b44a7
status: pending
priority: medium
dependencies:
  - 228
parent: 227
references:
  "227": 6787e32d-3918-440e-8b8b-0562ba59e095
  "228": 68fe5243-cd4b-46cf-81e1-6f930d29e40b
createdAt: 2026-03-17T09:05:23.149Z
updatedAt: 2026-03-17T09:05:23.157Z
tasks: []
tags: []
---

Implement the Active Work tab showing per-project workspaces and active plans. Workspaces section shows recently active workspaces by default (locked, primary, or updated within 48 hours) with toggle to show all. Plans section shows in_progress and blocked plans only. Reuses project sidebar and plan display components from plan 228.
