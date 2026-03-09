---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Ability to run "main" tim server on a separate host
goal: ""
id: 226
uuid: 38a8e157-c4c8-403a-b706-778dad59f6e1
status: pending
priority: medium
dependencies:
  - 220
parent: 221
references:
  "220": d5e0238b-243e-4edf-9307-330d5258da04
  "221": 8d41284b-b510-4713-bd21-2db13687f2e5
createdAt: 2026-03-09T18:28:15.831Z
updatedAt: 2026-03-09T19:26:27.096Z
tasks: []
tags:
  - remote
dependsOn:
  - 220
---

Maybe ability to set up the main Tim server on a remote host and have the clients all connect to that. Not too different from what I have been thinking, just the laptop is no longer the primary machine, and when a tim process does anything it proxies changes back to the main server.

We should also have the ability to queue up protocol messages to send when offline. The server should process these
using last-write-wins logic. We should opportunistically try to send the message list when running tim if there are any
enqueued.

The main server should not only update the database, but should save the commands as well so interactive clients can
sync down the latest commands and apply them locally.

We'll also want a command that can be run to sync down the entire database file.
