---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Option to use Claude Code for generate and prepare commands - Refinement
  and Documentation
goal: To refactor any duplicated code, enhance robustness, and document the new
  feature for end-users.
id: 75
uuid: 4cf7c6ea-f240-4d13-8a54-f8fbdf15f86c
status: done
priority: medium
dependencies:
  - 73
  - 74
parent: 72
planGeneratedAt: 2025-07-23T07:56:27.245Z
promptsGeneratedAt: 2025-07-23T23:24:55.730Z
createdAt: 2025-07-23T07:52:38.535Z
updatedAt: 2025-10-27T08:39:04.253Z
tasks:
  - title: Refactor Common Command Logic
    done: true
    description: Review the `generate` and `prepare` command handlers for any
      duplicated code related to flag checking or service invocation, and
      extract it into a shared helper function or class to improve
      maintainability.
  - title: Update README.md with Feature Documentation
    done: true
    description: Update the main `README.md` file to document the new `--claude`
      flag. The documentation should explain its purpose, how to use it with
      both `generate` and `prepare` commands, and the benefits of using the
      Claude Code model.
changedFiles:
  - README.md
  - src/rmplan/claude_utils.test.ts
  - src/rmplan/claude_utils.ts
  - src/rmplan/commands/generate.test.ts
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/prepare.ts
  - src/rmplan/display_utils.ts
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

With the core functionality implemented for both commands, this final phase focuses on quality and usability. We will review the implementations for any potential refactoring opportunities to improve code maintainability. Finally, we will update the project's `README.md` to provide clear documentation on how to use the new `--claude` feature.
