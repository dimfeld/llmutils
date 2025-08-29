---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Renumber should account for parent/child relationships when only parent
  is being renumbered
goal: To update the `renumber` command to correctly order plan IDs based on
  parent-child hierarchies and sibling dependencies.
id: 113
status: pending
priority: medium
dependencies: []
planGeneratedAt: 2025-08-29T03:04:35.841Z
promptsGeneratedAt: 2025-08-29T03:08:33.186Z
createdAt: 2025-08-19T19:45:01.416Z
updatedAt: 2025-08-29T03:08:33.187Z
tasks: []
rmfilter:
  - src/rmplan/commands/renumber.ts
  - --with-imports
---


If we have a case where the parent plan conflicts but not all the children, the parent plan will end up with an ID
higher than the children. Ideally, we should detect this and renumber the parent's children as well to make sure that
the parent retains a smaller ID than its children. 

Overall, we want:
- A parent has a lower plan ID than any of its children
- The children plan IDs are sorted in dependency order
- Plan IDs are reused (e.g. if plans 52, 53, 55, and 57 form a group of parent and children, the resulting plans have those IDs as well, just in a different arrangement)

The renumber command should check for this in a separate phase after its current conflict resolution phase. This ensures
that we're starting with a clean state and can focus solely on this task without worrying about conflicts.

