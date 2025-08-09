---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Allow agent to perform multiple tasks in a phase at once
goal: ""
id: 98
status: pending
priority: medium
createdAt: 2025-08-09T02:59:32.264Z
updatedAt: 2025-08-09T02:59:32.264Z
tasks: []
rmfilter:
    - src/rmplan/commands/agent.ts
    - src/rmplan/executors
---

Add a new mode to the agent command that gived the agent the plan file and all the not-done tasks, and tell it to choose some subset of those
tasks that makes sense to do in a batch together for a single unit of work. Then the orchestrator agent should edit the plan file to set `done: true` mark those tasks as done once
complete and then exit. 

Then the rmplan agent loop will reread the plan file, and go again if there are still tasks to be done in the plan file.

Put this mode under a new CLI option for now.

For this work we will need to give the orchestrator agent access to the `Update` tool and also update its instructions,
as well as passing all the not-done tasks to it and to the subagent prompts.
