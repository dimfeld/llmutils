---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Option to use Claude Code for generate and prepare commands - Implement
  Claude Code Option for the `prepare` Command
goal: To extend the Claude Code functionality to the `prepare` command, reusing
  the orchestration service built in Phase 1.
id: 74
uuid: 5c9e77eb-4206-4493-952b-cf5a7c7f6792
status: done
priority: high
dependencies:
  - 73
parent: 72
references:
  "72": 5a0d6a82-e30d-43c0-a1f8-6237818f7bf8
  "73": 2044f990-4d7e-43eb-b03c-d11bfca99d13
planGeneratedAt: 2025-07-23T07:56:27.245Z
promptsGeneratedAt: 2025-07-23T20:53:16.796Z
createdAt: 2025-07-23T07:52:38.535Z
updatedAt: 2025-10-27T08:39:04.263Z
tasks:
  - title: Add a `--claude` Flag to the `prepare` Command
    done: true
    description: Modify the command-line interface definition in
      `src/rmplan/rmplan.ts` to add the new boolean `--claude` flag to the
      `prepare` command. This will allow users to opt into the two-step Claude
      Code generation flow.
  - title: Integrate the Orchestration Service into the `prepare` Command
    done: true
    description: Update the `prepare` command's handler and the underlying
      `preparePhase` function to use the Claude Code orchestration service when
      the `--claude` flag is provided. This involves passing the flag down and
      adding the conditional logic to call the orchestrator.
  - title: Adapt the `prepare` Prompt for Two-Step Invocation
    done: true
    description: Refactor the prompt construction for the `prepare` command to split
      it into a planning section and a final output generation instruction,
      compatible with the orchestration service. This involves creating new
      prompt generation functions and integrating them into the `preparePhase`
      logic.
  - title: Add Integration Tests for the `prepare` Command's Claude Path
    done: true
    description: Create new integration tests for the `prepare` command with the
      `--claude` flag to verify its correct functionality and output. This will
      involve testing the `preparePhase` function directly.
changedFiles:
  - src/rmplan/commands/generate.test.ts
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/prepare.ts
  - src/rmplan/executors/claude_code_orchestrator.ts
  - src/rmplan/plans/prepare_phase.test.ts
  - src/rmplan/plans/prepare_phase.ts
  - src/rmplan/prompt.ts
  - src/rmplan/{prompt.ts => prompt.ts.bak}
  - src/rmplan/rmplan.ts
rmfilter:
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/prepare.ts
  - src/rmplan/executors/claude_code.ts
  - --with-imports
---

Building on the foundation from Phase 1, this phase will enable the same Claude Code functionality for the `prepare` command. We will add the `--claude` flag, adapt the command's logic to use the existing orchestration service, and split its prompt into planning and generation steps. This will ensure consistent behavior and implementation across both commands.
