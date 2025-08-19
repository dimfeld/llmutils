---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Renumber should account for parent/child relationships when only parent
  is being renumbered
goal: ""
id: 113
status: pending
priority: low
createdAt: 2025-08-19T19:45:01.416Z
updatedAt: 2025-08-19T19:45:01.416Z
tasks: []
---

If we have a case where the parent plan conflicts but not all the children, the parent plan will end up with an ID
higher than the children. Ideally, we should detect this and renumber the parent's children as well to make sure that
the parent retains a smaller ID than its children.
