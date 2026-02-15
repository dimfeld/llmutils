---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: agent chat mode
goal: ""
id: 198
uuid: c57b1832-2630-4c52-b61f-77aa17361eec
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-02-15T10:18:09.589Z
promptsGeneratedAt: 2026-02-15T10:18:09.589Z
createdAt: 2026-02-15T09:31:14.223Z
updatedAt: 2026-02-15T11:03:13.507Z
tasks:
  - title: Add 'chat' to headless command type
    done: true
    description: Update `src/tim/headless.ts` to add `'chat'` to the command union
      type used in `RunWithHeadlessOptions.command`,
      `CreateHeadlessAdapterOptions.command`, and `buildHeadlessSessionInfo()`.
      Also update `src/logging/headless_protocol.ts` if
      `HeadlessSessionInfo.command` is defined there. Run type check to verify
      no compile errors.
  - title: Support optional initial prompt in executor and terminal input lifecycle
    done: true
    description: >-
      Make the `prompt` parameter optional throughout the executor chain:


      1. In `src/tim/executors/types.ts`, change `Executor.execute()` signature
      from `(contextContent: string, ...)` to `(contextContent: string |
      undefined, ...)`.

      2. In `src/tim/executors/claude_code/terminal_input_lifecycle.ts`:
         - Change `prompt: string` to `prompt?: string` in `TerminalInputLifecycleOptions` and `ExecuteWithTerminalInputOptions`.
         - In `setupTerminalInput()`, conditionally call `sendInitialPrompt()` only when `prompt` is provided.
         - In `executeWithTerminalInput()`, update the three paths: terminal input path skips `sendInitialPrompt()` (first user line goes via `sendFollowUpMessage()`); tunnel forwarding path skips `sendInitialPrompt()`; single prompt path errors if no prompt provided.
      3. In `src/tim/executors/claude_code.ts`, update
      `ClaudeCodeExecutor.execute()` to accept `string | undefined` and pass
      through to `executeWithTerminalInput()`.

      4. In `src/tim/executors/codex_cli.ts`, update
      `CodexCliExecutor.execute()` to accept `string | undefined` and error if
      prompt is undefined (Codex requires a prompt).

      5. Update other executor implementations (one-call, copy_paste, copy_only)
      to accept the updated signature.

      6. Add tests verifying the no-prompt behavior in the terminal input
      lifecycle.


      This change is backward-compatible: all existing callers pass a string.
  - title: Create the chat command handler
    done: true
    description: >-
      Create `src/tim/commands/chat.ts` with `handleChatCommand()`. Follow the
      structure of `generate.ts` but simpler:


      1. Load config via `loadEffectiveConfig(globalOpts.config)`

      2. Resolve executor name from `--executor` flag or config default

      3. Resolve optional initial prompt from positional arg, `--prompt-file`,
      or stdin (reuse `resolvePromptText()` pattern from `run_prompt.ts`, but
      don't error if no prompt provided)

      4. Compute terminal input settings (same pattern as generate.ts lines
      206-211)

      5. Build executor with `buildExecutorAndLog()` with `terminalInput: true`
      (unless `--non-interactive`), `closeTerminalInputOnResult: false`,
      `executionMode: 'bare'`

      6. Validate: if no prompt AND non-interactive mode, error out

      7. Wrap execution in `runWithHeadlessAdapterIfEnabled()` with `command:
      'chat'`

      8. Call `executor.execute(prompt, { planId: 'chat', planTitle: 'Chat
      Session', planFilePath: '', executionMode: 'bare' })`


      No plan file reading, no task creation checking, no follow-up prompts, no
      workspace setup.
  - title: Register the chat command in tim.ts
    done: true
    description: >-
      Add command registration in `src/tim/tim.ts`:


      ```

      program
        .command('chat [prompt]')
        .description('Start an interactive LLM session without a plan')
        .option('-x, --executor <name>', 'Executor to use (claude-code or codex-cli)')
        .option('-m, --model <model>', 'Model to use')
        .option('--prompt-file <path>', 'Read initial prompt from a file')
        .option('--non-interactive', 'Disable interactive terminal input')
        .option('--no-terminal-input', 'Disable terminal input forwarding')
        .action(async (prompt, options, command) => {
          const { handleChatCommand } = await import('./commands/chat.js');
          await handleChatCommand(prompt, options, command.parent.opts()).catch(handleCommandError);
        });
      ```
  - title: Write tests for chat command
    done: true
    description: >-
      Create `src/tim/commands/chat.test.ts` with tests covering:

      - Command resolves executor correctly (defaults to claude-code)

      - Optional initial prompt handling (with and without prompt)

      - Terminal input is enabled by default

      - `closeTerminalInputOnResult` is set to `false`

      - Execution mode is `'bare'`

      - Headless adapter integration

      - Error when no prompt AND non-interactive mode


      Focus on verifying correct options are passed to the executor and edge
      case handling.
  - title: Update README documentation
    done: true
    description: >-
      Add documentation for the new `tim chat` command to the README covering:

      - Purpose and use cases (interactive LLM session without a plan, Tim-GUI
      integration)

      - Command-line options (`--executor`, `--model`, `--prompt-file`,
      `--non-interactive`, `--no-terminal-input`)

      - Examples: `tim chat`, `tim chat "Help me with X"`, `tim chat
      --prompt-file prompt.txt`

      - Note that session persistence is enabled by default

      - Limitations: Codex terminal input not yet supported
changedFiles:
  - CLAUDE.md
  - README.md
  - src/logging/console_formatter.ts
  - src/tim/commands/chat.test.ts
  - src/tim/commands/chat.ts
  - src/tim/commands/prompt_input.ts
  - src/tim/commands/run_prompt.ts
  - src/tim/executors/claude_code/terminal_input_lifecycle.test.ts
  - src/tim/executors/claude_code/terminal_input_lifecycle.ts
  - src/tim/executors/claude_code.ts
  - src/tim/executors/codex_cli.ts
  - src/tim/executors/copy_only.ts
  - src/tim/executors/copy_paste.ts
  - src/tim/executors/one-call.ts
  - src/tim/executors/types.ts
  - src/tim/headless.ts
  - src/tim/tim.ts
tags: []
---

This is a tim command that just executes Claude or Codex and lets the user type. Similar to the generate command, we want the terminal to stay open even after the first result. Codex doesn't support terminal input yet, but it will in the future.

The main purpose of this is not actually to be used on the terminal, but for integration with Tim-GUI in a later phase.

## Research

### Overview

The "agent chat mode" is a new tim command (`tim chat`) that directly spawns a Claude Code or Codex subprocess and forwards the user's input to it. Unlike `tim agent` (which loops through plan tasks) or `tim generate` (which sends a plan-generation prompt), chat mode has no plan-driven prompt — the user provides all input interactively. The terminal stays open after each result, allowing multi-turn conversation. The primary use case is Tim-GUI integration, but it also works on the terminal.

### Key Findings

#### Product & User Story
- **Who**: Developers using tim, and Tim-GUI integration
- **What**: A command that starts an LLM subprocess (Claude Code or Codex) without plan context, forwarding user input directly
- **Why**: Provides a thin, managed wrapper around LLM execution that integrates with tim's headless adapter, tunnel infrastructure, and permissions — without requiring a plan file
- **Analogy**: Like `tim generate` but without any initial prompt, and where the user provides all conversation content

#### Design & UX Approach
- **Terminal UX**: User runs `tim chat`. The terminal shows a prompt indicator. User types messages, presses Enter, and sees LLM responses streamed back. Ctrl+D or Ctrl+C ends the session.
- **Tim-GUI UX**: Tim-GUI connects via the headless adapter WebSocket. It sends user messages through the tunnel, receives structured output back. The chat command acts as a managed LLM session.
- **No plan required**: The command accepts an optional initial prompt (positional arg, `--prompt-file`, or stdin) but doesn't require one. Without an initial prompt, the session starts and waits for user input.

#### Technical Plan & Risks
- **Low risk**: This is a thin orchestration layer reusing existing infrastructure (executor, terminal input, headless adapter)
- **Main complexity**: Handling the case of no initial prompt — the existing `executeWithTerminalInput` assumes an initial prompt is always sent. We need to handle the "start with empty prompt" case.
- **Codex limitation**: Codex CLI doesn't support terminal input yet. The command should work with Codex for single-prompt usage but warn or error if terminal input is attempted with Codex.

#### Pragmatic Effort Estimate
- Small to medium scope. The command is primarily wiring together existing components.

### Notable Files, Modules, and Patterns

#### Command Registration Pattern (`src/tim/tim.ts`)
- Commands are registered via Commander.js with `.command()`, `.option()`, and `.action()`
- Handlers use dynamic imports: `await import('./commands/chat.js')`
- The `createAgentCommand()` helper (lines 527-603) shows how to share options between agent/run — we don't need this complexity for chat
- All commands accept global `--config` and `--debug` options via `command.parent.opts()`

#### Generate Command (`src/tim/commands/generate.ts`)
- Most similar to chat in structure (single executor invocation, terminal stays open)
- Key pattern: Sets `closeTerminalInputOnResult: false` to keep terminal open after first result
- Uses `executionMode: 'planning'` — chat should use `executionMode: 'bare'`
- Wraps execution in `runWithHeadlessAdapterIfEnabled()` for headless adapter support
- Uses `buildExecutorAndLog()` to create the executor

#### Executor System (`src/tim/executors/`)
- `ExecutorCommonOptions` interface defines shared options including `terminalInput`, `closeTerminalInputOnResult`, `noninteractive`
- `ExecutePlanInfo` requires `planId`, `planTitle`, `planFilePath`, and `executionMode` — for chat, we'll use synthetic/empty values
- The `'bare'` execution mode skips orchestration and is the right mode for chat
- `buildExecutorAndLog()` in `src/tim/executors/build.ts` creates executor instances from name + options

#### Claude Code Executor (`src/tim/executors/claude_code.ts`)
- The `execute()` method (line 740) handles all execution modes
- For `bare` mode, it skips orchestration wrapping (lines 765-792 only wrap for normal/simple/tdd)
- Still sets up permissions MCP, tunnel server, terminal input — all of which chat needs
- The `executeWithTerminalInput()` call (line 1004) handles the three-path branching

#### Terminal Input Lifecycle (`src/tim/executors/claude_code/terminal_input_lifecycle.ts`)
- `executeWithTerminalInput()` is the key function — handles terminal input, tunnel forwarding, and single-prompt paths
- `setupTerminalInput()` (line 57) calls `sendInitialPrompt()` then starts `TerminalInputReader`
- **Important**: `sendInitialPrompt()` always sends a prompt message. For chat with no initial prompt, we need a way to start without sending anything, or send an empty/minimal prompt.
- `closeOnResultMessage` parameter controls whether stdin closes after first result — set to `false` for chat

#### Headless Adapter (`src/tim/headless.ts`)
- `runWithHeadlessAdapterIfEnabled()` wraps execution with WebSocket streaming to Tim-GUI
- `buildHeadlessSessionInfo()` creates session metadata — we should add `'chat'` to the command union type
- The headless adapter needs a command type — currently supports `'agent' | 'review' | 'run-prompt' | 'generate'`

#### Run Prompt Command (`src/tim/commands/run_prompt.ts`)
- Simpler single-shot command that spawns Claude/Codex and returns result
- Uses `spawnAndLogOutput` (fire-and-forget) rather than `spawnWithStreamingIO` (interactive)
- Not directly reusable for chat since it doesn't support terminal input, but shows the pattern for executor-agnostic command structure

### Architectural Considerations

1. **No initial prompt**: The `sendInitialPrompt()` function in `streaming_input.ts` always writes a prompt to stdin. For chat mode where the user might not provide an initial prompt, we need to modify the terminal input lifecycle to support an optional initial prompt. When no prompt is provided, the subprocess is spawned but nothing is written to stdin until the user types their first message. The first user line is then sent via `sendFollowUpMessage()` (which uses the same message format as `sendInitialPrompt()`). This requires making the `prompt` parameter optional in `setupTerminalInput()` and `executeWithTerminalInput()`, and conditionally skipping the `sendInitialPrompt()` call.

2. **Executor abstraction layer**: Chat should use the `ClaudeCodeExecutor` directly for Claude, but doesn't need the full executor abstraction since it's always running in `bare` mode. However, using the executor gives us permissions MCP, tunnel server, and terminal input for free. The tradeoff is that `ExecutePlanInfo` requires plan metadata we don't have. Using synthetic values (`planId: 'chat'`, `planTitle: 'Chat Session'`, `planFilePath: ''`) is acceptable since `bare` mode doesn't reference plan data. The `Executor.execute()` signature needs to change from `(contextContent: string, ...)` to `(contextContent: string | undefined, ...)` to support the no-initial-prompt case. Existing callers always pass a string, so this is backward-compatible.

3. **Codex support**: The `CodexCliExecutor` doesn't support terminal input. For chat, Codex would only work in single-prompt mode (user provides prompt via arg/file/stdin). We should document this limitation and potentially error if terminal input is requested with Codex.

4. **Headless command type**: The `RunWithHeadlessOptions.command` type is `'agent' | 'review' | 'run-prompt' | 'generate'`. We need to add `'chat'` to this union. This also affects `buildHeadlessSessionInfo()` and `HeadlessSessionInfo.command`.

## Implementation Guide

### Step 1: Add 'chat' to headless command type

Update `src/tim/headless.ts` to add `'chat'` to the command union type. This is used in:
- `RunWithHeadlessOptions.command`
- `CreateHeadlessAdapterOptions.command`
- `buildHeadlessSessionInfo()` parameter
- Also update `src/logging/headless_protocol.ts` if the `HeadlessSessionInfo` type is defined there

### Step 2: Support optional initial prompt in terminal input lifecycle

Modify `src/tim/executors/claude_code/terminal_input_lifecycle.ts` to make the `prompt` parameter optional:

1. In `TerminalInputLifecycleOptions`, change `prompt: string` to `prompt?: string`
2. In `setupTerminalInput()`, conditionally call `sendInitialPrompt()` only when `prompt` is provided
3. In `ExecuteWithTerminalInputOptions`, change `prompt: string` to `prompt?: string`
4. In `executeWithTerminalInput()`, update all three paths to handle the no-prompt case:
   - **Terminal input path**: Skip `sendInitialPrompt()`, just start the reader. The first user line is sent via `sendFollowUpMessage()` which uses the same JSON message format.
   - **Tunnel forwarding path**: Skip `sendInitialPrompt()`, wait for tunnel input.
   - **Single prompt path**: This path requires a prompt — if none provided and terminal input is disabled, this is an error (the caller should prevent this).
5. Add tests to `terminal_input_lifecycle.test.ts` (or create one if it doesn't exist) verifying the no-prompt behavior.

This change is backward-compatible: all existing callers pass a prompt, so their behavior is unchanged.

### Step 3: Create the chat command handler

Create `src/tim/commands/chat.ts` with `handleChatCommand()`. This should:

1. Load config via `loadEffectiveConfig(globalOpts.config)`
2. Resolve the executor name from `--executor` flag or config default
3. Resolve optional initial prompt from positional arg, `--prompt-file`, or stdin (reuse `resolvePromptText()` pattern from `run_prompt.ts`, but make it optional — don't error if no prompt provided)
4. Compute terminal input settings (same pattern as generate.ts lines 206-211)
5. Build executor with `buildExecutorAndLog()`:
   - `terminalInput: true` (unless `--non-interactive`)
   - `closeTerminalInputOnResult: false` (keep terminal open)
   - `executionMode: 'bare'`
6. Pass the resolved prompt (or undefined if none) to `executor.execute()`
7. Wrap execution in `runWithHeadlessAdapterIfEnabled()` with `command: 'chat'`
8. Call `executor.execute(prompt, { planId: 'chat', planTitle: 'Chat Session', planFilePath: '', executionMode: 'bare' })`
9. Validate: if no prompt AND non-interactive mode, error out (nothing to do)

The structure should closely follow `generate.ts` but be simpler — no plan file reading, no task creation checking, no follow-up prompts, no workspace setup.

### Step 4: Register the command in tim.ts

Add the command registration in `src/tim/tim.ts`:

```
program
  .command('chat [prompt]')
  .description('Start an interactive LLM session without a plan')
  .option('-x, --executor <name>', 'Executor to use (claude-code or codex-cli)')
  .option('-m, --model <model>', 'Model to use')
  .option('--prompt-file <path>', 'Read initial prompt from a file')
  .option('--non-interactive', 'Disable interactive terminal input')
  .option('--no-terminal-input', 'Disable terminal input forwarding')
  .action(async (prompt, options, command) => {
    const { handleChatCommand } = await import('./commands/chat.js');
    await handleChatCommand(prompt, options, command.parent.opts()).catch(handleCommandError);
  });
```

### Step 5: Write tests

Create `src/tim/commands/chat.test.ts` with tests covering:
- Command resolves executor correctly (defaults to claude-code)
- Optional initial prompt handling (with and without prompt)
- Terminal input is enabled by default
- `closeTerminalInputOnResult` is set to `false`
- Execution mode is `'bare'`
- Headless adapter integration

Since the chat command is primarily wiring together existing tested components, the tests should focus on verifying the correct options are passed to the executor and that the command handles edge cases (no prompt, non-interactive mode, etc.).

### Step 6: Update README documentation

Add documentation for the new `tim chat` command to the README, covering:
- Purpose and use cases
- Command-line options
- Examples (interactive session, with initial prompt)
- Limitations (Codex terminal input not yet supported)

### Manual Testing Steps

1. Run `tim chat` with no arguments — should start interactive session, accept typed input
2. Run `tim chat "Hello, help me with X"` — should start session with initial prompt
3. Run `tim chat --prompt-file prompt.txt` — should read prompt from file
4. Type a message after first result — should send follow-up to Claude
5. Press Ctrl+D — should end session gracefully
6. Press Ctrl+C — should end session and clean up resources
7. Run with `--non-interactive` and a prompt — should execute single prompt and exit

### Rationale for Approach

- **Reusing executor infrastructure**: Rather than spawning Claude directly (like `run-prompt` does), using the executor gives us permissions MCP, tunnel server, terminal input management, and output formatting for free.
- **`bare` execution mode**: This is the right mode because chat needs no orchestration, no plan context, and no workflow wrapping.
- **Deferred first message**: When no initial prompt is provided, nothing is sent to the subprocess until the user types their first message. This avoids polluting the conversation with a synthetic system prompt and requires only a small change to make `prompt` optional in the terminal input lifecycle.
- **No workspace**: Chat mode runs in the current directory. Workspace isolation is not needed since there's no plan to coordinate.
- **Session persistence**: The main `ClaudeCodeExecutor` does not pass `--no-session-persistence` (unlike subagents and `run-prompt`), so `tim chat` inherits session persistence by default. This allows users to resume previous conversations, which is natural for a chat-style command. No changes needed.

## Current Progress
### Current State
- All 6 tasks are complete. The plan is fully implemented, tested, and documented.

### Completed (So Far)
- Added 'chat' to headless command union type in headless.ts
- Made prompt optional throughout executor chain (types.ts, claude_code.ts, codex_cli.ts, copy_only.ts, copy_paste.ts, one-call.ts)
- Updated terminal_input_lifecycle.ts to handle no-prompt case in all three paths (terminal input, tunnel, single prompt)
- Created chat command handler in src/tim/commands/chat.ts with full integration (config, executor, prompt resolution, headless adapter)
- Registered chat command in tim.ts with all CLI options
- Extracted shared prompt resolution logic into src/tim/commands/prompt_input.ts (resolveOptionalPromptInput)
- Updated run_prompt.ts to use the shared helper
- Created comprehensive test suite in chat.test.ts (17 tests) and added terminal_input_lifecycle tests
- All type checks pass, all tests pass (3213+)
- README and CLAUDE.md updated with tim chat documentation (TOC, main section, command reference)

### Remaining
- None

### Next Iteration Guidance
- None — plan is complete

### Decisions / Changes
- Prompt precedence for chat: positional prompt > stdin > (nothing). This differs slightly from run-prompt (file > stdin > positional) because for chat, `echo context | tim chat "Do something"` is a natural pattern
- Prompt file always has highest priority across both commands
- Codex is rejected early when interactive input is expected (terminal input OR tunnel+no prompt)
- Tunnel-active state is checked to allow no-prompt sessions in Tim-GUI mode
- Shared prompt resolution extracted to prompt_input.ts to avoid code duplication

### Lessons Learned
- When making prompt optional, stdin reading in non-TTY environments needs careful handling — unconditionally reading stdin can cause hangs when no input is piped
- Tunnel forwarding is an interactive input source that must be considered alongside terminal input in validation guards
- Prompt precedence is context-dependent — what makes sense for run-prompt (stdin > positional) may not be right for chat (positional > stdin)
- Review caught that the Codex guard only checked terminalInputEnabled but not tunnelActive, which would have broken Tim-GUI integration

### Risks / Blockers
- The 2-minute initialInactivityTimeoutMs in claude_code.ts could kill chat sessions where the user hasn't typed anything yet. This is pre-existing behavior but newly relevant for chat. Consider making it configurable in the future.
