---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Review Comment Actions
goal: ""
id: 251
uuid: 9222b252-c090-4212-bcf3-2e5c050dd167
status: pending
priority: medium
dependencies:
  - 250
parent: 245
references:
  "245": 50487743-93a6-45c0-bda9-ce9e19100c92
  "250": cb016b34-853c-4efa-893f-221d812b45e8
createdAt: 2026-03-21T02:25:16.065Z
updatedAt: 2026-03-21T02:25:16.074Z
tasks: []
tags: []
---

Add review comments as tasks to plans and trigger automatic fixes via the executor system.

Key deliverables:
- Web UI action: select review comments and add them as tasks to the plan
- Convert review comment to task: title from file+line summary, description from comment body + diff context
- Web UI action: trigger automatic fix for selected review comments
- Integrate with executor system (claude_code / codex_cli) to generate fixes
- Post reply to review thread after fix is applied (using existing addReplyToReviewThread)
- Mark resolved review threads in the cached data
- CLI equivalent: tim pr fix [planId] to fix review comments from terminal
