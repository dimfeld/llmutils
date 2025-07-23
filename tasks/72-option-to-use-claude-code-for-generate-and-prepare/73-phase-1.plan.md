---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Option to use Claude Code for generate and prepare commands - Implement
  Claude Code Option for the `generate` Command
goal: To implement the core logic for the two-step Claude Code invocation and
  integrate it into the `generate` command, activated by a new `--claude` flag.
id: 73
status: pending
priority: high
dependencies: []
parent: 72
planGeneratedAt: 2025-07-23T07:56:27.245Z
createdAt: 2025-07-23T07:52:38.535Z
updatedAt: 2025-07-23T07:56:27.245Z
tasks:
  - title: Create a Claude Code Orchestration Service
    description: Create a new service that orchestrates the two-step interaction
      with the existing Claude Code executor. This service will manage the
      session and handle sending the initial planning prompt, followed by the
      final generation prompt.
    steps: []
  - title: Add a `--claude` Flag to the `generate` Command
    description: Modify the command-line interface definition to add a new boolean
      `--claude` flag to the `generate` command.
    steps: []
  - title: Integrate the Orchestration Service into the `generate` Command
    description: Update the `generate` command's handler to use the new Claude Code
      orchestration service when the `--claude` flag is provided. The existing
      direct LLM call should remain the default behavior.
    steps: []
  - title: Adapt the `generate` Prompt for Two-Step Invocation
    description: "Refactor the prompt construction for the `generate` command to
      split it into two parts: a planning section and a final output generation
      instruction. These will be consumed by the new orchestration service."
    steps: []
  - title: Add Integration Tests for the `generate` Command's Claude Path
    description: Create new integration tests that specifically target the
      `generate` command with the `--claude` flag. These tests should verify
      that the command successfully completes and produces the expected output
      format when using the Claude Code execution path.
    steps: []
rmfilter:
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/prepare.ts
  - src/rmplan/executors/claude_code.ts
  - --with-imports
---

This phase focuses on building the foundation of the new feature. We will create a new, reusable service that encapsulates the two-step Claude Code interaction. This service will be integrated into the `generate` command, which will be updated to include a `--claude` flag. The command's logic will be modified to conditionally call either the existing LLM service or the new Claude Code service based on the presence of this flag. We will also adapt the `generate` command's prompt to fit the new planning-then-generation flow and add comprehensive tests.
