---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: track tim tasks in sqlite as well as git json files
goal: "Have plan data from all active workspaces in a single place"
id: 184
uuid: 05e31645-305d-4e59-8c49-a9fbc9ce0bd7
status: pending
priority: medium
dependencies:
  - 158
references:
  "158": e17331a4-1827-49ea-88e6-82de91f993df
createdAt: 2026-02-13T08:35:46.190Z
updatedAt: 2026-02-13T08:35:46.190Z
tasks: []
tags: []
---

Whenever we update a tim task, also update the shared sqlite database. For now we don't need to store the plan details
since those can be edited freely by the agents, but any time we call writePlanFile we should also update the sqlite
database.

This will require adding new tables to represent plans and their tasks. Plans should be tracked internally by their
`uuid` field for foreign keys and such, with the numeric "id" used only for finding plans from user input and such.

As part of this we should also have a new maintenance command that will sync all the JSON plan data into the sqlite
database, and optionally delete plans from SQLite that no longer exist in the JSON.
