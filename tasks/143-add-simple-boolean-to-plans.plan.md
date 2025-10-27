---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add simple boolean to plans
goal: ""
id: 143
uuid: e98643af-3471-4efb-80e4-d2fe43d4bbef
status: pending
priority: high
temp: false
createdAt: 2025-10-27T19:14:44.287Z
updatedAt: 2025-10-27T19:14:44.287Z
tasks: []
---

The `simple` boolean on a plan should indicate if a plan is easy enough to be implemented without too much planning or
research.

When a plan is simple:
- the generate MCP prompt automatically runs the research-less version of the prompt instead

Implementation:
- Add the `simple` boolean to the plan schema. Default to false.
- Add the `simple` flag to the `rmplan add` command
- Update the generate MCP prompt as above
- the `generate` command acts as if `--simple` was passed to it
- the `run` command allows just running without creating tasks, and it acts as if `--simple` was passed to it
