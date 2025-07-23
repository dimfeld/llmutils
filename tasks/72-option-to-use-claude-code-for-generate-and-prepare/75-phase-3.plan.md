---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Option to use Claude Code for generate and prepare commands - Refinement
  and Documentation
goal: To refactor any duplicated code, enhance robustness, and document the new
  feature for end-users.
id: 75
status: in_progress
priority: medium
dependencies:
  - 73
  - 74
parent: 72
planGeneratedAt: 2025-07-23T07:56:27.245Z
promptsGeneratedAt: 2025-07-23T23:24:55.730Z
createdAt: 2025-07-23T07:52:38.535Z
updatedAt: 2025-07-23T23:29:06.269Z
tasks:
  - title: Refactor Common Command Logic
    description: Review the `generate` and `prepare` command handlers for any
      duplicated code related to flag checking or service invocation, and
      extract it into a shared helper function or class to improve
      maintainability.
    files:
      - src/rmplan/claude_utils.ts
      - src/rmplan/claude_utils.test.ts
      - src/rmplan/commands/generate.ts
      - src/rmplan/commands/generate.test.ts
      - src/rmplan/plans/prepare_phase.ts
      - src/rmplan/plans/prepare_phase.test.ts
    steps:
      - prompt: >
          Create a new file `src/rmplan/claude_utils.ts` to house shared logic
          for invoking the Claude Code generation process. Inside this file,
          define and export a new asynchronous function
          `invokeClaudeCodeForGeneration`. This function should accept the
          planning prompt, generation prompt, and an options object (containing
          the model string and any other necessary configuration) as arguments.
          It will be responsible for logging the "Using Claude Code..." message
          and calling the `runClaudeCodeGeneration` orchestrator.
        done: true
      - prompt: >
          Create a new test file `src/rmplan/claude_utils.test.ts`. Write a unit
          test for the `invokeClaudeCodeForGeneration` function. Use the
          `ModuleMocker` to mock the `runClaudeCodeGeneration` function and
          verify that it is called with the correct arguments when
          `invokeClaudeCodeForGeneration` is executed.
        done: true
      - prompt: >
          Refactor the `handleGenerateCommand` function in
          `src/rmplan/commands/generate.ts`. Import the new
          `invokeClaudeCodeForGeneration` function and use it within the `if
          (options.claude)` block to replace the duplicated logic for calling
          the Claude Code orchestrator.
        done: true
      - prompt: >
          Update the corresponding test in
          `src/rmplan/commands/generate.test.ts`. Modify the test that covers
          the `--claude` flag to mock the new `invokeClaudeCodeForGeneration`
          helper function instead of the underlying `runClaudeCodeGeneration`
          orchestrator.
        done: true
      - prompt: >
          Refactor the `preparePhase` function in
          `src/rmplan/plans/prepare_phase.ts`. Import
          `invokeClaudeCodeForGeneration` and replace the `else if
          (options.claude)` block with a call to the new shared helper function,
          ensuring the correct prompts and options are passed.
        done: true
      - prompt: >
          Update the test for the `claude: true` option in
          `src/rmplan/plans/prepare_phase.test.ts`. Adjust the mock to target
          the new `invokeClaudeCodeForGeneration` function, aligning the test
          with the refactored implementation.
        done: true
  - title: Update README.md with Feature Documentation
    description: Update the main `README.md` file to document the new `--claude`
      flag. The documentation should explain its purpose, how to use it with
      both `generate` and `prepare` commands, and the benefits of using the
      Claude Code model.
    files:
      - README.md
    steps:
      - prompt: >
          Update the root `README.md` file to document the new `--claude`
          feature. Add a new section titled "### Using with Claude Code" that
          explains the purpose of the flag for both the `generate` and `prepare`
          commands. Describe the benefits of its two-step analysis and
          generation process, and provide clear command-line examples for both
          use cases. Also, mention that this feature requires the `claude-code`
          CLI tool to be installed and available in the system's PATH.
        done: false
changedFiles:
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
