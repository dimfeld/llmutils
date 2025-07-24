---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Option to use Claude Code for generate and prepare commands
goal: The overall goal is to provide an option to use a two-step Claude Code
  invocation for the `generate` and `prepare` commands, leveraging its planning
  capabilities to improve the quality of the generated output.
id: 72
status: done
priority: medium
container: true
dependencies:
  - 73
  - 74
  - 75
createdAt: 2025-07-23T07:52:38.535Z
updatedAt: 2025-07-23T23:30:14.356Z
tasks: []
changedFiles:
  - src/rmplan/commands/generate.test.ts
  - src/rmplan/commands/generate.ts
  - src/rmplan/executors/claude_code_orchestrator.ts
  - src/rmplan/prompt.ts
  - src/rmplan/rmplan.ts
  - README.md
  - src/rmplan/claude_utils.test.ts
  - src/rmplan/claude_utils.ts
  - src/rmplan/commands/prepare.ts
  - src/rmplan/display_utils.ts
  - src/rmplan/plans/prepare_phase.test.ts
  - src/rmplan/plans/prepare_phase.ts
  - src/rmplan/{prompt.ts => prompt.ts.bak}
rmfilter:
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/prepare.ts
  - src/rmplan/executors/claude_code.ts
  - --with-imports
---

# Original Plan Details

We should have a way to use Claude Code for the `generate` and `prepare` commands instead of calling an LLM directly.
Each of these should involve two invocations of Claude Code:

1. The planning section of the prompt
2. Then invoke it again with the same session, and ask it to generate the output in the requested format.

Look at the Claude Code executor for examples of how to invoke Claude Code and parse its output.

# Processed Plan Details

## Enable Claude Code for `generate` and `prepare` Commands

This project will introduce a new execution path for the `generate` and `prepare` commands. Currently, these commands call a generic LLM service directly. The new feature will allow users to specify, via a command-line flag, that they want to use Anthropic's Claude Code model instead.

The interaction with Claude Code will be a two-step process for each command:
1.  First, a "planning" prompt will be sent to Claude Code to reason about the task.
2.  Second, using the context from the same session, a follow-up prompt will be sent to generate the final output in the required format.

This approach is expected to yield more structured and accurate results. The implementation will rely on an existing `Claude Code executor` for the low-level API interaction and output parsing.

### Acceptance Criteria
- A `--claude` flag is available on both the `generate` and `prepare` commands.
- When the `--claude` flag is used, the command executes the two-step Claude Code invocation.
- When the `--claude` flag is not present, the command's behavior is unchanged, and it continues to use the existing direct LLM call.
- The core logic for the two-step invocation is reusable and shared between both commands.
- The new functionality is covered by a robust set of integration tests.
- The `README.md` file is updated to document the new `--claude` flag and its usage.
