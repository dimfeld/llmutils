---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Option to use Claude Code for generate and prepare commands - Implement
  Claude Code Option for the `generate` Command
goal: To implement the core logic for the two-step Claude Code invocation and
  integrate it into the `generate` command, activated by a new `--claude` flag.
id: 73
status: in_progress
priority: high
dependencies: []
parent: 72
planGeneratedAt: 2025-07-23T07:56:27.245Z
promptsGeneratedAt: 2025-07-23T08:27:01.067Z
createdAt: 2025-07-23T07:52:38.535Z
updatedAt: 2025-07-23T08:33:49.574Z
tasks:
  - title: Create a Claude Code Orchestration Service
    description: Create a new service that orchestrates the two-step interaction
      with the existing Claude Code executor. This service will manage the
      session and handle sending the initial planning prompt, followed by the
      final generation prompt.
    files:
      - src/rmplan/executors/claude_code_orchestrator.ts
      - src/rmplan/executors/claude_code_orchestrator.test.ts
    steps:
      - prompt: >
          Create the service file
          `src/rmplan/executors/claude_code_orchestrator.ts`.

          Define an exported async function `runClaudeCodeGeneration` that
          accepts a configuration object containing a planning prompt, a
          generation prompt, and the standard `ClaudeCodeExecutorOptions`.
        done: true
      - prompt: >
          In `runClaudeCodeGeneration`, instantiate the `ClaudeCodeExecutor`
          with its required options.

          First, call the executor's `execute` method with the planning prompt.
          This call primes the Claude Code session with the context and allows
          it to perform initial analysis.

          Save the session ID received here.
        done: true
      - prompt: >
          Immediately following the first call, invoke the `execute` method on
          the same executor instance again, this time with the generation
          prompt. Pass the ['-r', sessionId] arguments in addition to the
          regular arguments to enable resuming the session.

          The result of this second call, which contains the final generated
          plan, should be returned by the `runClaudeCodeGeneration` function.
        done: true
  - title: Add a `--claude` Flag to the `generate` Command
    description: Modify the command-line interface definition to add a new boolean
      `--claude` flag to the `generate` command.
    files:
      - src/rmplan/commands/generate.ts
    steps:
      - prompt: >
          In the main CLI definition file where the `rmplan generate` command is
          configured (this file is not in the provided context, but you have
          access to it), add a new boolean option `--claude`. This flag will not
          have a default value.

          Then, in `src/rmplan/commands/generate.ts`, update the
          `handleGenerateCommand` function signature to receive the new `claude`
          property within its `options` object.
        done: false
  - title: Integrate the Orchestration Service into the `generate` Command
    description: Update the `generate` command's handler to use the new Claude Code
      orchestration service when the `--claude` flag is provided. The existing
      direct LLM call should remain the default behavior.
    files:
      - src/rmplan/commands/generate.ts
    steps:
      - prompt: >
          In `src/rmplan/commands/generate.ts`, import the
          `runClaudeCodeGeneration` function from the new orchestration service.
        done: false
      - prompt: >
          Within the `handleGenerateCommand` function, add a conditional block
          that checks if `options.claude` is true.

          If it is, the logic should proceed to call the
          `runClaudeCodeGeneration` orchestrator. The existing logic for direct
          LLM calls and clipboard-based interaction should be moved into the
          `else` part of this conditional.
        done: false
      - prompt: >
          Inside the `if (options.claude)` block, you will eventually call the
          orchestrator. For now, you can add a log statement or a placeholder
          call, as the prompt generation logic will be adapted in the next task.
          The key is to establish the new control flow based on the flag.
        done: false
  - title: Adapt the `generate` Prompt for Two-Step Invocation
    description: "Refactor the prompt construction for the `generate` command to
      split it into two parts: a planning section and a final output generation
      instruction. These will be consumed by the new orchestration service."
    files:
      - src/rmplan/prompt.ts
      - src/rmplan/commands/generate.ts
    steps:
      - prompt: >
          In `src/rmplan/prompt.ts`, create and export a new function named
          `generateClaudeCodePlanningPrompt`. This function will take the plan
          text as input and produce a detailed prompt instructing Claude Code to
          analyze the codebase using its tools and prepare a plan, but to wait
          for a final command before generating the output.
        done: false
      - prompt: >
          In `src/rmplan/prompt.ts`, create and export a second, simpler
          function named `generateClaudeCodeGenerationPrompt`. This function
          will return a concise prompt that instructs Claude to output the final
          plan in the required YAML format based on its preceding analysis.
        done: false
      - prompt: >
          In `src/rmplan/commands/generate.ts`, inside the `if (options.claude)`
          block, call the two new prompt generation functions to create the
          planning and generation prompts.
        done: false
      - prompt: >
          Pass the two generated prompts to the `runClaudeCodeGeneration`
          orchestrator function. The result of this call will be the final YAML
          output from Claude, which should then be passed to the
          `extractMarkdownToYaml` function for processing, similar to how the
          direct LLM path works.
        done: false
  - title: Add Integration Tests for the `generate` Command's Claude Path
    description: Create new integration tests that specifically target the
      `generate` command with the `--claude` flag. These tests should verify
      that the command successfully completes and produces the expected output
      format when using the Claude Code execution path.
    files:
      - src/rmplan/commands/generate.test.ts
    steps:
      - prompt: >
          In `src/rmplan/commands/generate.test.ts`, create a new `describe`
          block for testing the `generate` command with the `--claude` flag.
        done: false
      - prompt: >
          Write a test case that calls `handleGenerateCommand` with the
          `--claude` option and a path to a mock plan file.

          Mock the `runClaudeCodeGeneration` orchestrator module. Verify that it
          is called once and that its arguments include two distinct prompts:
          one for planning and one for generation. Use `expect.stringContaining`
          to check for key phrases in each prompt.
        done: false
      - prompt: >
          Write a second test where you mock the `runClaudeCodeGeneration`
          orchestrator to return a complete, valid YAML plan as a string.

          Verify that the `extractMarkdownToYaml` function is subsequently
          called with this YAML string, confirming that the output from the
          Claude path is correctly piped to the final processing step.
        done: false
changedFiles:
  - src/rmplan/executors/claude_code_orchestrator.ts
  - src/rmplan/prompt.ts
rmfilter:
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/prepare.ts
  - src/rmplan/executors/claude_code.ts
  - --with-imports
---

This phase focuses on building the foundation of the new feature. We will create a new, reusable service that encapsulates the two-step Claude Code interaction. This service will be integrated into the `generate` command, which will be updated to include a `--claude` flag. The command's logic will be modified to conditionally call either the existing LLM service or the new Claude Code service based on the presence of this flag. We will also adapt the `generate` command's prompt to fit the new planning-then-generation flow and add comprehensive tests.
