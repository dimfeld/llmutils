---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "Web UI: Inline task editing"
goal: Allow inline editing of tasks in the plan detail view — toggling task
  completion status, editing task titles, and reordering tasks — without
  requiring CLI round-trips.
id: 271
uuid: 533e1cc6-8599-4060-a182-57176b90360b
status: pending
priority: medium
createdAt: 2026-03-24T19:18:04.424Z
updatedAt: 2026-03-24T19:18:04.425Z
tasks: []
tags:
  - web-ui
---

## Overview

Tasks in the plan detail view are currently read-only. Users should be able to toggle task completion, edit task titles, and add/remove tasks directly from the web UI.

## Key Features

- **Toggle task done/undone**: Checkbox click updates the plan file and syncs to DB.
- **Edit task title**: Click-to-edit on task title text.
- **Add task**: Button to append a new task with title and optional description.
- **Remove task**: Delete button on individual tasks with confirmation.
- **Reorder tasks**: Drag-and-drop or up/down buttons to reorder tasks within a plan.

## Implementation Notes

- Use `tim tools update-plan-tasks` or direct plan file manipulation on the server side
- Add remote functions for each operation: `toggleTask`, `updateTaskTitle`, `addTask`, `removeTask`, `reorderTasks`
- Optimistic UI updates — update the local state immediately and roll back on error
- The task list in `PlanDetail.svelte` needs to be refactored from a static list to an interactive component
