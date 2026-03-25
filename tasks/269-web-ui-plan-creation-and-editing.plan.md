---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "Web UI: Plan creation and editing"
goal: Add the ability to create new plans and edit existing plan metadata
  (title, goal, priority, status, dependencies, tags) directly from the web UI,
  reducing reliance on the CLI for basic plan management.
id: 269
uuid: 71d04676-37a9-4b52-828e-82f4abdca949
status: pending
priority: medium
createdAt: 2026-03-24T19:18:03.551Z
updatedAt: 2026-03-24T19:18:03.552Z
tasks: []
tags:
  - web-ui
---

## Overview

Currently plans can only be created and edited via the CLI (`tim add`, `tim set`). The web UI should support basic plan CRUD operations so users can manage plans without switching to a terminal.

## Key Features

- **Create plan form**: Title, goal, priority, tags, parent, dependencies. Calls the existing `tim add` logic server-side.
- **Edit plan metadata**: Inline editing of title, goal, priority, status, tags, and dependencies on the plan detail page. Use the existing plan file write utilities on the server side.
- **Validation**: Reuse the zod plan schema for client-side validation before submission.
- **Dependency picker**: Searchable dropdown for selecting dependency plans by number/title.

## Implementation Notes

- Add server actions (remote functions) for create and update operations
- Reuse `writePlanFile()` and `syncPlanToDb()` from the tim codebase via the `$tim` alias
- The edit UI should be modal or inline-toggle to avoid cluttering the read view
- Consider optimistic updates with rollback on server error
