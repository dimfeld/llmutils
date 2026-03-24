---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "Web UI: Plan activity timeline"
goal: Add an activity timeline to the plan detail view showing a chronological
  history of state changes, agent runs, PR activity, and task completions,
  giving users context on what has happened with a plan over time.
id: 270
uuid: 381530dc-76e7-435c-9c8e-2a590009e667
status: pending
priority: medium
dependencies:
  - 265
references:
  "265": 428ed935-e91e-4d20-a4cb-46947ee8b2aa
createdAt: 2026-03-24T19:18:04.002Z
updatedAt: 2026-03-24T19:21:43.488Z
tasks: []
tags:
  - web-ui
---

## Overview

The plan detail view shows current state but no history. An activity timeline would show what happened and when — agent runs, status changes, task completions, PR events — giving users the full context of a plan's progression.

## Key Features

- **Timeline component**: Chronological list of events on the plan detail page, newest first or oldest first with toggle.
- **Event types**: Status changes, agent/generate session starts and completions, task marked done, PR opened/merged, dependency resolved.
- **Data source**: This depends on the activity log table from plan 265. The timeline reads from that table filtered by plan ID.
- **Compact display**: Show event type icon, description, relative timestamp. Expandable for details.

## Implementation Notes

- Depends on plan 265 (activity log table) being implemented first
- Add a `getActivityForPlan(planId)` query to `db_queries.ts`
- Render as a vertical timeline component in `PlanDetail.svelte` or as a separate tab/section
- Consider SSE streaming for live updates to the timeline
