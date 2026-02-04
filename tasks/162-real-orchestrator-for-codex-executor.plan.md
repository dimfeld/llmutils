---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
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

Consider remaking the codex executor loop into a main orchestrator loop where each of the agents is actually an "tim subagent XXX" command that takes some arbitrary input from the orchestorator, adds that to the base subagent prompt for the task and plan, runs, and then prints its final message. We can use claude code or codex as the orchestrator, but probably claude code by default.

This will allow us to merge a lot of the claude and codex executor code into a single mode, and potentially provide
additional features like "use claude for frontend, codex for backend."

Use environment variables to supply the necessary context.

Implement a way (named pipes?) for the processes to write to the root tim process's stdout and stderr without filling up claudes context window.
