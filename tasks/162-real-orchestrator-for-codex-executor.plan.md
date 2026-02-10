---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: More flexible orchestrator
goal: ""
id: 162
uuid: f98cd40a-4a6f-48f4-9320-540e03f80725
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-02-10T09:04:17.291Z
promptsGeneratedAt: 2026-02-10T09:04:17.291Z
createdAt: 2026-01-05T06:20:05.558Z
updatedAt: 2026-02-10T19:27:56.365Z
tasks:
  - title: Add config schema fields
    done: true
    description: Add dynamicSubagentInstructions, defaultOrchestrator, and
      defaultSubagentExecutor fields to timConfigSchema in
      src/tim/configSchema.ts. No defaults in schemas per CLAUDE.md. Also update
      mergeConfigs() in configLoader.ts if needed for the new fields.
  - title: Update ExecutorCommonOptions with subagent fields
    done: true
    description: Add subagentExecutor and dynamicSubagentInstructions fields to
      ExecutorCommonOptions in src/tim/executors/types.ts so the
      ClaudeCodeExecutor can receive subagent configuration.
  - title: Update agent command CLI flags
    done: true
    description: "In src/tim/tim.ts createAgentCommand(), replace the existing
      -x/--executor with --orchestrator for the main loop, and add a new
      -x/--executor for subagent executor selection (codex-cli, claude-code,
      dynamic). Add --dynamic-instructions flag. In
      src/tim/commands/agent/agent.ts, update executor selection:
      options.orchestrator -> config.defaultOrchestrator -> DEFAULT_EXECUTOR for
      main loop; options.executor -> config.defaultSubagentExecutor -> dynamic
      for subagents. Pass subagent config to executor via
      ExecutorCommonOptions."
  - title: Create tim subagent command implementation
    done: true
    description: "Create src/tim/commands/subagent.ts with handleSubagentCommand()
      supporting implementer, tester, and verifier types. Load plan context via
      readPlanFile() and buildExecutionPromptWithoutSteps(). Build subagent
      prompt using getImplementerPrompt/getTesterPrompt/getVerifierAgentPrompt
      from agent_prompts.ts with --input as custom instructions. For codex-cli
      path, use executeCodexStep(). For claude-code path, spawn claude with
      --verbose --output-format stream-json --print with full permissions setup
      (allowed tools, permissions MCP). Set up tunneling following
      codex_runner.ts pattern: check isTunnelActive(), create tunnel server if
      needed, pass TIM_OUTPUT_SOCKET to child. Print final agent message to
      stdout. Use mode: report for progress guidance."
  - title: Register subagent command in tim.ts
    done: true
    description: Register the tim subagent command in src/tim/tim.ts with
      implementer, tester, and verifier subcommands. Each takes planFile
      positional arg and -x/--executor, -m/--model, --input flags. Also add
      Bash(tim subagent:*) to the default allowed tools list in
      src/tim/executors/claude_code.ts (both in executeReviewMode and execute
      methods).
  - title: Update orchestrator prompts to use tim subagent
    done: true
    description: "Modify src/tim/executors/claude_code/orchestrator_prompt.ts to
      replace Task tool subagent invocations with tim subagent Bash commands.
      Add subagentExecutor and dynamicSubagentInstructions to
      OrchestrationOptions. Update buildAvailableAgents() to list tim subagent
      commands. Update buildWorkflowInstructions() to reference Bash
      invocations. For fixed mode, always pass -x <executor>. For dynamic mode,
      include decision instructions. Update both wrapWithOrchestration()
      (normal: implementer+tester) and wrapWithOrchestrationSimple() (simple:
      implementer+verifier). Add sufficient Bash timeout guidance (30 min). Tell
      orchestrator to include --input with task focus and context from previous
      phases."
  - title: Update ClaudeCodeExecutor to skip agent registration
    done: true
    description: In src/tim/executors/claude_code.ts execute() method, skip building
      agentDefinitions and the --agents flag when using the new subagent model.
      Pass subagentExecutor and dynamicSubagentInstructions from sharedOptions
      to the orchestration prompt via OrchestrationOptions. The orchestrator
      prompt alone handles everything. The change is in the section around line
      1207-1289 where agentDefinitions are currently built.
  - title: Write tests for subagent command and orchestrator changes
    done: true
    description: "Write tests covering: (1) Subagent prompt construction - verify
      correct prompt built for each type (implementer/tester/verifier). (2)
      Executor delegation - verify subagent correctly delegates to codex or
      claude based on -x flag. (3) Orchestrator prompt - verify prompts include
      tim subagent invocations, dynamic mode includes instructions, fixed mode
      includes correct -x flag. (4) CLI flag changes - verify --orchestrator
      selects main loop executor, -x selects subagent executor,
      --dynamic-instructions overrides config. (5) Config fields - verify
      dynamicSubagentInstructions, defaultOrchestrator, defaultSubagentExecutor
      load correctly from config."
  - title: Update README with new CLI flags and configuration
    done: true
    description: Document the new agent command flags (--orchestrator, repurposed
      -x/--executor, --dynamic-instructions), the new config fields
      (defaultOrchestrator, defaultSubagentExecutor,
      dynamicSubagentInstructions), the tim subagent command and its
      subcommands, and the dynamic executor selection feature.
changedFiles:
  - README.md
  - package.json
  - src/tim/commands/agent/agent.integration.test.ts
  - src/tim/commands/agent/agent.summary_file.integration.test.ts
  - src/tim/commands/agent/agent.test.ts
  - src/tim/commands/agent/agent.timeout.integration.test.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/agent/agent_batch_mode.test.ts
  - src/tim/commands/subagent.test.ts
  - src/tim/commands/subagent.ts
  - src/tim/configSchema.test.ts
  - src/tim/configSchema.ts
  - src/tim/executors/claude_code/orchestrator_integration.test.ts
  - src/tim/executors/claude_code/orchestrator_prompt.test.ts
  - src/tim/executors/claude_code/orchestrator_prompt.ts
  - src/tim/executors/claude_code/permissions_mcp_setup.ts
  - src/tim/executors/claude_code.test.ts
  - src/tim/executors/claude_code.ts
  - src/tim/executors/claude_code_model_test.ts
  - src/tim/executors/types.ts
  - src/tim/tim.ts
tags: []
---

Update the claude code orchestrator/executor with support for running either Claude or Codex at each subagent step.

For each of the existing subagents (implementer and tester), create a "tim subagent <implementer|tester>" command that takes some arbitrary input from the orchestrator, adds that to the base subagent prompt for the task and plan, runs it in either Claude or Codex, and then prints its final message. We should use the existing tunneling support that the review command supports so that the terminal still shows the intermediate output while not polluting the context of the orchestrator.

The instructions to run `tim review` for review should stay the same.

The subagent command should be able to run the command using either codex or claude by specifying the appropriate -x flag.

We should be able to provide guidance as to whether to use Claude or Codex for the subagents. Update the `agent` command
so that a new --orchestrator flag replaces the existing --executor flag, to determine which executor runs the main loop.
Default should still be `claude-code` which runs the new loop described here.

Once that is run, we want a new --executor,-x flag that specifies which executor to use for the subagents. Values should
be `codex-cli`, `claude-code`, and `dynamic` where dynamic is the default and tells the orchestrator to decide. 

We should be able to specify instructions for the dynamic mode that help it to choose. These should be passable on the command line or we should be able to set them in the project-level configuration, and falling back to the global configuration. If not set at all, default to "prefer claude for frontend, codex for backend."

We can use the existing tunneling support for the "subagent" commands.

## Research

### Overview

This plan transforms the Claude Code executor's orchestration model from using Claude Code's built-in `--agents` flag (Task tool subagents) to using a CLI-based subagent invocation pattern (`tim subagent <type>`). This enables the orchestrator to dynamically choose between Claude Code and Codex CLI for each subagent step, while maintaining the existing tunneling infrastructure for output forwarding.

### Current Architecture

#### Claude Code Executor Orchestration (current)

The current Claude Code executor (`src/tim/executors/claude_code.ts`) implements orchestration by:

1. **Agent Registration**: Building `AgentDefinition` objects via `getImplementerPrompt()`, `getTesterPrompt()`, etc. from `src/tim/executors/claude_code/agent_prompts.ts`, then passing them as `--agents` JSON argument via `buildAgentsArgument()` from `src/tim/executors/claude_code/agent_generator.ts`.

2. **Orchestration Prompt**: Wrapping the context with orchestration instructions via `wrapWithOrchestration()` or `wrapWithOrchestrationSimple()` from `src/tim/executors/claude_code/orchestrator_prompt.ts`. These tell the orchestrator to:
   - Use the `Task` tool with `subagent_type="tim-implementer"` for implementation
   - Use the `Task` tool with `subagent_type="tim-tester"` for testing
   - Run `tim review <planId> --print` via Bash for code review

3. **Agent Definitions**: Each agent is prefixed with `tim-` (e.g., `tim-implementer`, `tim-tester`) and includes the full context content, custom instructions from config, and role-specific prompts.

4. **Key constraint**: Under this model, all subagents run as Claude Code Task tool subagents — there's no way to use Codex for individual phases.

#### Codex CLI Executor Orchestration (existing, separate)

The Codex CLI executor (`src/tim/executors/codex_cli.ts`) has its own orchestration in `src/tim/executors/codex_cli/normal_mode.ts` and `simple_mode.ts`. These orchestrate programmatically in TypeScript:
- Calling `executeCodexStep()` from `src/tim/executors/codex_cli/codex_runner.ts` for each phase
- Each step builds a prompt using `getImplementerPrompt()`/`getTesterPrompt()` from the shared `agent_prompts.ts`
- Review is done via `runExternalReviewForCodex()` which calls `tim review`

This approach runs everything in Codex, with no option to use Claude for individual phases.

#### Tunneling Infrastructure

The tunneling system (`src/logging/tunnel_protocol.ts`, `tunnel_server.ts`, `tunnel_client.ts`) provides:
- Unix domain socket-based JSONL message forwarding
- `TIM_OUTPUT_SOCKET` environment variable to communicate socket path to child processes
- Automatic detection via `isTunnelActive()` — if already in a tunnel, child reuses parent's tunnel
- Used by both Claude Code and Codex executors to forward intermediate output while capturing final results

Both the review command (`src/tim/commands/review.ts`) and `codex_runner.ts` demonstrate the pattern:
1. Create tunnel server if not already in tunnel
2. Pass socket path via environment variable to child process
3. Child process sends output through tunnel
4. Final result goes to stdout for capture by the orchestrator

#### Agent Instructions System

Custom agent instructions can be configured in `src/tim/configSchema.ts`:
```yaml
agents:
  implementer:
    instructions: "path/to/file"  # Path to custom instructions file
  tester:
    instructions: "path/to/file"
  reviewer:
    instructions: "path/to/file"
```

For the Claude Code executor, these are loaded via `this.loadAgentInstructions()` (private method on ClaudeCodeExecutor).
For the Codex CLI executor, these are loaded via `loadAgentInstructionsFor()` from `src/tim/executors/codex_cli/agent_helpers.ts`.

#### Context Building

The execution prompt is built via `buildExecutionPromptWithoutSteps()` in `src/tim/prompt_builder.ts`, which assembles:
- Project context (from plan metadata)
- Parent plan context and sibling plans
- Task details (single task or batch of incomplete tasks)
- Plan file reference
- Relevant files
- Documentation URLs
- Execution guidelines

This is called from `src/tim/commands/agent/batch_mode.ts` (for batch mode) and `agent.ts` (for serial mode).

#### CLI Flag Pattern

The current `agent` command (defined in `src/tim/tim.ts` via `createAgentCommand()`) uses:
- `-x, --executor <name>`: Selects which executor runs everything (currently: direct-call, claude-code, copy-paste, copy-only, codex-cli)
- `--review-executor <name>`: Separate executor for review steps
- `-m, --model <model>`: Model override

In `src/tim/commands/agent/agent.ts`, executor selection follows: `options.executor || config.defaultExecutor || DEFAULT_EXECUTOR` (where DEFAULT_EXECUTOR is 'claude-code' from `src/tim/constants.ts`).

#### Config System

Configuration is loaded via `loadEffectiveConfig()` in `src/tim/configLoader.ts` with precedence: local override → repository config → global config → defaults. The merging logic handles arrays (concatenated) and objects (shallow merge, local overrides main). Key relevant config fields:
- `defaultExecutor`: Default executor for the main loop
- `agents`: Custom instructions for agent types
- `executors`: Per-executor options (e.g., `executors.claude-code.allowedTools`)

### Key Files That Need Changes

| File | Change |
|------|--------|
| `src/tim/commands/subagent.ts` | **NEW** - The `tim subagent` command implementation |
| `src/tim/tim.ts` | Register the new `subagent` command; modify `createAgentCommand()` flags |
| `src/tim/executors/claude_code/orchestrator_prompt.ts` | Update orchestration prompts to use `tim subagent` via Bash instead of Task tool |
| `src/tim/executors/claude_code.ts` | Conditionally skip `--agents` registration when using new subagent model; pass subagent executor info |
| `src/tim/commands/agent/agent.ts` | Handle new `--orchestrator` and `--executor` flags with new semantics |
| `src/tim/configSchema.ts` | Add `dynamicSubagentInstructions` config field |
| `src/tim/executors/claude_code/agent_generator.ts` | No change needed (still used for backwards compatibility if needed) |
| `src/tim/executors/claude_code/agent_prompts.ts` | No change needed (prompts are reused by the subagent command) |
| `src/tim/executors/types.ts` | Add subagent executor info to ExecutorCommonOptions |

### Architectural Decisions

1. **Subagent command output model**: The `tim subagent` command follows the same pattern as `tim review --print` — intermediate output goes through the tunnel to the terminal, while the final agent message is printed to stdout for the orchestrator to capture via Bash tool. Uses `--output-format stream-json` for the claude-code path so we can parse structured output and detect failures reliably.

2. **Context sharing**: The subagent command loads context directly from the plan file (given the plan ID). It loads the full plan context including all incomplete tasks. The orchestrator passes task-specific instructions (which tasks to focus on, context from previous phases) via `--input` flag. This keeps the Bash command invocation concise while giving the subagent full project context.

3. **Prompt composition**: The subagent command reuses the existing `getImplementerPrompt()` / `getTesterPrompt()` / `getVerifierAgentPrompt()` functions from `agent_prompts.ts` to build the base prompt, then appends the orchestrator's input as additional context.

4. **Backward compatibility**: Clean break on the `agent`/`run` command — `--executor` immediately gets new subagent-selection semantics, no deprecation period. Other commands (`review`, `generate`, `compact`) keep their current `-x, --executor` semantics unchanged.

5. **Scope**: Only the Claude Code orchestrator uses the new `tim subagent` approach. The Codex CLI executor keeps its existing TypeScript-level orchestration in `normal_mode.ts`/`simple_mode.ts`.

6. **Subagent types**: Three subagent types are supported: `implementer`, `tester`, and `verifier` (for simple mode). Each runs as a flat single-purpose agent with no nested subagents.

7. **Config independence**: `defaultOrchestrator` and `defaultExecutor` are completely independent. The `agent` command uses `defaultOrchestrator` (or DEFAULT_EXECUTOR if not set) for the main loop, NOT `defaultExecutor`. Other commands still use `defaultExecutor`.

8. **Dynamic mode fallback**: When `--executor dynamic` is used, the orchestrator must always choose. If the subagent command is invoked without `-x`, it defaults to `claude-code`.

### Edge Cases and Risks

1. **Prompt size**: The subagent command must reconstruct the full context (plan + parent context + task descriptions + custom instructions). This is the same context the orchestrator already has, so there's duplication. However, this is necessary because each subagent invocation is a fresh process.

2. **Dynamic mode decision quality**: When the orchestrator decides between claude and codex, it needs clear guidance. The default "prefer claude for frontend, codex for backend" is a starting heuristic, but users need to be able to override this per-project.

3. **Tunnel nesting**: When the orchestrator (Claude Code) runs `tim subagent` via Bash, and `tim subagent` sets up its own tunnel for the inner executor — we need to be careful not to create unnecessary tunnel layers. The inner process should detect the existing tunnel and reuse it.

4. **Error propagation**: If the subagent executor fails (codex crash, claude timeout), the error needs to propagate cleanly to the orchestrator's Bash tool output.

## Implementation Guide

### Step 1: Add Config Fields for Dynamic Mode Instructions

**File**: `src/tim/configSchema.ts`

Add a new `dynamicSubagentInstructions` field to the config schema. This is a simple string field that provides guidance for the orchestrator when choosing between claude and codex in dynamic mode.

```typescript
// Add to the timConfigSchema object, near the agents section:
dynamicSubagentInstructions: z
  .string()
  .optional()
  .describe('Instructions for the orchestrator when choosing between claude-code and codex-cli for subagent execution in dynamic mode')
```

Do NOT add a default value in the schema (per CLAUDE.md). The default "prefer claude for frontend, codex for backend" should be applied where the value is read.

Also add `defaultOrchestrator` and `defaultSubagentExecutor` fields:
```typescript
defaultOrchestrator: z
  .string()
  .optional()
  .describe('Default orchestrator to use for the agent command main loop')

defaultSubagentExecutor: z
  .enum(['codex-cli', 'claude-code', 'dynamic'])
  .optional()
  .describe('Default executor to use for subagents in the agent command (codex-cli, claude-code, or dynamic)')
```

### Step 2: Update Agent Command CLI Flags

**File**: `src/tim/tim.ts` (in `createAgentCommand()`)

Replace the existing `-x, --executor` with `--orchestrator` for the main loop executor, and add a new `-x, --executor` for the subagent executor:

```typescript
.option('--orchestrator <name>', 'The orchestrator executor to use for the main agent loop')
.option('-x, --executor <name>', 'Executor for subagents: codex-cli, claude-code, or dynamic (default: dynamic)')
.option('--dynamic-instructions <text>', 'Instructions for dynamic executor selection')
```

Update the help text accordingly. The available orchestrators are the same set as before (the existing executor names). The subagent executor values are: `codex-cli`, `claude-code`, `dynamic`.

This is a clean break — no backward compatibility for the old `--executor` meaning on the agent command. The `-x` flag immediately gets its new subagent-selection semantics.

**File**: `src/tim/commands/agent/agent.ts`

Update executor selection logic to handle the renamed flags:
- `options.orchestrator` (new) → selects which executor runs the main loop (fallback: `config.defaultOrchestrator || DEFAULT_EXECUTOR`). Note: does NOT fall back to `config.defaultExecutor` — the two are independent.
- `options.executor` (repurposed) → selects which executor runs subagents (fallback: `config.defaultSubagentExecutor` → 'dynamic')
- `options.dynamicInstructions` → dynamic mode instructions (fallback: `config.dynamicSubagentInstructions` → default string)
- Pass the subagent executor choice and dynamic instructions down to the executor via `ExecutorCommonOptions`.

### Step 3: Update ExecutorCommonOptions / ExecutePlanInfo

**File**: `src/tim/executors/types.ts`

Add fields to communicate the subagent executor selection:

```typescript
interface ExecutorCommonOptions {
  // ... existing fields
  subagentExecutor?: 'codex-cli' | 'claude-code' | 'dynamic';
  dynamicSubagentInstructions?: string;
}
```

This allows the ClaudeCodeExecutor to know which executor to tell the orchestrator to use for subagents.

### Step 4: Create the `tim subagent` Command

**File**: `src/tim/commands/subagent.ts` (NEW)

This is the core new command. It should:

1. Accept subcommands: `tim subagent implementer <planId>`, `tim subagent tester <planId>`, and `tim subagent verifier <planId>`
2. Accept flags:
   - `-x, --executor <name>`: Which executor to run the subagent in (codex-cli or claude-code, default: claude-code)
   - `-m, --model <model>`: Model override
   - `--input <text>`: Additional instructions from the orchestrator (what to work on)
3. Load the plan file and build context using `buildExecutionPromptWithoutSteps()` from `src/tim/prompt_builder.ts`
4. Build the subagent prompt using the appropriate function from `agent_prompts.ts`:
   - `implementer` → `getImplementerPrompt()`
   - `tester` → `getTesterPrompt()`
   - `verifier` → `getVerifierAgentPrompt()`
   Append the orchestrator's `--input` as additional context/custom instructions.
5. Execute using the selected executor:
   - If `codex-cli`: Use `executeCodexStep()` from `src/tim/executors/codex_cli/codex_runner.ts`
   - If `claude-code`: Spawn a claude code process using `--verbose --output-format stream-json --print`, with the full permissions setup (allowed tools, permissions MCP if configured, shared permissions). Parse the stream to extract the final agent message. Follow the pattern in `executeReviewMode()` in `claude_code.ts`.
6. Set up tunneling for intermediate output, following the exact same pattern as `codex_runner.ts`:
   - Check `isTunnelActive()` — if already in a tunnel, reuse it (the parent orchestrator's Claude Code session will already have set up a tunnel)
   - If not in a tunnel, create a tunnel server for forwarding output
   - Pass `TIM_OUTPUT_SOCKET` to the child process environment
7. Print the final agent message to stdout for the orchestrator to capture

The command implementation should closely follow the patterns in `codex_runner.ts` for the codex path and the `executeReviewMode()` method in `claude_code.ts` for the claude path. In both cases, tunneling is set up identically.

For loading agent custom instructions, use `loadAgentInstructionsFor()` from `src/tim/executors/codex_cli/agent_helpers.ts` (which works for both executor types).

To build the context, use the same pattern as `batch_mode.ts`:
1. `readPlanFile()` to load the plan
2. Create a minimal executor-like object (or use a lightweight wrapper) to satisfy `buildExecutionPromptWithoutSteps()`'s `executor` parameter
3. Call `buildExecutionPromptWithoutSteps()` with `batchMode: true`, `includeCurrentPlanContext: true`
4. The orchestrator's `--input` becomes the custom instructions parameter on the agent prompt function

For the progress guidance option on the subagent prompts, use `mode: 'report'` since the subagent should report back to the orchestrator rather than updating the plan file directly. Each subagent invocation is a flat, single-purpose agent with no nested subagents.

### Step 5: Register the Subagent Command in tim.ts

**File**: `src/tim/tim.ts`

Add command registration for `tim subagent`:

```typescript
const subagentCommand = program
  .command('subagent')
  .description('Run a subagent for the orchestrator');

// Register each subagent type (implementer, tester, verifier)
for (const agentType of ['implementer', 'tester', 'verifier']) {
  subagentCommand
    .command(`${agentType} <planFile>`)
    .description(`Run the ${agentType} subagent`)
    .option('-x, --executor <name>', 'Executor to use: codex-cli or claude-code', 'claude-code')
    .option('-m, --model <model>', 'Model to use')
    .option('--input <text>', 'Additional instructions from orchestrator')
    .action(async (planFile, options, command) => {
      const { handleSubagentCommand } = await import('./commands/subagent.js');
      await handleSubagentCommand(agentType, planFile, options, command.parent.parent.opts());
    });
}
```

Also add `Bash(tim subagent:*)` to the default allowed tools list in the Claude Code executor (`src/tim/executors/claude_code.ts`).

### Step 6: Update the Orchestrator Prompt

**File**: `src/tim/executors/claude_code/orchestrator_prompt.ts`

Modify `buildAvailableAgents()`, `buildWorkflowInstructions()`, and the simple variant to replace Task tool subagent invocations with Bash `tim subagent` commands.

The orchestration interface needs to change from:
```
Use the Task tool to invoke the implementer agent with subagent_type="tim-implementer"
```

To:
```
Run `tim subagent implementer <planId> -x <executor> --input "<instructions>"` via the Bash tool
```

Add `subagentExecutor` and `dynamicSubagentInstructions` to the `OrchestrationOptions` interface.

For **fixed executor** mode (codex-cli or claude-code):
- Tell the orchestrator to always pass `-x <executor>` to `tim subagent`
- Example: `tim subagent implementer 42 -x codex-cli --input "Work on task: Implement user auth"`

For **dynamic** mode:
- Include the dynamic instructions in the orchestrator prompt
- Tell the orchestrator to choose `-x codex-cli` or `-x claude-code` based on the nature of the task
- Include the configured instructions or the default "prefer claude for frontend, codex for backend"
- Example guidance: "Before invoking each subagent, decide which executor to use based on: [dynamic instructions]"

Update both `wrapWithOrchestration()` and `wrapWithOrchestrationSimple()`:
- `wrapWithOrchestration()` (normal mode): References `tim subagent implementer` and `tim subagent tester`, with `tim review` unchanged
- `wrapWithOrchestrationSimple()` (simple mode): References `tim subagent implementer` and `tim subagent verifier`

Key prompt changes:
- The "Available Agents" section changes from listing Task tool subagents to listing `tim subagent` commands
- The "Workflow Instructions" section changes from "Use the Task tool" to "Run via Bash"
- The "Important Guidelines" section updates to reference `tim subagent` instead of Task tool
- Add a "Subagent Executor Selection" section when in dynamic mode, with the instructions
- The orchestrator should be told that subagent output is captured from stdout, so it should use a sufficient Bash timeout (e.g., 30 minutes)
- Tell the orchestrator to include the `--input` flag with clear instructions about which tasks to work on and any relevant context from previous phases

### Step 7: Update ClaudeCodeExecutor to Skip Agent Registration

**File**: `src/tim/executors/claude_code.ts`

In the `execute()` method, when using the new subagent model (which should be the default now when `subagentExecutor` is set):
- Do NOT build `agentDefinitions` or pass `--agents` to Claude Code
- Instead, pass the subagent executor information to the orchestration prompt via the new `OrchestrationOptions` fields
- The orchestrator prompt will tell Claude to use `tim subagent` via Bash instead

The key change is in the section around line 1207-1289 where `agentDefinitions` are built. When using the new model, skip this entirely. The orchestrator prompt alone (modified in Step 6) handles everything.

### Step 8: Write Tests

**Test the subagent command**:
- Unit tests for prompt construction (verifying the correct prompt is built for implementer/tester)
- Test that the command correctly delegates to codex or claude based on `-x` flag
- Test tunneling setup and output capture

**Test the orchestrator prompt changes**:
- Verify the prompt includes `tim subagent` invocations instead of Task tool references
- Verify dynamic mode includes the instructions
- Verify fixed mode includes the correct `-x` flag

**Test the CLI flag changes**:
- Verify `--orchestrator` selects the main loop executor
- Verify `-x, --executor` selects the subagent executor
- Verify `--dynamic-instructions` overrides the config
- Verify config fallback chain works

**Test the config changes**:
- Verify `dynamicSubagentInstructions` loads from config
- Verify `defaultOrchestrator` loads from config

### Step 9: Update README

Document the new CLI flags and configuration options:
- The `--orchestrator` flag and its relationship to the old `--executor`
- The new `-x, --executor` semantics for subagent executor selection
- The `dynamic` mode and how to configure instructions
- The `dynamicSubagentInstructions` config field

### Manual Testing Steps

1. Run `tim agent <plan> --orchestrator claude-code -x codex-cli` — verify all subagents use codex
2. Run `tim agent <plan> --orchestrator claude-code -x claude-code` — verify all subagents use claude
3. Run `tim agent <plan> --orchestrator claude-code -x dynamic` — verify the orchestrator chooses per-task
4. Run `tim subagent implementer <plan> -x codex-cli --input "implement task 1"` — verify standalone subagent works
5. Run `tim subagent tester <plan> -x claude-code --input "test the implementation"` — verify standalone tester works
6. Verify intermediate output appears in the terminal via tunneling
7. Verify the orchestrator correctly captures the final message from subagents
8. Test with `--dynamic-instructions` CLI flag override
9. Test with `dynamicSubagentInstructions` in config file

### Acceptance Criteria

- [ ] `tim subagent implementer`, `tim subagent tester`, and `tim subagent verifier` commands work standalone
- [ ] Subagent commands correctly delegate to codex-cli or claude-code based on `-x` flag
- [ ] Intermediate output from subagents appears in terminal via tunneling
- [ ] Final subagent message is captured by the orchestrator (printed to stdout)
- [ ] `--orchestrator` flag selects main loop executor on agent command
- [ ] New `-x, --executor` flag selects subagent executor (codex-cli, claude-code, dynamic)
- [ ] Dynamic mode includes configurable instructions in the orchestrator prompt
- [ ] Config fields work: `defaultOrchestrator`, `defaultSubagentExecutor`, `dynamicSubagentInstructions`
- [ ] Config fallback chain: CLI flag → project config → global config → default
- [ ] Claude-code subagent path uses full permissions setup (allowed tools, permissions MCP)
- [ ] `tim review` continues to work unchanged
- [ ] Both normal mode (implementer → tester → review) and simple mode (implementer → verifier) updated
- [ ] All new code paths are covered by tests
- [ ] README updated with new CLI flags and configuration

### Dependencies & Constraints

- **Dependencies**: Relies on existing tunneling infrastructure (`tunnel_server.ts`, `tunnel_client.ts`), existing prompt building (`prompt_builder.ts`, `agent_prompts.ts`), existing executor infrastructure (`codex_runner.ts`, `claude_code.ts`)
- **Technical Constraints**: The subagent command must handle both codex and claude execution paths, each with different process spawning patterns. The `--input` flag may contain large text, so it should be robust to long strings (Commander.js handles this). The claude-code path needs full permissions setup including allowed-tools and permissions MCP.
- **Backward Compatibility**: Other commands (`review`, `generate`, `compact`) keep their existing `-x, --executor` semantics unchanged. Only `agent`/`run` gets the new flag structure. This is a clean break — no deprecation period for the old flag meaning.

## Current Progress
### Current State
- All 9 tasks are complete. The plan is done.
### Completed (So Far)
- Task 1: Added `defaultOrchestrator`, `defaultSubagentExecutor`, `dynamicSubagentInstructions` to config schema (no defaults per CLAUDE.md)
- Task 2: Added `subagentExecutor` and `dynamicSubagentInstructions` fields to `ExecutorCommonOptions` in types.ts
- Task 3: Replaced `-x/--executor` with `--orchestrator` for main loop in `createAgentCommand()`, repurposed `-x/--executor` for subagent selection with `.choices()` validation, added `--dynamic-instructions` flag. Updated `agent.ts` with correct fallback chains. Updated all existing tests to use `orchestrator` instead of `executor`.
- Task 4: Created `src/tim/commands/subagent.ts` with `handleSubagentCommand()` supporting implementer, tester, and verifier types. Loads plan context, builds subagent prompts with `mode: 'report'`, executes via codex-cli or claude-code with tunneling. Claude path includes full permissions MCP setup via extracted helper `src/tim/executors/claude_code/permissions_mcp_setup.ts`.
- Task 5: Registered `tim subagent` command in `tim.ts` with implementer/tester/verifier subcommands. Added `Bash(tim subagent:*)` to allowed tools in `claude_code.ts` (both executeReviewMode and execute methods). Subagent `-x/--executor` uses `.choices(['codex-cli', 'claude-code'])` validation.
- Task 6: Updated `orchestrator_prompt.ts` — added `subagentExecutor` and `dynamicSubagentInstructions` to `OrchestrationOptions`, replaced Task tool references with `tim subagent` Bash commands in both `wrapWithOrchestration()` and `wrapWithOrchestrationSimple()`. Added `buildSubagentExecutorFlag()` for fixed mode and `buildDynamicExecutorGuidance()` for dynamic mode. Added 30-minute timeout guidance.
- Task 7: Updated `claude_code.ts` — agent registration (`--agents` flag) is now always skipped in normal/simple orchestration modes since the prompt handles everything via `tim subagent`. Passed `subagentExecutor` and `dynamicSubagentInstructions` to orchestration prompt options.
- Task 8: Test coverage confirmed comprehensive — 222 tests pass across 5 test files (218 pass, 4 skip). Added 5 tunnel behavior tests for subagent command. Removed ~80 lines of dead code from claude_code.ts (unreachable normal/simple agent definition branches). Fixed orchestrator prompt wording inconsistency.
- Task 9: Updated README with new CLI flags (`--orchestrator`, repurposed `-x/--executor`, `--dynamic-instructions`), new config fields (`defaultOrchestrator`, `defaultSubagentExecutor`, `dynamicSubagentInstructions`), `tim subagent` command documentation, and complete command reference updates.
### Remaining
- None
### Next Iteration Guidance
- None — all tasks complete
### Decisions / Changes
- Used Commander `.choices()` for `-x/--executor` validation rather than runtime checks in agent.ts
- `defaultOrchestrator` is independent from `defaultExecutor` — agent command falls back to `config.defaultOrchestrator || DEFAULT_EXECUTOR`, not `config.defaultExecutor`
- Default dynamic instructions: "Prefer claude-code for frontend tasks, codex-cli for backend tasks."
- Extracted permissions MCP setup into shared helper `permissions_mcp_setup.ts` for reuse between ClaudeCodeExecutor and subagent command
- Codex path does not support `--model` flag (codex uses its own default model); silently ignored with debug log
- Subagent `-x` choices are `['codex-cli', 'claude-code']` only — `dynamic` is not valid for subagent (only for orchestrator)
- Agent registration (`--agents`) is always skipped in normal/simple orchestration modes — gated on `planContextAvailable && (executionMode === 'normal' || 'simple')` rather than `!!subagentExecutor`, avoiding inconsistency when `subagentExecutor` is undefined
- Removed dead code: old agent definition building in execute() was unreachable after task 7 changes. Also removed `loadAgentInstructions` private method and unused `originalContextContent` variable.
### Risks / Blockers
- None
