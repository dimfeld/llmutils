---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: replace MCP tools with CLI commands
goal: ""
id: 295
uuid: fea18633-aa57-4072-bb94-dae8ee0654dd
simple: false
status: pending
priority: medium
container: false
temp: false
dependencies: []
references: {}
issue: []
pullRequest: []
docs: []
createdAt: 2025-12-29T01:16:02.088Z
updatedAt: 2025-12-29T01:16:02.089Z
progressNotes: []
tasks: []
tags: []
---

We want to make it possible to run without the MCP tools. To do this:
- For each tool, create a CLI command that does the same thing as the tool, or update a existing CLI command with new
capabilities.
- Add a CLI option to the MCP command that runs it without tools, only prompts.
- Update the relevant documentation in claude-plugin/skills to reflect the new CLI commands and no longer reference MCP
tools.
