---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: ability to generate artifacts alongside a plan
goal: ""
id: 275
uuid: 1b54394a-e12c-4f26-8a06-be5da8ab65a9
status: pending
priority: medium
createdAt: 2026-03-24T21:44:39.275Z
updatedAt: 2026-03-24T21:54:24.936Z
tasks: []
tags: []
---

A new CLI command that the agents can use to attach a file, such as an image, video, text file, etc. to a plan.
There should be an optional message to associate with the artifact as well.
These files should be tracked in the database and copied to a shared directory for `tim` file storage.

It should be possible to list all the artifacts for a given plan in the CLI, and also show them in the web UI.

Artifacts should be tracked as UUIDs, and when adding an artifact, the CLI should print out the UUID so that the agent
can reference it later in its responses.
