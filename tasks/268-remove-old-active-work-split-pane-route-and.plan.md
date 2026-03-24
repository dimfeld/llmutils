---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Remove old Active Work split-pane route and migrate to new dashboard
goal: "Remove the old Active Work split-pane route, workspace detail sub-route, and ActivePlanRow/WorkspaceRow components that are no longer needed. Ensure the new dashboard is the default view for the 'active' tab. Update any navigation links and redirects."
id: 268
uuid: 34c8c9b3-d82d-474c-b989-5d5389ff4214
status: pending
priority: medium
dependencies:
  - 266
  - 267
parent: 264
references:
  "264": 80611f4c-32a4-4b3b-90c2-4e7e35cc519b
  "266": 2813ecdf-6eff-4d1b-b9ac-9d8bd0f348c2
  "267": 7c25094d-02da-438c-847c-1426e31575b1
createdAt: 2026-03-24T19:15:17.733Z
updatedAt: 2026-03-24T19:15:29.075Z
tasks: []
tags: []
---

## Details

### Cleanup scope
- Remove `src/routes/projects/[projectId]/active/+layout.svelte` split-pane layout
- Remove `src/routes/projects/[projectId]/active/workspace/[workspaceId]/` sub-route
- Remove or repurpose `ActivePlanRow.svelte`, `WorkspaceRow.svelte` if no longer used
- Remove `getActiveWorkData()` from `plans_browser.ts` if fully replaced
- Update `TabNav` links if the route structure changes
- Update any redirects (home page, project persistence) that reference active work routes
- Ensure keyboard navigation still works in the new layout
- Update CLAUDE.md documentation to reflect the new route structure
