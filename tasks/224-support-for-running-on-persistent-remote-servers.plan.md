---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Support for running on persistent remote servers
goal: ""
id: 224
uuid: 974f3250-8861-43d9-98da-2fbb4cbf8664
status: pending
priority: medium
dependencies:
  - 222
  - 223
parent: 221
references:
  "221": 8d41284b-b510-4713-bd21-2db13687f2e5
  "222": 80e8e677-777a-4917-9d42-984dfca6d8f3
  "223": 9414fc10-17e6-44de-b2bb-ba6feb2acf62
createdAt: 2026-03-07T07:53:53.768Z
updatedAt: 2026-03-07T08:53:04.414Z
tasks: []
tags: []
---

This is a way for Tim, CLI, and GUI to connect to persistent remote servers that may be hosting multiple other TIM
processes. 

The hosts to connect to should be configured in the database and/or the global and project configuration files.

We should do this by having a long-running manager process that runs on the remote server. This process should be able
to:
- Be directed to run any relevant tim command (workspace, generate, agent, review, etc.)
- Scan the well-known directory with session info for running processes
- List active sessions
- Connect to any active sessions when directed, and proxy commands to and from them. This will require adding some

concept of a session id to the protocol so we can multiplex multiple sessions on a single websocket connection. The PID
info file already will have a session id, so we should use that.

Workspace push at the end must go through `origin` remote since we won't be able to just push locally between directories.
