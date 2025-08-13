---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Support custom docs for implementer, tester, and reviewer agents
goal: To implement the core functionality for defining, loading, and injecting
  custom instructions into the prompts for the implementer, tester, and reviewer
  agents.
id: 98
status: in_progress
priority: high
dependencies: []
planGeneratedAt: 2025-08-13T19:15:03.540Z
promptsGeneratedAt: 2025-08-13T19:18:44.562Z
createdAt: 2025-08-13T19:06:31.948Z
updatedAt: 2025-08-13T19:18:44.912Z
tasks:
  - title: "Task 1: Extend `rmplanConfigSchema` to support agent-specific
      instructions"
    description: >
      The `rmplanConfigSchema` in `src/rmplan/configSchema.ts` will be updated
      to include a new optional `agents` object. This object will contain
      optional sub-objects for `implementer`, `tester`, and `reviewer`, each
      with an optional `instructions` string field for the file path. This
      follows the same pattern as the existing `planning.instructions` field.


      The schema structure will be:

      ```

      agents?: {
        implementer?: { instructions?: string }
        tester?: { instructions?: string }
        reviewer?: { instructions?: string }
      }

      ```


      Tests will be added to verify:

      - The schema accepts valid agent configurations

      - Invalid configurations are rejected appropriately

      - The schema remains backward compatible (works without agents section)
    done: true
    files:
      - src/rmplan/configSchema.ts
      - src/rmplan/configSchema.test.ts
    steps:
      - prompt: >
          In configSchema.test.ts, add a new describe block for 'agents field'
          that tests the new agents configuration.

          Include tests for: valid agent configurations with all three agents,
          partial configurations with only some agents,

          invalid field names within agents, and ensuring the field is optional.
        done: true
      - prompt: >
          In configSchema.ts, add the new `agents` field to rmplanConfigSchema
          after the `planning` field.

          Create the structure with optional implementer, tester, and reviewer
          objects, each containing an optional instructions string field.

          Add appropriate descriptions for each field to document their purpose.
        done: true
      - prompt: >
          Run the tests to ensure the new schema validation works correctly and
          all existing tests still pass.
        done: true
  - title: "Task 2: Modify agent prompt functions to accept custom instructions"
    description: >
      The `getImplementerPrompt`, `getTesterPrompt`, and `getReviewerPrompt`
      functions in `src/rmplan/executors/claude_code/agent_prompts.ts` will be
      updated to accept an optional `customInstructions` parameter. When
      provided, this string will be formatted and included in the agent's prompt
      under a dedicated "Custom Instructions" section, placed after the context
      but before the primary responsibilities section.


      The custom instructions will be clearly delineated with a header like:

      ```

      ## Custom Instructions

      ${customInstructions}

      ```


      This ensures the custom instructions are prominent but don't interfere
      with the core agent behavior. Tests will verify that:

      - Custom instructions are included when provided

      - The prompts work correctly without custom instructions (backward
      compatibility)

      - Custom instructions appear in the expected location within the prompt
    done: true
    files:
      - src/rmplan/executors/claude_code/agent_prompts.ts
      - src/rmplan/executors/claude_code/agent_prompts.test.ts
    steps:
      - prompt: >
          In agent_prompts.test.ts, add tests for each agent prompt function
          that verify custom instructions are included

          when provided. Test that the custom instructions appear after the
          context section and that prompts still work

          without custom instructions.
        done: true
      - prompt: >
          Update the function signatures of getImplementerPrompt,
          getTesterPrompt, and getReviewerPrompt to accept

          an optional second parameter `customInstructions?: string`.
        done: true
      - prompt: >
          In each prompt function, add logic to include the custom instructions
          if provided. Insert them as a

          "## Custom Instructions" section after the "## Context and Task"
          section but before the primary responsibilities.
        done: true
      - prompt: >
          Run the tests to ensure custom instructions are properly included and
          all existing functionality remains intact.
        done: true
  - title: "Task 3: Load and pass custom instructions in `ClaudeCodeExecutor`"
    description: >
      In the `execute` method of `ClaudeCodeExecutor`
      (`src/rmplan/executors/claude_code.ts`), logic will be added to read the
      new `agents` configuration. If an `instructions` path is defined for an
      agent, the executor will read the content of that file, resolving the path
      relative to the git root using the same pattern as
      `planning.instructions`.


      The implementation will:

      1. Check if `rmplanConfig.agents` exists and contains instruction paths

      2. For each agent with an instructions path, resolve the path (absolute or
      relative to git root)

      3. Read the file contents asynchronously with proper error handling

      4. Pass the loaded instructions to the corresponding prompt generation
      function


      Error handling will log warnings for missing files but not fail the
      execution, similar to how other optional configuration files are handled
      in the codebase.
    done: true
    files:
      - src/rmplan/executors/claude_code.ts
    steps:
      - prompt: >
          Create a helper function `loadAgentInstructions` that takes an
          instruction path and git root, resolves the path

          (absolute or relative), reads the file content, and returns it.
          Include try-catch error handling that logs

          warnings for missing files and returns undefined.
        done: true
      - prompt: >
          In the execute method, after getting the git root and before
          generating agent files, add code to load

          custom instructions for each agent if they're specified in
          rmplanConfig.agents. Store the loaded

          instructions in variables like implementerInstructions,
          testerInstructions, and reviewerInstructions.
        done: true
      - prompt: >
          Update the calls to getImplementerPrompt, getTesterPrompt, and
          getReviewerPrompt to pass the loaded

          custom instructions as the second parameter. Ensure the agent
          definitions are created correctly with

          the custom instructions included.
        done: true
  - title: "Task 4: Add an integration test for custom agent instructions"
    description: >
      A new integration test will be added to
      `src/rmplan/executors/claude_code.test.ts` that verifies the end-to-end
      flow of custom agent instructions. The test will:


      1. Create a temporary directory with instruction files for each agent

      2. Set up a configuration that references these instruction files

      3. Create a ClaudeCodeExecutor instance with this configuration

      4. Mock the necessary dependencies (similar to existing tests)

      5. Execute the executor and capture the generated agent prompts

      6. Verify that each agent's prompt includes the content from its custom
      instruction file


      This test ensures that the entire pipeline works correctly: from
      configuration parsing, to file loading, to prompt generation with custom
      instructions. It will use real file operations (following the testing
      philosophy of preferring real filesystem operations over mocks where
      possible).
    done: true
    files:
      - src/rmplan/executors/claude_code.test.ts
    steps:
      - prompt: >
          Add a new test 'includes custom instructions from config files in
          agent prompts' that creates a temporary

          directory using fs.mkdtemp, writes instruction files for implementer,
          tester, and reviewer agents, and

          creates a config object referencing these files.
        done: true
      - prompt: >
          In the test, mock the agent prompt functions to capture the
          customInstructions parameter passed to them.

          Set up other necessary mocks similar to existing tests (git root,
          process spawning, etc.).
        done: true
      - prompt: >
          Create a ClaudeCodeExecutor with the config containing agent
          instructions, execute it with test content,

          and verify that each agent prompt function was called with the correct
          custom instructions from the files.
        done: true
      - prompt: >
          Clean up the temporary directory after the test completes and ensure
          all tests pass.
        done: true
rmfilter:
  - src/rmplan/configSchema.ts
  - src/rmplan/executors/claude_code.ts
  - src/rmplan/executors/claude_code/
  - src/rmplan/commands/agent
---

# Original Plan Details

We support a `planning.instructions` document in the configSchema right now, which provides extra instructions when running planning.

We should add similar support for the `implementer`, `tester`, and `reviewer` agents.

Place these under a structure like this:

```
{
  "agents": {
    "implementer": {
      "instructions": "..."
    },
    "tester": {
      "instructions": "..."
    },
    "reviewer": {
      "instructions": "..."
    }
  }
}
```

All of these should be optional. If any are provided, then when creating the prompt for an agent, the custom
instructions should be included seamlessly.

# Processed Plan Details

This project will introduce a new configuration section in `rmplan.yml` to support custom instructions for the specialized agents used by the `ClaudeCodeExecutor`. Currently, a similar feature exists for the planning phase (`planning.instructions`), and this project extends that concept to the execution agents.

### Analysis
The work involves three main parts:
1.  **Configuration Schema Update:** The `rmplanConfigSchema` in `src/rmplan/configSchema.ts` needs to be extended to include a new `agents` object. This object will contain optional fields for `implementer`, `tester`, and `reviewer`, each with an optional `instructions` string field pointing to a file path.
2.  **Prompt Generation Logic:** The functions responsible for creating the agent prompts (`getImplementerPrompt`, `getTesterPrompt`, `getReviewerPrompt` in `src/rmplan/executors/claude_code/agent_prompts.ts`) must be updated to accept and incorporate the content of these custom instruction files.
3.  **Integration in the Executor:** The `ClaudeCodeExecutor` in `src/rmplan/executors/claude_code.ts` needs to be modified to read the new configuration, load the instruction files if they are specified, and pass their contents to the prompt generation functions.

The implementation will be contained within a single phase, as the components are tightly coupled and deliver the full feature once integrated.

### Acceptance Criteria
- The `rmplan.yml` configuration file accepts a new optional structure: `agents: { implementer: { instructions: '...' }, tester: { instructions: '...' }, reviewer: { instructions: '...' } }`.
- If an `instructions` path is provided for an agent, the content of that file is included in the prompt for that agent.
- If no `instructions` path is provided, the agent prompt is generated as it is currently, without any errors.
- The system gracefully handles cases where an instruction file is specified in the config but does not exist.
- The new configuration is validated by the Zod schema and has corresponding tests.
- The prompt generation logic is tested to ensure custom instructions are included correctly.
- An integration test verifies the end-to-end flow from configuration to prompt generation.

### Technical Considerations
- Paths to instruction files specified in the configuration should be resolved relative to the project's git root.
- The custom instructions should be clearly delineated within the agent's final prompt, for example, under a "Custom Instructions" heading.
- File I/O operations for reading instruction files should be asynchronous and handle potential errors (e.g., file not found).

This phase covers all the necessary code changes to support custom agent instructions. It starts by updating the configuration schema, then modifies the prompt generation logic to include the new instructions, and finally integrates these pieces within the `ClaudeCodeExecutor`. The phase will conclude with comprehensive testing to ensure the feature works as expected.
