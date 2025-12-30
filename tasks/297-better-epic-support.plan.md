---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: better epic support
goal: ""
id: 297
uuid: db330154-2628-4559-8f5f-bcaa4358505b
simple: false
status: in_progress
priority: medium
createdAt: 2025-12-29T01:23:04.821Z
updatedAt: 2025-12-30T08:13:11.253Z
tasks: []
tags: []
---

- Rename "container" to "epic". In the data model, add both for backwards compatibility but...
  - when writing a plan always use "epic: true" instead of container: true and in `writePlanFile` explicitly remove container and add epic.
  - when reading a plan, set epic = true if container = true
  - see if some of this can be automated using Zod, by adding a preprocess function that looks for container: true and sets epic: true
- Make it easier to show the epic a task even if it's an indirect parent
- Add a filter to the list and ready commands that lists based on the epic of a task (although this can really take any parent plan)
