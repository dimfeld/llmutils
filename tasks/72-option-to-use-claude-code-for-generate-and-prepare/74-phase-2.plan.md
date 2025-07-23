---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Option to use Claude Code for generate and prepare commands - Implement
  Claude Code Option for the `prepare` Command
goal: To extend the Claude Code functionality to the `prepare` command, reusing
  the orchestration service built in Phase 1.
id: 74
status: done
priority: high
dependencies:
  - 73
parent: 72
planGeneratedAt: 2025-07-23T07:56:27.245Z
promptsGeneratedAt: 2025-07-23T20:53:16.796Z
createdAt: 2025-07-23T07:52:38.535Z
updatedAt: 2025-07-23T21:11:35.573Z
tasks:
  - title: Add a `--claude` Flag to the `prepare` Command
    description: Modify the command-line interface definition in
      `src/rmplan/rmplan.ts` to add the new boolean `--claude` flag to the
      `prepare` command. This will allow users to opt into the two-step Claude
      Code generation flow.
    files:
      - src/rmplan/rmplan.ts
    steps:
      - prompt: >
          In `src/rmplan/rmplan.ts`, locate the definition for the `prepare`
          command. Add a new option `.option('--claude', 'Use Claude Code for
          two-step planning and generation')` to it. This should mirror the flag
          already present on the `generate` command.
        done: true
  - title: Integrate the Orchestration Service into the `prepare` Command
    description: Update the `prepare` command's handler and the underlying
      `preparePhase` function to use the Claude Code orchestration service when
      the `--claude` flag is provided. This involves passing the flag down and
      adding the conditional logic to call the orchestrator.
    files:
      - src/rmplan/commands/prepare.ts
      - src/rmplan/plans/prepare_phase.ts
    steps:
      - prompt: >
          In `src/rmplan/commands/prepare.ts`, modify the `handlePrepareCommand`
          function. Pass the `claude` option from the command's `options` object
          into the `preparePhase` function call's options.
        done: true
      - prompt: >
          In `src/rmplan/plans/prepare_phase.ts`, update the
          `PreparePhaseOptions` interface to include an optional `claude?:
          boolean` property. Also, update the `preparePhase` function signature
          to accept this new option.
        done: true
      - prompt: >
          Inside the `preparePhase` function in
          `src/rmplan/plans/prepare_phase.ts`, add a conditional block `if
          (options.claude) { ... }`. The existing logic for direct/clipboard
          mode should be moved into the `else` block. The new `if` block will
          house the Claude Code invocation logic.
        done: true
  - title: Adapt the `prepare` Prompt for Two-Step Invocation
    description: Refactor the prompt construction for the `prepare` command to split
      it into a planning section and a final output generation instruction,
      compatible with the orchestration service. This involves creating new
      prompt generation functions and integrating them into the `preparePhase`
      logic.
    files:
      - src/rmplan/prompt.ts
      - src/rmplan/plans/prepare_phase.ts
    steps:
      - prompt: >
          In `src/rmplan/prompt.ts`, create and export a new function
          `generateClaudeCodePhaseStepsPlanningPrompt(context:
          PhaseGenerationContext): string`. This function should adapt the
          content of `generatePhaseStepsPrompt` to create a planning-only
          prompt, instructing the AI to analyze the context and codebase but to
          wait for a follow-up instruction before generating the YAML output.
        done: true
      - prompt: >
          In `src/rmplan/prompt.ts`, create and export a new function
          `generateClaudeCodePhaseStepsGenerationPrompt(): string`. This
          function will return a static string that instructs the AI to generate
          the `tasks` array in YAML format based on its prior analysis,
          including the `files` and `steps` for each task. The output format
          guidelines from `generatePhaseStepsPrompt` should be included.
        done: true
      - prompt: >
          In `src/rmplan/plans/prepare_phase.ts`, within the `if
          (options.claude)` block, call the two new prompt functions
          (`generateClaudeCodePhaseStepsPlanningPrompt` and
          `generateClaudeCodePhaseStepsGenerationPrompt`) to create the
          `planningPrompt` and `generationPrompt`.
        done: true
      - prompt: >
          Inside the `if (options.claude)` block, call the
          `runClaudeCodeGeneration` orchestrator with the generated prompts and
          necessary configuration.
        done: true
      - prompt: >
          After receiving the YAML string from the orchestrator, parse it to get
          the new task details. Merge these details (the `files` and `steps`
          arrays) into the original plan's tasks, preserving completed tasks and
          other metadata. Finally, write the updated plan object back to the
          file using `writePlanFile`.
        done: true
  - title: Add Integration Tests for the `prepare` Command's Claude Path
    description: Create new integration tests for the `prepare` command with the
      `--claude` flag to verify its correct functionality and output. This will
      involve testing the `preparePhase` function directly.
    files:
      - src/rmplan/plans/prepare_phase.test.ts
    steps:
      - prompt: >
          Create a new test file `src/rmplan/plans/prepare_phase.test.ts`. Use
          the `ModuleMocker` for mocking dependencies like
          `runClaudeCodeGeneration`.
        done: true
      - prompt: >
          Write a test case for the `preparePhase` function when called with the
          `claude: true` option. Set up a temporary plan file with tasks that
          only have titles and descriptions.
        done: true
      - prompt: >
          In your test, mock the `runClaudeCodeGeneration` function to resolve
          with a predefined YAML string. This string should represent a `tasks`
          array containing `files` and `steps` for the tasks in your temporary
          plan file.
        done: true
      - prompt: >
          Call `preparePhase` with the path to your temporary plan file and
          `claude: true`. After the function completes, read the content of the
          temporary plan file.
        done: true
      - prompt: >
          Parse the updated plan file content and assert that the tasks have
          been correctly updated with the `files` and `steps` from your mocked
          YAML output, while other plan properties remain unchanged.
        done: true
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
