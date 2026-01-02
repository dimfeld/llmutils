---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: full auto mode
goal: ""
id: 154
uuid: a64f399e-a0fe-48bd-ace5-73f478038bfe
status: pending
priority: medium
createdAt: 2026-01-02T01:01:50.359Z
updatedAt: 2026-01-02T01:01:50.360Z
tasks: []
tags: []
---

Automated mode that does:
- new workspace
- "Generate" without the question part of the prompt so that it one-shots
- Check if tasks are filled in. If not run another prompt specifically just to add the tasks
- Run the plan
- Run review command and autofix until ACCEPTABLE or up to 5 times.
- Push branch and create draft PR
