---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Support custom docs for implementer, tester, and reviewer agents
goal: ""
id: 98
status: pending
priority: medium
createdAt: 2025-08-13T19:06:31.948Z
updatedAt: 2025-08-13T19:06:31.948Z
tasks: []
rmfilter:
- src/rmplan/configSchema.ts
- src/rmplan/executors/claude_code.ts
- src/rmplan/executors/claude_code/
- src/rmplan/commands/agent
---

We support a `planning.instructions` document in the configSchema right now, which provides extra instructions when running planning.

We should add similar support for the `implementer`, `tester`, and `reviewer` agents.

Place these under a structure like this:

```
{
  "agents": {
    "implementer": {
      "instructions": "..."
    },
    "tester": {
      "instructions": "..."
    },
    "reviewer": {
      "instructions": "..."
    }
  }
}
```

All of these should be optional. If any are provided, then when creating the prompt for an agent, the custom
instructions should be included seamlessly.
