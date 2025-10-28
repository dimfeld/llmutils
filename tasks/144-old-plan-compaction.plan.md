---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Old plan compaction
goal: ""
id: 144
uuid: fa3280d0-1624-4c73-9471-590f641765f5
status: pending
priority: low
temp: false
createdAt: 2025-10-27T19:26:47.021Z
updatedAt: 2025-10-28T23:22:59.148Z
tasks: []
---

We should have a way to compact old plans so they take up less space.

The command should use the claude (or optionally codex) executors to strip the plan free text down. The idea is that someone can look at the plan now that it has been finished and see what was done and why, but they don't need all the research that originally went into the plan.
