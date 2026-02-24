---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "tim-gui: show task tracking and workspaces"
goal: ""
id: 188
uuid: 2f287626-23b9-4d02-9e15-983f6ba6d5fd
status: pending
priority: medium
dependencies:
  - 184
references:
  "184": 05e31645-305d-4e59-8c49-a9fbc9ce0bd7
createdAt: 2026-02-13T21:10:34.013Z
updatedAt: 2026-02-24T09:06:30.629Z
tasks: []
tags: []
---

We want to add the ability for tim-gui to list tasks and workspaces for each project. We should have two views in the
application, the existing one for sessions and the new one to view projects and their workspaces and tasks. The tasks
view should by default show only tasks that are pending, in progress, blocked, or recently done.

All data should come from the tim.db SQLite database.
