---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Ability to proxy plan updates to the main server they can update the
  local SQLite
goal: ""
id: 220
uuid: d5e0238b-243e-4edf-9307-330d5258da04
status: pending
priority: medium
dependencies:
  - 232
parent: 221
references:
  "221": 8d41284b-b510-4713-bd21-2db13687f2e5
  "232": d8a6e9a4-4754-4f1a-9065-0eeb7a5db0b7
createdAt: 2026-03-07T07:44:16.652Z
updatedAt: 2026-03-17T09:14:40.011Z
tasks: []
tags:
  - remote
---

Come up with a simple protocol for communicating the various types of updates that write the database,
corresponding to plan updates, workspace updates, etc.

If the websocket client or server is connected, then send it through that. Otherwise, look if there is a configured
server to connect to, connect to it, and send the protocol message.

In the future we will want to have some kind of ops log and so we can just sync ops between servers.
