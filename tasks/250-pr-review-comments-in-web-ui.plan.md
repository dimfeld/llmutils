---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: PR Review Comments in Web UI
goal: ""
id: 250
uuid: cb016b34-853c-4efa-893f-221d812b45e8
status: pending
priority: medium
dependencies:
  - 248
parent: 245
references:
  "245": 50487743-93a6-45c0-bda9-ce9e19100c92
  "248": f92da2f3-c73f-4b89-83c8-03b509d58d1d
createdAt: 2026-03-21T02:25:08.526Z
updatedAt: 2026-03-21T02:25:08.537Z
tasks: []
tags: []
---

Surface individual PR review comment threads on the plan detail page in the web UI.

Key deliverables:
- Extend fetchPrFullStatus() or add separate query to fetch review threads with full context (file, line, diff hunk, comment body, author, resolved/unresolved status)
- DB table for cached review threads and comments (or extend pr_review table)
- New PlanDetail section showing review threads grouped by file
- Each thread shows: file path + line, comment body, resolved/outdated status, diff context
- Collapsible thread view for plans with many comments
- Filter: show all / unresolved only
- Refresh review data as part of the stale-while-revalidate pattern from plan 248
