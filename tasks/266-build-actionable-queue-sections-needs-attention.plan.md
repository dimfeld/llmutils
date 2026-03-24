---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Build actionable queue sections (Needs Attention, Running Now, Ready to Start)
goal: "Build the top sections of the new Active Work dashboard: Needs Attention (items requiring human decision), Running Now (live agent sessions), and Ready to Start (unblocked plans with no active session). Replace the current split-pane layout with a single-page scrollable dashboard."
id: 266
uuid: 2813ecdf-6eff-4d1b-b9ac-9d8bd0f348c2
status: pending
priority: high
dependencies:
  - 265
parent: 264
references:
  "264": 80611f4c-32a4-4b3b-90c2-4e7e35cc519b
  "265": 428ed935-e91e-4d20-a4cb-46947ee8b2aa
createdAt: 2026-03-24T19:15:15.605Z
updatedAt: 2026-03-24T19:15:24.222Z
tasks: []
tags: []
---

## Details

### Needs Attention section
Items requiring a human decision, derived from current state:
- **Sessions waiting for input** — plans with an active prompt (from SSE session state)
- **Agent finished, needs review** — plans in `needs_review` or `in_progress` where the agent session recently disconnected
- **PR actionable** — PRs with checks passed + reviews approved (ready to merge), or PRs with changes requested
- **Blockers resolved** — plans marked `blocked` whose dependency plans are now all done

Each item: compact card with plan title, reason it needs attention, and 1-2 inline action buttons (respond to prompt, open PR, run agent).

### Running Now section
Currently active agent sessions:
- Plan title, workspace name, elapsed time, current step/task if available
- Compact rows, not full cards
- Click to navigate to session detail view

### Ready to Start section
Plans that are `ready` status, sorted by priority. Quick inline "Run Agent" button.

### Layout
Single-page scrollable view (no split pane). Sections stack vertically. Each section is collapsible with a count badge in the header. Empty sections show a subtle "nothing here" message and can auto-collapse.
