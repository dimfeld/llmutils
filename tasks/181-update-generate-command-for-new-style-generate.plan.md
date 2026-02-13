---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: update generate command for new-style generate
goal: ""
id: 181
uuid: 33bdf7a9-7a21-4d7b-8dab-eac0aef0f6f0
status: pending
priority: medium
dependencies:
  - 178
  - 182
references:
  "178": 8970382a-14d8-40e2-9fda-206b952d2591
  "182": 3117183c-8d14-46bd-b4bd-2c4865522c32
createdAt: 2026-02-13T06:48:51.912Z
updatedAt: 2026-02-13T06:48:51.912Z
tasks: []
tags: []
---

We want to update the `tim generate` command to run the new generate prompt that works interactively. Once we have support for the
AskUserQuestion tool and input we can properly support this.
