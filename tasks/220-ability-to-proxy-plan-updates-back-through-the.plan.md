---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Ability to proxy plan updates to the main server they can update the
  local SQLite
goal: ""
id: 220
uuid: d5e0238b-243e-4edf-9307-330d5258da04
status: pending
priority: medium
parent: 221
references:
  "221": 8d41284b-b510-4713-bd21-2db13687f2e5
createdAt: 2026-03-07T07:44:16.652Z
updatedAt: 2026-03-09T18:48:27.394Z
tasks: []
tags:
  - remote
---

Come up with a simple protocol for communicating the various types of updates that write the database,
corresponding to plan updates, workspace updates, etc.

If the websocket client or server is connected, then send it through that. Otherwise, look if there is a configured
server to connect to, connect to it, and send the protocol message.
