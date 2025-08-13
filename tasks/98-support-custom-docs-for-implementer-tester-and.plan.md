---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Support custom docs for implementer, tester, and reviewer agents
goal: To implement the core functionality for defining, loading, and injecting
  custom instructions into the prompts for the implementer, tester, and reviewer
  agents.
id: 98
status: pending
priority: high
dependencies: []
planGeneratedAt: 2025-08-13T19:15:03.540Z
createdAt: 2025-08-13T19:06:31.948Z
updatedAt: 2025-08-13T19:15:03.540Z
tasks:
  - title: "Task 1: Extend `rmplanConfigSchema` to support agent-specific
      instructions"
    description: The `rmplanConfigSchema` in `src/rmplan/configSchema.ts` will be
      updated to include a new optional `agents` object. This object will
      contain optional sub-objects for `implementer`, `tester`, and `reviewer`,
      each with an optional `instructions` string field for the file path.
      Corresponding tests will be added to `configSchema.test.ts` to validate
      this new structure.
    steps: []
  - title: "Task 2: Modify agent prompt functions to accept custom instructions"
    description: The `getImplementerPrompt`, `getTesterPrompt`, and
      `getReviewerPrompt` functions in
      `src/rmplan/executors/claude_code/agent_prompts.ts` will be updated to
      accept an optional `customInstructions` string. When provided, this string
      will be formatted and included in the agent's prompt, for instance, under
      a dedicated "Custom Instructions" section. Tests in
      `agent_prompts.test.ts` will be updated to verify this behavior.
    steps: []
  - title: "Task 3: Load and pass custom instructions in `ClaudeCodeExecutor`"
    description: In the `execute` method of `ClaudeCodeExecutor`
      (`src/rmplan/executors/claude_code.ts`), logic will be added to read the
      new `agents` configuration. If an `instructions` path is defined for an
      agent, the executor will read the content of that file (resolving the path
      relative to the git root) and pass it to the corresponding `get...Prompt`
      function. Error handling for missing files will be included.
    steps: []
  - title: "Task 4: Add an integration test for custom agent instructions"
    description: A new integration test will be added to
      `src/rmplan/executors/claude_code.test.ts`. This test will set up a
      temporary environment with a config file specifying custom instructions
      for an agent. It will then run the `ClaudeCodeExecutor` and assert that
      the generated agent prompt correctly includes the content from the custom
      instruction file, verifying the end-to-end flow.
    steps: []
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
