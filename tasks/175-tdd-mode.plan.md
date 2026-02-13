---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: tdd mode
goal: ""
id: 175
uuid: 81bfa931-f9bc-4b5e-9ead-d7ab1a847137
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-02-13T02:09:33.802Z
promptsGeneratedAt: 2026-02-13T02:09:33.802Z
createdAt: 2026-02-12T22:51:53.004Z
updatedAt: 2026-02-13T03:20:08.900Z
tasks:
  - title: Add tdd field to plan schema
    done: true
    description: "Add `tdd: z.boolean().optional()` to the plan schema in
      `src/tim/planSchema.ts`, right next to the existing `simple` field. This
      allows plans to declare TDD mode in their YAML frontmatter."
  - title: Add tdd-tests to SubagentType and register CLI command
    done: true
    description: >-
      In `src/tim/commands/subagent.ts`: Update `SubagentType` union to include
      `tdd-tests`. Add a `case tdd-tests` in `buildAgentDefinition()` that calls
      the new `getTddTestsPrompt()` function. Map tdd-tests to tddTests for
      custom instructions loading.


      In `src/tim/tim.ts`: Update the subagent registration loop to include
      `tdd-tests` in the array.
  - title: Create the TDD tests agent prompt
    done: true
    description: "Add a new `getTddTestsPrompt()` function in
      `src/tim/executors/claude_code/agent_prompts.ts` following the pattern of
      `getTesterPrompt()`. The prompt should instruct the agent to: (1) Read and
      understand task specs, (2) Analyze existing test patterns, (3) Write
      comprehensive tests defining expected behavior, (4) Create minimal
      stubs/scaffolding so tests can compile and import correctly, (5) Run tests
      and verify they fail for correct reasons (not syntax/import errors), (6)
      Fix any tests that fail for wrong reasons, (7) Report a summary of tests
      written and behavior defined."
  - title: Add --tdd CLI option and thread through agent command
    done: true
    description: >-
      In `src/tim/tim.ts` `createAgentCommand()`: Add `.option("--tdd", "Use TDD
      mode: write tests first, then implement to make them pass")` alongside the
      existing `--simple` option.


      In `src/tim/executors/types.ts`: Add `tdd` to
      `ExecutePlanInfo.executionMode` union type.


      In `src/tim/commands/agent/agent.ts`: Follow the exact pattern used for
      `--simple` (lines 476-505). Check for explicit `--tdd` flag, fall back to
      `planData.tdd`, determine executionMode as `tdd` when enabled. TDD mode
      takes priority over simple mode for execution mode selection, but
      simpleMode is still tracked separately and passed through.


      In `src/tim/commands/agent/batch_mode.ts`: Update the `executionMode` type
      to include `tdd`.
  - title: Create TDD orchestrator prompt
    done: true
    description: >-
      Add `wrapWithOrchestrationTdd()` in
      `src/tim/executors/claude_code/orchestrator_prompt.ts`. Add `simpleMode?:
      boolean` to the `OrchestrationOptions` interface.


      TDD Normal (simpleMode=false): Available agents are tdd-tests +
      implementer + tester. Workflow: tdd-tests -> implementer -> tester ->
      review -> notes -> iteration.


      TDD Simple (simpleMode=true): Available agents are tdd-tests + implementer
      + verifier. Workflow: tdd-tests -> implementer -> verifier -> notes ->
      iteration.


      Both variants share TDD-specific instructions telling the orchestrator: we
      are using TDD, the tdd-tests agent writes and runs tests first verifying
      they fail for correct reasons, pass TDD test output to the implementer
      instructing it to make those tests pass.
  - title: Wire up TDD mode in the Claude Code executor
    done: true
    description: "In `src/tim/executors/claude_code.ts` `execute()` method (around
      line 937-953): Add a branch for `planInfo.executionMode === tdd` that
      calls `wrapWithOrchestrationTdd()`, passing `simpleMode:
      this.sharedOptions.simpleMode` along with the other options (batchMode,
      planFilePath, reviewExecutor, subagentExecutor,
      dynamicSubagentInstructions)."
  - title: Add custom instructions support for tdd-tests agent
    done: true
    description: >-
      In `src/tim/configSchema.ts`: Add a `tddTests` entry to the `agents`
      config schema alongside `implementer`, `tester`, and `reviewer`.


      In `src/tim/executors/codex_cli/agent_helpers.ts`: Update
      `loadAgentInstructionsFor()` to accept `tddTests` as an agent type.
  - title: Write tests for TDD mode
    done: true
    description: >-
      Add tests covering:


      1. Agent command tests (src/tim/commands/agent/agent.test.ts): --tdd flag
      sets executionMode to tdd. Plan YAML tdd: true enables TDD mode. CLI --tdd
      overrides plan YAML. TDD mode passes correct orchestration wrapper.


      2. Orchestrator prompt tests: wrapWithOrchestrationTdd() output includes
      tdd-tests agent in available agents. Workflow instructions include TDD
      test phase before implementation. Both simpleMode=true and
      simpleMode=false variants work. Batch mode and non-batch mode variants
      work. Dynamic executor guidance is included when appropriate.


      3. Subagent tests: tdd-tests is accepted as a valid subagent type and
      dispatches to the correct prompt builder.
changedFiles:
  - README.md
  - src/tim/batch_mode_integration.test.ts
  - src/tim/commands/agent/agent.test.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/agent/batch_mode.ts
  - src/tim/commands/agent/stub_plan.ts
  - src/tim/commands/subagent.test.ts
  - src/tim/commands/subagent.ts
  - src/tim/configSchema.ts
  - src/tim/executors/claude_code/agent_prompts.test.ts
  - src/tim/executors/claude_code/agent_prompts.ts
  - src/tim/executors/claude_code/orchestrator_prompt.test.ts
  - src/tim/executors/claude_code/orchestrator_prompt.ts
  - src/tim/executors/claude_code.test.ts
  - src/tim/executors/claude_code.ts
  - src/tim/executors/codex_cli/agent_helpers.ts
  - src/tim/executors/codex_cli.test.ts
  - src/tim/executors/codex_cli.ts
  - src/tim/executors/types.ts
  - src/tim/planSchema.ts
  - src/tim/tim.ts
  - tim-gui/TimGUI/SessionsView.swift
tags: []
---

Add a new "tdd-tests" subagent. Tell the orchestrator that we are using TDD, and that it should run the TDD test sub-agent first before proceeding with the implementation.

Add a `--tdd` argument to the agent command to enable this mode.

## Expected Behavior/Outcome

When `--tdd` is passed to `tim agent` (or `tim run`), the orchestration workflow changes from the default cycle to a TDD-oriented cycle.

**TDD Normal mode** (`--tdd` without `--simple`):
1. **TDD Test Phase**: A new "tdd-tests" subagent writes failing tests, runs them, and verifies they fail for the expected reasons (not syntax/import errors)
2. **Implementation Phase**: The implementer subagent implements code to make the tests pass
3. **Testing Phase**: The regular tester subagent verifies coverage and fixes remaining issues
4. **Review Phase**: The reviewer runs as usual

**TDD Simple mode** (`--tdd --simple`):
1. **TDD Test Phase**: Same as above
2. **Implementation Phase**: The implementer subagent implements code to make the tests pass
3. **Verification Phase**: The verifier subagent combines testing and review

The TDD mode should also be settable per-plan via a `tdd: true` field in the plan YAML (similar to `simple: true`).

## Key Findings

### Product & User Story
As a developer using tim's agent system, I want a TDD mode that writes tests first so that the implementation is driven by well-defined test specifications, resulting in better test coverage and more focused implementations.

### Design & UX Approach
- `--tdd` flag on the agent command enables TDD mode
- `tdd: true` in plan YAML enables it per-plan (CLI flag overrides)
- TDD mode is orthogonal to simple mode: `--tdd` alone uses the normal orchestration with a TDD test phase prepended; `--tdd --simple` uses the simplified orchestration with a TDD test phase prepended
- The `tdd-tests` subagent writes tests, runs them, and verifies they fail for the correct reasons (not syntax/import errors)
- The orchestrator passes TDD test output to the implementer as context

### Technical Plan & Risks
- **Low risk**: This follows the exact same patterns as existing subagent types (implementer, tester, verifier)
- **Moderate complexity**: The orchestrator prompt needs a new workflow variant that includes the TDD test phase
- **Risk**: The TDD tests subagent must understand it should write tests that fail (since no implementation exists yet), which requires careful prompt engineering

### Pragmatic Effort Estimate
Small-medium feature. The infrastructure is well-established; the work is primarily:
- New subagent type + prompt (~30 lines)
- New orchestrator prompt function (~100-150 lines)
- CLI flag plumbing (~20 lines)
- Tests (~200-300 lines)

## Acceptance Criteria

- [ ] `tim agent <plan> --tdd` enables TDD mode
- [ ] `tdd: true` in plan YAML enables TDD mode (CLI flag overrides)
- [ ] `tim subagent tdd-tests <planId>` works as a standalone command
- [ ] TDD normal mode workflow: tdd-tests → implementer → tester → reviewer
- [ ] TDD simple mode workflow (`--tdd --simple`): tdd-tests → implementer → verifier
- [ ] The TDD tests subagent writes tests, creates minimal stubs, runs tests, and verifies they fail for correct reasons
- [ ] The orchestrator passes TDD test output to the implementer as context
- [ ] All new code paths are covered by tests

## Dependencies & Constraints

- **Dependencies**: Relies on existing subagent infrastructure (`SubagentType`, `handleSubagentCommand`, `buildAgentDefinition`), orchestration prompt system (`wrapWithOrchestration`), and CLI registration in `tim.ts`
- **Technical Constraints**: Must work with both `claude-code` and `codex-cli` executors. Must work in both batch mode and serial mode.

## Implementation Notes

### Recommended Approach
Follow the exact patterns used for existing subagent types. The `simple` flag plumbing is a good reference for how `tdd` should be threaded through the system (plan YAML field → CLI option → executor options → orchestration prompt).

### Potential Gotchas
- The TDD tests subagent must clearly understand that tests should *fail* initially (no implementation exists yet). The prompt must emphasize: write tests for the expected behavior, run them, and verify they fail for correct reasons (not syntax/import errors).
- The orchestrator must pass context from the TDD tests phase to the implementer so it knows which tests to make pass.
- The execution mode stays `'tdd'` for both normal and simple variants — the orchestration prompt builder reads `simpleMode` from options to decide which TDD workflow variant to generate.

## Research

### Architecture Overview

The agent system follows a multi-agent orchestration pattern where:
- **Agent command** (`tim agent`) is the entry point
- **Orchestrator** (Claude Code) coordinates specialized subagents
- **Subagents** (implementer, tester, verifier) perform specific roles
- **Plan file** serves as shared state

### Key Files and Their Roles

1. **`src/tim/tim.ts`** (lines 519-589): `createAgentCommand()` - Registers CLI options for `tim agent` and `tim run`. This is where `--tdd` will be added (alongside `--simple` on line 578).

2. **`src/tim/commands/agent/agent.ts`**: Main agent command handler. Lines 476-505 show how `--simple` is resolved (CLI flag → plan YAML field → config → executionMode). The `tdd` flag will follow this exact pattern.

3. **`src/tim/commands/subagent.ts`**: Subagent command handler. Line 42 defines `SubagentType = 'implementer' | 'tester' | 'verifier'`. This union type needs `'tdd-tests'` added. Lines 215-244 show `buildAgentDefinition()` which dispatches to the right prompt builder based on type.

4. **`src/tim/executors/claude_code/agent_prompts.ts`**: Agent prompt definitions. Contains `getImplementerPrompt()` (line 54), `getTesterPrompt()` (line 129), and `getVerifierAgentPrompt()` (line 225). A new `getTddTestsPrompt()` function will be added here.

5. **`src/tim/executors/claude_code/orchestrator_prompt.ts`**: Orchestration prompt builders. `wrapWithOrchestration()` (line 302) builds the normal 3-phase workflow. A new `wrapWithOrchestrationTdd()` function (or modifications to the existing function) will add the TDD test phase.

6. **`src/tim/executors/claude_code.ts`**: The Claude Code executor. Lines 937-953 show how `executionMode` selects between `wrapWithOrchestration()` and `wrapWithOrchestrationSimple()`. A new `'tdd'` execution mode branch will call the TDD orchestration wrapper.

7. **`src/tim/executors/types.ts`**: Type definitions. `ExecutePlanInfo.executionMode` (line 60) needs `'tdd'` added to the union type. `ExecutorCommonOptions` may need a `tddMode` field.

8. **`src/tim/planSchema.ts`**: Plan YAML schema. Line 35 shows `simple: z.boolean().optional()`. A `tdd: z.boolean().optional()` field follows the same pattern.

9. **`src/tim/commands/agent/batch_mode.ts`**: Batch mode execution. Line 38 shows `executionMode?: 'normal' | 'simple'`. This type needs `'tdd'` added.

### How the `simple` Flag Flows Through the System (Reference Pattern)

1. **CLI**: `--simple` option registered in `createAgentCommand()` (tim.ts:578)
2. **Plan YAML**: `simple: true` field in plan schema (planSchema.ts:35)
3. **Agent command**: Resolves CLI flag vs. plan field (agent.ts:476-505), determines `executionMode`
4. **Executor options**: `simpleMode` passed in `ExecutorCommonOptions` (types.ts:16)
5. **Executor**: `executionMode === 'simple'` branches to `wrapWithOrchestrationSimple()` (claude_code.ts:946-948)
6. **Orchestrator prompt**: Different workflow instructions generated

### Existing Subagent Registration Pattern

In `tim.ts` (lines 1199-1224), subagent commands are registered by iterating over the type array:
```typescript
for (const agentType of ['implementer', 'tester', 'verifier'] as const) {
  subagentCommand.command(`${agentType} <planFile>`)...
}
```
Adding `'tdd-tests'` to this array will automatically register the CLI command.

### Existing Agent Prompt Pattern

Each agent prompt function (e.g., `getImplementerPrompt()`) returns an `AgentDefinition` with:
- `name`: Agent identifier
- `description`: What it does
- `model`: Optional model override
- `skills`: Skills to enable (typically `['using-tim']`)
- `prompt`: The full system prompt text

### Custom Instructions Support

Agents can have custom instructions loaded from config files via `loadAgentInstructionsFor()` in `src/tim/executors/codex_cli/agent_helpers.ts`. The config schema at `src/tim/configSchema.ts` (lines 299-326) defines instruction paths for `implementer`, `tester`, and `reviewer`. A `tddTests` entry should be added to support custom TDD test instructions.

### Orchestrator Prompt Structure

The normal mode orchestrator prompt (`wrapWithOrchestration()`) includes:
1. Header explaining the orchestrator role
2. Available agents section (implementer + tester)
3. Dynamic executor guidance (if applicable)
4. Workflow instructions (implement → test → review)
5. Important guidelines
6. Task context

For TDD mode, the workflow will be: tdd-tests → implement → test → review, with the available agents section listing the tdd-tests agent as well.

## Implementation Guide

### Step 1: Add `tdd` field to plan schema

**File**: `src/tim/planSchema.ts`

Add `tdd: z.boolean().optional()` to the plan schema, right next to the existing `simple` field. This allows plans to declare TDD mode in their YAML frontmatter.

### Step 2: Add `'tdd-tests'` to SubagentType and register CLI command

**File**: `src/tim/commands/subagent.ts`

1. Update `SubagentType` union: `'implementer' | 'tester' | 'verifier' | 'tdd-tests'`
2. Add a `case 'tdd-tests':` in `buildAgentDefinition()` that calls the new `getTddTestsPrompt()` function
3. For custom instructions loading, map `'tdd-tests'` to a new `'tddTests'` agent type

**File**: `src/tim/tim.ts`

Update the subagent registration loop to include `'tdd-tests'`:
```typescript
for (const agentType of ['implementer', 'tester', 'verifier', 'tdd-tests'] as const) {
```

### Step 3: Create the TDD tests agent prompt

**File**: `src/tim/executors/claude_code/agent_prompts.ts`

Add a new `getTddTestsPrompt()` function following the pattern of `getTesterPrompt()`. Key differences in the prompt:

- **Role**: "You are a TDD test-writing agent. Your job is to write tests that define the expected behavior BEFORE implementation exists."
- **Primary Responsibilities**:
  1. Read and understand the task specifications
  2. Analyze existing test patterns in the codebase
  3. Write comprehensive tests that define the expected behavior
  4. Run the tests and verify they fail for the correct reasons (not syntax errors, missing imports, or other unrelated issues)
  5. Create minimal stubs/scaffolding (empty exported functions, types, module files) so tests can compile and import correctly — tests should fail on assertions, not on import/compile errors
  6. Fix any tests that fail for wrong reasons (e.g., fix imports, correct test syntax)
  7. Focus on defining the interface/API/behavior that the implementation should satisfy
- **Guidelines**:
  - Write tests that are clear about what behavior they expect
  - Structure tests so they can guide implementation
  - Use the project's existing test patterns and frameworks
  - Focus on behavior, not implementation details
  - Include edge cases and error scenarios
  - Make tests specific enough to guide implementation but not so specific that they couple to implementation details
  - After writing tests, run them all and verify each failure is due to unimplemented functionality (not broken test code)
  - If a test fails due to a syntax error or missing import, fix the test before finishing
  - Report a summary of which tests were written and what behavior they define

### Step 4: Add `--tdd` CLI option

**File**: `src/tim/tim.ts`

In `createAgentCommand()`, add `.option('--tdd', 'Use TDD mode: write tests first, then implement to make them pass')` alongside the existing `--simple` option.

### Step 5: Add `'tdd'` to execution mode types

**File**: `src/tim/executors/types.ts`

Update `ExecutePlanInfo.executionMode` to include `'tdd'`:
```typescript
executionMode: 'normal' | 'simple' | 'review' | 'planning' | 'bare' | 'tdd';
```

### Step 6: Thread `--tdd` flag through the agent command

**File**: `src/tim/commands/agent/agent.ts`

Follow the exact pattern used for `--simple` (lines 476-505):
1. Check if explicit `--tdd` flag was passed
2. Fall back to `planData.tdd` field from plan YAML
3. Determine execution mode: if TDD is enabled, set `executionMode = 'tdd'`
4. Pass through to executor

**File**: `src/tim/commands/agent/batch_mode.ts`

Update the `executionMode` type to include `'tdd'`.

### Step 7: Create TDD orchestrator prompt

**File**: `src/tim/executors/claude_code/orchestrator_prompt.ts`

Add a new `wrapWithOrchestrationTdd()` function. This accepts an `OrchestrationOptions` extended with a `simpleMode?: boolean` field (or add it to the existing `OrchestrationOptions` interface). Based on `simpleMode`, it generates one of two workflow variants:

**TDD Normal** (simpleMode=false):
1. **Available Agents**: tdd-tests, implementer, tester (3 agents)
2. **Workflow**: tdd-tests → implementer → tester → review → notes → iteration

**TDD Simple** (simpleMode=true):
1. **Available Agents**: tdd-tests, implementer, verifier (3 agents)
2. **Workflow**: tdd-tests → implementer → verifier → notes → iteration

Both variants share the same TDD-specific instructions:
- "We are using Test-Driven Development. The tdd-tests agent writes and runs tests first, verifying they fail for the correct reasons."
- "Pass the TDD test output to the implementer. Instruct it to make those tests pass."
- "The implementer should focus on making the existing tests pass rather than adding new tests."

The implementation can either be a single function with conditional branches based on `simpleMode`, or share helper functions between the two variants — whichever is cleaner.

### Step 8: Wire up TDD mode in the Claude Code executor

**File**: `src/tim/executors/claude_code.ts`

In the `execute()` method (around line 937-953), add a branch for TDD mode:
```typescript
} else if (planInfo.executionMode === 'tdd') {
  contextContent = wrapWithOrchestrationTdd(contextContent, planId, {
    batchMode: planInfo.batchMode,
    planFilePath,
    simpleMode: this.sharedOptions.simpleMode,
    reviewExecutor: this.sharedOptions.reviewExecutor,
    subagentExecutor: this.sharedOptions.subagentExecutor,
    dynamicSubagentInstructions: this.sharedOptions.dynamicSubagentInstructions,
  });
}
```

Note that `simpleMode` is passed through so the TDD orchestrator prompt can choose between the normal and simple TDD workflow variants.

### Step 9: Add custom instructions support for tdd-tests agent

**File**: `src/tim/configSchema.ts`

Add a `tddTests` entry to the `agents` config schema alongside `implementer`, `tester`, and `reviewer`.

**File**: `src/tim/executors/codex_cli/agent_helpers.ts`

Update `loadAgentInstructionsFor()` to accept `'tddTests'` as an agent type.

### Step 10: Write tests

**Test files to create/update**:

1. **Agent command tests** (`src/tim/commands/agent/agent.test.ts`): Add tests verifying:
   - `--tdd` flag sets `executionMode` to `'tdd'`
   - Plan YAML `tdd: true` enables TDD mode
   - CLI `--tdd` overrides plan YAML
   - TDD mode passes correct orchestration wrapper

2. **Orchestrator prompt tests**: Add tests for `wrapWithOrchestrationTdd()` verifying:
   - Output includes tdd-tests agent in available agents
   - Workflow instructions include TDD test phase before implementation
   - Batch mode and non-batch mode variants work correctly
   - Dynamic executor guidance is included when appropriate

3. **Subagent tests**: Verify `tdd-tests` is accepted as a valid subagent type and dispatches to the correct prompt builder.

### Manual Testing Steps

1. Create a test plan with `tdd: true` in the YAML
2. Run `tim agent <plan> --tdd --dry-run` and verify the generated prompt includes TDD workflow
3. Run `tim subagent tdd-tests <planId> --input "Write tests for X"` and verify it executes
4. Run a full TDD cycle with a real plan to verify end-to-end behavior

## Current Progress
### Current State
- All 8 tasks are implemented and tested. TDD mode is fully functional.
### Completed (So Far)
- Plan schema: `tdd: z.boolean().optional()` added
- SubagentType union includes `tdd-tests`, registered in CLI loop
- `getTddTestsPrompt()` agent prompt created with TDD-specific instructions
- `--tdd` CLI option threaded through agent command, types, and batch mode
- `wrapWithOrchestrationTdd()` orchestrator prompt created with both normal and simple TDD variants
- Claude Code executor wired up with `executionMode === 'tdd'` branch
- Codex CLI executor also handles TDD mode (routes to normal/simple based on simpleMode)
- Custom instructions support added for `tddTests` agent in config schema and agent_helpers
- Comprehensive tests across agent command, subagent, agent prompts, orchestrator prompt, Claude Code executor, and Codex CLI executor
- README updated with TDD mode documentation
### Remaining
- None — all tasks complete
### Next Iteration Guidance
- None
### Decisions / Changes
- TDD mode takes priority over simple mode for execution mode selection, but simpleMode is still tracked separately and passed through to the orchestrator prompt
- Codex executor routes TDD mode to executeNormalMode or executeSimpleMode based on simpleMode flag (same pattern as the existing normal/simple routing)
### Risks / Blockers
- None
