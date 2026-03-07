---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: workspace tagging for auto mode
goal: ""
id: 217
uuid: 9c2ce79a-286c-459c-9d75-a1b5fa60ece4
status: pending
priority: medium
createdAt: 2026-03-07T02:47:09.372Z
updatedAt: 2026-03-07T07:33:24.177Z
tasks: []
tags: []
---

Ability to tag workspaces as auto workspaces or not.
When at least one workspace is tagged as auto, anything that needs to automatically choose a workspace can only choose from the set of auto workspaces. 

We can rename the is_primary column for this to workspace_type:
- 0 standard
- 1 primary
- 2 auto

This should allow the current values to persist without needing to be changed.
