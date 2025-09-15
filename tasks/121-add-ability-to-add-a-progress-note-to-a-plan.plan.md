---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: add ability to add a progress note to a plan
goal: ""
id: 121
status: pending
priority: medium
createdAt: 2025-09-15T03:02:03.721Z
updatedAt: 2025-09-15T03:02:03.721Z
tasks: []
---

Agents should be able to add progress notes to plans as they run, to describe what they have done so far and any
interesting notes.

- Add a new optional string array to the plan schema called progressNotes
- Add a new command `add-progress-note` to rmplan similar to `set-task-done` that can add a string to the progressNotes array for a plan
- Update the prompts to indicate that it should be used to add progress notes 
- When building the agent prompts, include the progress notes from the current plan in the prompt

Progress notes should be added when:
- Significant chunks of work are done
- Unexpected behavior occurs and the implementation deviates from the plan
- The agent discovers something Unexpected
