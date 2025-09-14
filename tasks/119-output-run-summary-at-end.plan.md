---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: output run summary at end
goal: ""
id: 119
status: pending
priority: medium
createdAt: 2025-09-14T07:54:56.352Z
updatedAt: 2025-09-14T07:54:56.352Z
tasks: []
---

Add ability for rmplan run to give a summary of what happened from the executor. This should involve capturing the important output from every step and returning it. Loop then aggregates it and prints at the end

For Claude: this should just be the final messages from the orchestrator in each run.
For Codex: this should be the final output from every call that runs codex, combined together and labelled appropriately.

Other executors won't have access to relevant information, so don't need to return anything.
