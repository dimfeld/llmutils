---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Support for running on ephemeral remote servers
goal: ""
id: 225
uuid: f8a4ee11-c59e-451f-bf40-651524b0709d
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
createdAt: 2026-03-07T08:02:15.156Z
updatedAt: 2026-03-07T08:53:09.757Z
tasks: []
tags: []
---

An ephemeral server is one that is created as needed and destroyed/hibernated when done. We only ever run one tim
instance per ephemeral server. When running on an ephemeral server we can run in the mode that allows everything.

Using an ephemeral server requires some setup work to
- install auth tokens and authenticate to Github
- install relevant system packages (should be a script in the repository that the project config can reference)

We should have an adapter system for working with ephemeral server providers. https://sprites.dev/ should be the first
one we support.

The SQLite database should store information on ephemeral remote sessions and servers.

Workspace push at the end must go through `origin` remote since we won't be able to just push locally between directories.
