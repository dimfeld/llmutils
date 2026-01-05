---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: real orchestrator for codex executor
goal: ""
id: 162
uuid: f98cd40a-4a6f-48f4-9320-540e03f80725
status: pending
priority: medium
createdAt: 2026-01-05T06:20:05.558Z
updatedAt: 2026-01-05T06:20:05.559Z
tasks: []
tags: []
---

Consider remaking the codex executor loop into a main orchestrator loop where each of the agents is actually an "rmplan subagent XXX" command that runs and then prints its final message. We can use claude code or codex as the orchestrator.

Use environment variables to supply the necessary context.

Implement a way (named pipes?) for the processes to write to the root rmplan process's stdout and stderr without filling up claudes context window.
