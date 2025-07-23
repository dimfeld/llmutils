---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Option to use Claude Code for generate and prepare commands - Implement
  Claude Code Option for the `prepare` Command
goal: To extend the Claude Code functionality to the `prepare` command, reusing
  the orchestration service built in Phase 1.
id: 74
status: pending
priority: high
dependencies:
  - 73
parent: 72
planGeneratedAt: 2025-07-23T07:56:27.245Z
createdAt: 2025-07-23T07:52:38.535Z
updatedAt: 2025-07-23T07:56:27.245Z
tasks:
  - title: Add a `--claude` Flag to the `prepare` Command
    description: Modify the command-line interface definition to add the new boolean
      `--claude` flag to the `prepare` command.
    steps: []
  - title: Integrate the Orchestration Service into the `prepare` Command
    description: Update the `prepare` command's handler to use the Claude Code
      orchestration service created in Phase 1 when the `--claude` flag is
      provided.
    steps: []
  - title: Adapt the `prepare` Prompt for Two-Step Invocation
    description: Refactor the prompt construction for the `prepare` command to split
      it into a planning section and a final output generation instruction,
      compatible with the orchestration service.
    steps: []
  - title: Add Integration Tests for the `prepare` Command's Claude Path
    description: Create new integration tests for the `prepare` command with the
      `--claude` flag to verify its correct functionality and output.
    steps: []
rmfilter:
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/prepare.ts
  - src/rmplan/executors/claude_code.ts
  - --with-imports
---

Building on the foundation from Phase 1, this phase will enable the same Claude Code functionality for the `prepare` command. We will add the `--claude` flag, adapt the command's logic to use the existing orchestration service, and split its prompt into planning and generation steps. This will ensure consistent behavior and implementation across both commands.
