---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Option to use Claude Code for generate and prepare commands
goal: ""
id: 72
status: pending
priority: medium
createdAt: 2025-07-23T07:52:38.535Z
updatedAt: 2025-07-23T07:52:38.536Z
tasks: []
rmfilter:
- src/rmplan/commands/generate.ts
- src/rmplan/commands/prepare.ts
- src/rmplan/executors/claude_code.ts
- --with-imports
---

We should have a way to use Claude Code for the `generate` and `prepare` commands instead of calling an LLM directly.
Each of these should involve two invocations of Claude Code:

1. The planning section of the prompt
2. Then invoke it again with the same session, and ask it to generate the output in the requested format.

Look at the Claude Code executor for examples of how to invoke Claude Code and parse its output.
