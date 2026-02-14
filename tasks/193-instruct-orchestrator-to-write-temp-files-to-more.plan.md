---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: instruct orchestrator to write temp files to more unique paths
goal: ""
id: 193
uuid: 8bb18a13-4fe5-4021-ba64-38d07cd1b268
status: pending
priority: medium
createdAt: 2026-02-14T02:43:57.668Z
updatedAt: 2026-02-14T02:43:57.669Z
tasks: []
tags: []
---

Claude code often makes temp files to pass to the subagents but the names are generic like "implementer-instructions.md"
and so it conflicts with previous runs. Update the prompt to ask the orchestrator to write temp files to more unique paths, like including the plan ID in the filename.
