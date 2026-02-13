---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: plan delete command
goal: ""
id: 185
uuid: 563d1d97-930a-4351-ade5-cba0be274a20
status: pending
priority: medium
dependencies:
  - 184
references:
  "184": 05e31645-305d-4e59-8c49-a9fbc9ce0bd7
createdAt: 2026-02-13T08:39:40.395Z
updatedAt: 2026-02-13T08:40:27.105Z
tasks: []
tags: []
---

Currently we just delete not-needed plans manually, but with a command we can make sure that the SQLite database is kept up to date by removing it there as well.
