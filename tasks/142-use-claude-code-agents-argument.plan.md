---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: use claude code agents argument
goal: ""
id: 142
uuid: 61388442-34e9-4a0a-bf88-86760f277267
status: pending
priority: medium
temp: false
createdAt: 2025-10-27T07:27:25.422Z
updatedAt: 2025-10-27T08:39:04.259Z
tasks: []
---

Update custom sub agents in Claude code executor to use the agents option instead.

It will look something like this but adapted to the agents the executor actually uses. 

claude --agents '{
  "code-reviewer": {
    "description": "Expert code reviewer. Use proactively after code changes.",
    "prompt": "You are a senior code reviewer. Focus on code quality, security, and best practices.",
    "tools": ["Read", "Grep", "Glob", "Bash"],
    "model": "sonnet"
  },
  "debugger": {
    "description": "Debugging specialist for errors and test failures.",
    "prompt": "You are an expert debugger. Analyze errors, identify root causes, and provide fixes."
  }
}'
