---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Build activity feed UI from activity_log table
goal: "Build the Recent Activity feed section at the bottom of the Active Work dashboard, reading from the activity_log table with infinite scroll pagination, and supplement with live SSE session events."
id: 267
uuid: 7c25094d-02da-438c-847c-1426e31575b1
status: pending
priority: medium
dependencies:
  - 265
parent: 264
references:
  "264": 80611f4c-32a4-4b3b-90c2-4e7e35cc519b
  "265": 428ed935-e91e-4d20-a4cb-46947ee8b2aa
createdAt: 2026-03-24T19:15:16.402Z
updatedAt: 2026-03-24T19:15:24.558Z
tasks: []
tags: []
---

## Details

### Feed content
- Reads from `activity_log` table via a server API endpoint
- Each entry: timestamp, event icon/type, summary text, link to relevant plan/PR/workspace
- Entries grouped by day with date headers
- Live SSE session events (agent started, task completed, etc.) interleaved at the top for the current browser session

### Pagination
- Cursor-based: load N most recent, then "load more" button or infinite scroll
- API endpoint: `GET /api/activity?projectId=X&before=TIMESTAMP&limit=50`

### Rendering
- Compact timeline layout — icon + one-line summary + relative timestamp per row
- Different event types get different icons/colors (plan status change, PR event, agent lifecycle, etc.)
- Plan titles are clickable links to plan detail
- Collapsible section with "Recent Activity" header and count

### Real-time updates
- New activity log entries pushed via SSE alongside existing session events
- New entries animate in at the top of the feed
