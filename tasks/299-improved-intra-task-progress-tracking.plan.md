---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: improved intra-task progress tracking
goal: ""
id: 299
uuid: ed37390d-a63a-4b0c-a7b8-c656e276f62d
simple: false
status: pending
priority: medium
createdAt: 2025-12-29T01:29:59.680Z
updatedAt: 2025-12-29T01:29:59.680Z
tasks: []
tags: []
---

- add more instructions in the skill and prompt around adding new issues for things it found 
- Tell orchestrator that when finished it should update the plan file progress section with notes about what it did, adding or updating existing text to match the current state of the plan. 
- Do similar in codex, but just for each prompt.
- Note that these messages don't have to be abut the testing or review, it just has to explain what progress has been
made on the task, and how and why.
- Remove the dedicated progressNotes section from the plan data model, and remove the CLI command and references to it in prompts
