---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: agent passthrough mode
goal: ""
id: 198
uuid: c57b1832-2630-4c52-b61f-77aa17361eec
status: pending
priority: medium
createdAt: 2026-02-15T09:31:14.223Z
updatedAt: 2026-02-15T09:31:14.223Z
tasks: []
tags: []
---

This is a tim command that just executes Claude or Codex and lets the user type. Similar to the generate command, we want the terminal to stay open even after the first result. Codex doesn't support terminal input yet, but it will in the future. 

The main purpose of this is not actually to be used on the terminal, but for integration with Tim-GUI in a later phase.
