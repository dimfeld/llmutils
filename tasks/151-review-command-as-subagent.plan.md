---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: review command as subagent
goal: ""
id: 151
uuid: 8a417b70-b63c-4a55-9d34-ee64aa04fead
simple: false
status: pending
priority: medium
createdAt: 2025-12-29T01:27:15.778Z
updatedAt: 2025-12-29T01:27:15.779Z
tasks: []
tags: []
---

- Update review prompt so that functionality that is implemented but does not meet requirements is a critical issue. 
- Use the word "ultrathink" in review mode prompt
- Add a --print or -p argument to "rmplan review" for running noninteractively that will return all the data without the prompts 
- Update review command with options for reviewing just certain tasks in the plan, and also options for running parallel reviews with both codex and Claude executors, in parallel, and combining results. 
- Add configuration option for which executor to use for review by default: claude, codex, both.
- In Claude code orchestrator, replace review subagent with directions to run rmplan review for Claude orchestrator
