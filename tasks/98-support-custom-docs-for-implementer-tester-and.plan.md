---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Support custom docs for implementer, tester, and reviewer agents
goal: To implement the core functionality for defining, loading, and injecting
  custom instructions into the prompts for the implementer, tester, and reviewer
  agents.
id: 98
uuid: a72be50e-33e3-4bcb-8b67-799d4c094776
status: done
priority: high
planGeneratedAt: 2025-08-13T19:15:03.540Z
promptsGeneratedAt: 2025-08-13T19:18:44.562Z
createdAt: 2025-08-13T19:06:31.948Z
updatedAt: 2025-10-27T08:39:04.269Z
tasks:
  - title: "Task 1: Extend `timConfigSchema` to support agent-specific
      instructions"
    done: true
    description: >
      The `timConfigSchema` in `src/tim/configSchema.ts` will be updated
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
  - title: "Task 2: Modify agent prompt functions to accept custom instructions"
    done: true
    description: >
      The `getImplementerPrompt`, `getTesterPrompt`, and `getReviewerPrompt`
      functions in `src/tim/executors/claude_code/agent_prompts.ts` will be
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
  - title: "Task 3: Load and pass custom instructions in `ClaudeCodeExecutor`"
    done: true
    description: >
      In the `execute` method of `ClaudeCodeExecutor`
      (`src/tim/executors/claude_code.ts`), logic will be added to read the
      new `agents` configuration. If an `instructions` path is defined for an
      agent, the executor will read the content of that file, resolving the path
      relative to the git root using the same pattern as
      `planning.instructions`.


      The implementation will:

      1. Check if `timConfig.agents` exists and contains instruction paths

      2. For each agent with an instructions path, resolve the path (absolute or
      relative to git root)

      3. Read the file contents asynchronously with proper error handling

      4. Pass the loaded instructions to the corresponding prompt generation
      function


      Error handling will log warnings for missing files but not fail the
      execution, similar to how other optional configuration files are handled
      in the codebase.
  - title: "Task 4: Add an integration test for custom agent instructions"
    done: true
    description: >
      A new integration test will be added to
      `src/tim/executors/claude_code.test.ts` that verifies the end-to-end
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
rmfilter:
  - src/tim/configSchema.ts
  - src/tim/executors/claude_code.ts
  - src/tim/executors/claude_code/
  - src/tim/commands/agent
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

This project will introduce a new configuration section in `tim.yml` to support custom instructions for the specialized agents used by the `ClaudeCodeExecutor`. Currently, a similar feature exists for the planning phase (`planning.instructions`), and this project extends that concept to the execution agents.

### Analysis
The work involves three main parts:
1.  **Configuration Schema Update:** The `timConfigSchema` in `src/tim/configSchema.ts` needs to be extended to include a new `agents` object. This object will contain optional fields for `implementer`, `tester`, and `reviewer`, each with an optional `instructions` string field pointing to a file path.
2.  **Prompt Generation Logic:** The functions responsible for creating the agent prompts (`getImplementerPrompt`, `getTesterPrompt`, `getReviewerPrompt` in `src/tim/executors/claude_code/agent_prompts.ts`) must be updated to accept and incorporate the content of these custom instruction files.
3.  **Integration in the Executor:** The `ClaudeCodeExecutor` in `src/tim/executors/claude_code.ts` needs to be modified to read the new configuration, load the instruction files if they are specified, and pass their contents to the prompt generation functions.

The implementation will be contained within a single phase, as the components are tightly coupled and deliver the full feature once integrated.

### Acceptance Criteria
- The `tim.yml` configuration file accepts a new optional structure: `agents: { implementer: { instructions: '...' }, tester: { instructions: '...' }, reviewer: { instructions: '...' } }`.
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
