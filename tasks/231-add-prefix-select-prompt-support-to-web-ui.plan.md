---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Add prefix_select prompt support to web UI
goal: ""
id: 231
uuid: 1a1b1c8e-f3f2-4e38-b5cd-a3d518a23150
status: pending
priority: medium
dependencies:
  - 229
discoveredFrom: 227
references:
  "227": 6787e32d-3918-440e-8b8b-0562ba59e095
  "229": fb9383c8-5ee1-4084-afe6-8a8572189d4e
createdAt: 2026-03-17T09:05:46.119Z
updatedAt: 2026-03-17T09:05:46.119Z
tasks: []
tags: []
---

Add prefix_select prompt type rendering to the web Sessions view. This is a custom prompt type specific to tim that was deferred from the initial Sessions implementation (plan 229). Requires implementing the prefix selection UI component that matches the CLI behavior.
