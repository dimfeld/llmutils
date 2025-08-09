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
---

This mode should give the agent the plan file and all the not-done tasks, and tell it to choose some subset of those
tasks that makes sense to do in a batch together for a single unit of work. Then the orchestrator agent should edit the plan file to set `done: true` mark those tasks as done once
complete and then exit. 

Then the rmplan agent loop will reread the plan file, and go again if there are still tasks to be done in the plan file.

