---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: tim-gui connects to websocket server of tim processes
goal: ""
id: 223
uuid: 9414fc10-17e6-44de-b2bb-ba6feb2acf62
status: pending
priority: medium
dependencies:
  - 222
parent: 221
references:
  "221": 8d41284b-b510-4713-bd21-2db13687f2e5
  "222": 80e8e677-777a-4917-9d42-984dfca6d8f3
createdAt: 2026-03-07T07:52:33.763Z
updatedAt: 2026-03-07T07:52:33.770Z
tasks: []
tags: []
---

Replace tim-gui's websocket server with a client instead. It should scan the well-known directory defined in plan 222 for tim processes and connect to them. From there the data protocol is the same.
