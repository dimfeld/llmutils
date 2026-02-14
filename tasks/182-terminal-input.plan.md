---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Terminal input
goal: Add interactive terminal input support during Claude Code execution via
  tim agent, allowing users to send additional messages to the running agent
id: 182
uuid: 3117183c-8d14-46bd-b4bd-2c4865522c32
generatedBy: agent
status: done
priority: medium
dependencies:
  - 178
references:
  "178": 8970382a-14d8-40e2-9fda-206b952d2591
planGeneratedAt: 2026-02-14T08:59:16.311Z
promptsGeneratedAt: 2026-02-14T08:59:16.311Z
createdAt: 2026-02-13T06:49:27.274Z
updatedAt: 2026-02-15T04:33:54.274Z
tasks:
  - title: Add multi-message streaming input functions
    done: true
    description: Modify `src/tim/executors/claude_code/streaming_input.ts` to add
      `sendInitialPrompt()` (sends prompt without closing stdin),
      `sendFollowUpMessage()` (writes additional message to stdin), and
      `closeStdinAndWait()` (closes stdin and awaits process result). Keep
      existing `sendSinglePromptAndWait()` for backward compatibility. Add unit
      tests for the new functions.
  - title: Create TerminalInputReader class
    done: true
    description: >-
      Create `src/tim/executors/claude_code/terminal_input.ts` with a
      `TerminalInputReader` class that:

      - Uses `node:readline` interface on `process.stdin` for line-based input

      - Accepts a callback that receives each line (called when user presses
      Enter)

      - Has `start()`, `stop()`, `pause()`, `resume()` lifecycle methods

      - `pause()` closes/pauses readline and saves any partially-typed input

      - `resume()` recreates readline and restores saved partial input

      - Only activates when `process.stdin.isTTY` is true

      - Handles process exit / FileSink errors gracefully (try/catch on writes)

      - Exports a module-level `getActiveTerminalInputReader()` function for use
      by prompt coordination


      Add unit tests covering start/stop, pause/resume with partial input
      preservation, and callback invocation.
  - title: Add structured message type for user terminal input
    done: true
    description: "Add a `user_terminal_input` structured message type to
      `src/logging/structured_messages.ts` with fields: `type`, `timestamp`,
      `content` (the user's message text). Also add tunnel server validation for
      this message type in `src/logging/tunnel_server.ts`."
  - title: Integrate terminal input into main Claude Code executor
    done: true
    description: >-
      Modify `src/tim/executors/claude_code.ts` execute() method:

      - Replace `sendSinglePromptAndWait()` call with `sendInitialPrompt()` +
      terminal input reader

      - When terminal input is enabled: create TerminalInputReader, on each
      line: write to Claude Code stdin via `sendFollowUpMessage()`, echo
      visually ('→ You: <message>'), emit `user_terminal_input` structured
      message, and send through tunnel if active

      - When result message is seen or process exits: stop reader, call
      `closeStdinAndWait()`

      - When terminal input is disabled: fall back to
      `sendSinglePromptAndWait()` (existing behavior)

      - Print hint message ('Type a message and press Enter to send input to the
      agent') when terminal input starts

      - Add `terminalInput` option to `ExecutorCommonOptions` in
      `src/tim/executors/types.ts`
  - title: Integrate terminal input into run_claude_subprocess.ts
    done: true
    description: "Add `terminalInput?: boolean` option to
      `RunClaudeSubprocessOptions` in
      `src/tim/executors/claude_code/run_claude_subprocess.ts`. When enabled,
      use `sendInitialPrompt()` + TerminalInputReader pattern instead of
      `sendSinglePromptAndWait()`. Default to false for subagent execution
      (orchestrator-driven), configurable for review mode."
  - title: Add prompt/input coordination in input.ts
    done: true
    description: >-
      Modify `src/common/input.ts` to coordinate terminal input reader with
      inquirer prompts:

      - Import `getActiveTerminalInputReader()` from terminal_input module

      - Before each inquirer prompt call, pause the active terminal input reader
      (if any)

      - After each prompt resolves (in finally block), resume the reader

      - This applies to all four prompt functions: `promptConfirm()`,
      `promptSelect()`, `promptInput()`, `promptCheckbox()`

      - Test that partially-typed input is preserved across a prompt
      pause/resume cycle
  - title: Add tunnel protocol support for user input
    done: true
    description: >-
      Extend the tunnel protocol for user input forwarding:

      1. In `src/logging/tunnel_protocol.ts`: add `TunnelUserInputMessage` type
      (`{ type: 'user_input', content: string }`), add to `ServerTunnelMessage`
      union

      2. In `src/logging/tunnel_server.ts`: add `sendUserInput(content: string)`
      method to `TunnelServer` that writes the message as JSONL to all connected
      client sockets

      3. In `src/logging/tunnel_client.ts`: handle incoming `user_input`
      messages, add `onUserInput(callback)` method or event listener pattern

      4. Extend `src/logging/tunnel_integration.test.ts` with tests for the new
      `user_input` message type flowing from server to client
  - title: Wire tunnel input forwarding in executors
    done: true
    description: >-
      Connect terminal input to tunnel forwarding in the executor layer:

      - In the main executor (`claude_code.ts`): when terminal input callback
      fires, also call `tunnelServer.sendUserInput(content)` if a tunnel server
      exists

      - In tunnel client handling: register a `user_input` handler on the
      TunnelAdapter that writes received input to the Claude Code subprocess
      stdin via `sendFollowUpMessage()`

      - This enables the flow: top-level user types → parent reads → forwards
      through tunnel → child writes to Claude Code stdin
  - title: Add CLI option and configuration
    done: true
    description: Add `--no-terminal-input` flag to the `tim agent` command in
      `src/tim/commands/agent/agent.ts`. Wire the option through to
      `ExecutorCommonOptions.terminalInput`. Default to `true` when
      `process.stdin.isTTY` is true and not in noninteractive mode. Consider
      also adding a `terminalInput` option in `configSchema.ts` for persistent
      configuration.
  - title: Handle batch mode lifecycle
    done: true
    description: >-
      Ensure terminal input reader is properly managed in batch mode
      (`src/tim/commands/agent/batch_mode.ts`):

      - Reader is created fresh for each batch iteration (each Claude Code
      subprocess)

      - Reader is stopped and cleaned up between iterations

      - Partial input from one iteration is NOT carried to the next

      - Process.stdin is properly unref'd/paused after reader stops to allow
      event loop to proceed
  - title: "Address Review Feedback: `common` now has a hard dependency on a `tim`
      executor module."
    done: true
    description: >-
      `common` now has a hard dependency on a `tim` executor module.
      `src/common/input.ts` imports
      `../tim/executors/claude_code/terminal_input.js`
      (`src/common/input.ts:12`), which inverts module layering (feature modules
      should depend on `common`, not the other way around) and couples all
      `common/input` users to `tim` internals.


      Suggestion: Move terminal-input pause/resume coordination behind a
      `common`-owned abstraction (registry/hook in `src/common/`) and let Claude
      executor register/unregister there.


      Related file: src/common/input.ts:12
  - title: "Address Review Feedback: Uncaught synchronous exceptions from
      `stdin.end()` can crash the execution path."
    done: true
    description: >-
      Uncaught synchronous exceptions from `stdin.end()` can crash the execution
      path. The close helpers are trying to swallow close errors but use
      `Promise.resolve(streaming.stdin.end()).catch(...)` in
      `src/tim/executors/claude_code.ts:1024`,
      `src/tim/executors/claude_code/run_claude_subprocess.ts:455`, and
      `src/tim/executors/claude_code/terminal_input_lifecycle.ts:35`. If `end()`
      throws synchronously, that throw occurs before `Promise.resolve` and
      bypasses `.catch`, so result handling/cleanup can fail unexpectedly.


      Suggestion: Wrap `end()` in `try/catch` and separately handle async
      rejection, e.g. call `const endResult = streaming.stdin.end()` inside
      `try`, then `Promise.resolve(endResult).catch(...)`, or use
      `Promise.resolve().then(() => streaming.stdin.end()).catch(...)`.


      Related file: src/tim/executors/claude_code.ts:1024
  - title: "Address Review Feedback: withTerminalInputPaused pauses the reader
      captured at function entry but resumes whatever reader is active at
      function exit."
    done: true
    description: >-
      withTerminalInputPaused pauses the reader captured at function entry but
      resumes whatever reader is active at function exit. The function calls
      getActiveTerminalInputReader() twice: once at the beginning to pause() and
      once in the finally block to resume(). If the reader changes between these
      two calls (e.g., the old reader was stopped and a new one started during
      the prompt), resume() would be called on a different reader. In practice
      this is harmless because (a) a new reader shouldn't be started while a
      prompt is active and (b) resume() on a non-paused reader is a no-op. But
      the asymmetry is worth noting for maintainability.


      Suggestion: Consider storing the reader reference and calling resume() on
      the same reader that was paused, or add a comment explaining why the
      re-fetch is intentional.


      Related file: src/common/input.ts:99-107
  - title: "Address Review Feedback: Terminal input is not paused for
      tunnel-rendered inquirer prompts, violating the prompt/input coordination
      requirement and creating stdin contention."
    done: true
    description: >-
      Terminal input is not paused for tunnel-rendered inquirer prompts,
      violating the prompt/input coordination requirement and creating stdin
      contention. The new pause/resume logic is only wired through
      `src/common/input.ts` (`withTerminalInputPaused`), but tunnel prompt
      handling still calls `@inquirer/prompts` directly in
      `src/logging/tunnel_prompt_handler.ts`. This path is active during
      nested/tunneled execution because executors register
      `createPromptRequestHandler()` (`src/tim/executors/claude_code.ts` and
      `src/tim/executors/claude_code/run_claude_subprocess.ts`) while terminal
      input can be active. Result: user keystrokes can race between the terminal
      input reader and the prompt, causing prompt answers to be misrouted as
      follow-up Claude messages or partial-input corruption.


      Suggestion: Pause/resume the active input source inside tunnel prompt
      handling, using the common registry abstraction
      (`src/common/input_pause_registry.ts`) before and after each inquirer
      call. Alternatively, route tunnel prompt rendering through a shared prompt
      helper that already applies pause/resume semantics. Ensure the same reader
      instance is resumed.


      Related file: src/logging/tunnel_prompt_handler.ts:1
  - title: "Address Review Feedback: Both claude_code.ts (lines 939-1080) and
      run_claude_subprocess.ts (lines 329-509) contain nearly identical code for
      terminal input wiring: setting up terminalInputEnabled,
      tunnelForwardingEnabled, terminalInputController, stdinClosed, closeStdin,
      clearTunnelUserInputHandler variables; wiring the tunnel user input
      handler; the three execution paths (terminal input / tunnel forwarding /
      single prompt); and the onReaderError callback."
    done: true
    description: >-
      Both claude_code.ts (lines 939-1080) and run_claude_subprocess.ts (lines
      329-509) contain nearly identical code for terminal input wiring: setting
      up terminalInputEnabled, tunnelForwardingEnabled, terminalInputController,
      stdinClosed, closeStdin, clearTunnelUserInputHandler variables; wiring the
      tunnel user input handler; the three execution paths (terminal input /
      tunnel forwarding / single prompt); and the onReaderError callback. If a
      bug is found in one path, it's easy to forget to fix the other.


      Suggestion: Consider extracting the common tunnel handler wiring and
      three-path branching into a shared helper in terminal_input_lifecycle.ts,
      accepting the differences (error messages, logging context) as parameters.
      This would reduce the risk of the two paths drifting apart.


      Related file: src/tim/executors/claude_code.ts:939-1080
changedFiles:
  - CLAUDE.md
  - README.md
  - src/common/input.test.ts
  - src/common/input.ts
  - src/common/input_pause_registry.test.ts
  - src/common/input_pause_registry.ts
  - src/logging/console_formatter.ts
  - src/logging/structured_messages.test.ts
  - src/logging/structured_messages.ts
  - src/logging/tunnel_client.test.ts
  - src/logging/tunnel_client.ts
  - src/logging/tunnel_integration.test.ts
  - src/logging/tunnel_prompt_handler.test.ts
  - src/logging/tunnel_prompt_handler.ts
  - src/logging/tunnel_protocol.test.ts
  - src/logging/tunnel_protocol.ts
  - src/logging/tunnel_server.test.ts
  - src/logging/tunnel_server.ts
  - src/tim/commands/agent/agent.test.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/agent/commander_negated_options.test.ts
  - src/tim/configSchema.test.ts
  - src/tim/configSchema.ts
  - src/tim/executors/claude_code/run_claude_subprocess.permissions_db.test.ts
  - src/tim/executors/claude_code/run_claude_subprocess.ts
  - src/tim/executors/claude_code/streaming_input.test.ts
  - src/tim/executors/claude_code/streaming_input.ts
  - src/tim/executors/claude_code/terminal_input.test.ts
  - src/tim/executors/claude_code/terminal_input.ts
  - src/tim/executors/claude_code/terminal_input_lifecycle.test.ts
  - src/tim/executors/claude_code/terminal_input_lifecycle.ts
  - src/tim/executors/claude_code.test.ts
  - src/tim/executors/claude_code.ts
  - src/tim/executors/types.ts
  - src/tim/tim.ts
tags: []
---

Support terminal input when running Claude Code via `tim agent`. The user can type messages during execution that are forwarded as additional user messages to the running Claude Code subprocess.

If running an active tunneling server, input is forwarded through the tunnel to the child agent.

## Expected Behavior / Outcome

When running `tim agent`, the user can type a message at any time during Claude Code execution and press Enter to send it. The message is formatted as a stream-json user message and written to the Claude Code subprocess's stdin. The agent receives it as a follow-up user message and can act on it.

**States:**
- **Active**: Terminal input reader is active, user can type. Enabled when Claude Code subprocess is running.
- **Paused**: Reader is temporarily suspended (e.g., during an inquirer permission prompt). Partial input is preserved.
- **Stopped**: Reader is fully cleaned up. Between executions, after process exits, or when disabled.

## Key Findings

- **Product & User Story**: As a developer using `tim agent`, I want to be able to send additional instructions to the agent while it's working (e.g., "also add tests", "stop and fix the type error", "use the existing helper instead") without having to restart the agent or wait for it to finish.

- **Design & UX Approach**: Simple line-based input. User types while output streams. Enter sends the line. Input is echoed visually ("→ You: <message>") and logged as a structured message. No mode switching or visual prompt prefix required.

- **Technical Plan & Risks**: The main change is replacing `sendSinglePromptAndWait()` (which closes stdin immediately) with a pattern that sends the initial prompt, keeps stdin open, and writes additional messages as the user types them. Risks include: stdin conflicts with inquirer prompts, cleanup issues preventing process exit, and FileSink write failures if the subprocess exits unexpectedly.

- **Pragmatic Effort Estimate**: Medium complexity. The core streaming input change is straightforward, but the stdin coordination with inquirer prompts and tunnel forwarding add integration complexity.

## Acceptance Criteria

- [ ] User can type a message during Claude Code execution and have it received by the agent
- [ ] Input is echoed visually in the output stream
- [ ] A structured message is emitted for each user input
- [ ] Terminal input is paused during inquirer prompts and resumes after (with partial input preserved)
- [ ] Input is forwarded through the tunnel when running nested agents
- [ ] `--no-terminal-input` flag disables the feature
- [ ] Terminal input is only active when `process.stdin.isTTY` is true
- [ ] Terminal input reader is properly cleaned up between batch mode iterations and on process exit
- [ ] All new code paths are covered by tests

## Dependencies & Constraints

- **Dependencies**: Plan 178 (Claude Code streaming JSON input) — already done. This plan builds directly on the `--input-format stream-json` infrastructure.
- **Technical Constraints**: Must not interfere with existing permission prompt handling. Must work with Bun's `FileSink` for subprocess stdin. Must coordinate with inquirer's stdin usage.

## Research

### Overview

This feature adds interactive terminal input support during Claude Code execution via the `tim agent` command. Currently, when `tim agent` runs Claude Code, it sends a single prompt via stdin using `sendSinglePromptAndWait()`, which immediately closes stdin after sending. The user has no way to provide additional guidance or messages to the running agent. This feature enables the user to type messages during execution that get forwarded to the Claude Code subprocess as additional user messages.

### Current Architecture — How Prompts Flow to Claude Code

#### The Critical Bottleneck: `sendSinglePromptAndWait()`

**File**: `src/tim/executors/claude_code/streaming_input.ts`

This function is the core of the current one-shot interaction model:

```typescript
export async function sendSinglePromptAndWait(
  streamingProcess: StreamingProcess,
  content: string
): Promise<SpawnAndLogOutputResult> {
  streamingProcess.stdin.write(buildSingleUserInputMessageLine(content));
  await streamingProcess.stdin.end();  // <--- THIS closes stdin immediately
  return streamingProcess.result;
}
```

The `stdin.end()` call tells the Claude Code subprocess that no more input will arrive. To support terminal input, we must **not** close stdin until the agent has finished its work.

#### Two Execution Paths

There are two places where Claude Code is spawned:

1. **Main executor** (`src/tim/executors/claude_code.ts`, line ~1000): Used for task execution (both serial and batch mode). Calls `sendSinglePromptAndWait(streaming, contextContent)`.

2. **Shared subprocess runner** (`src/tim/executors/claude_code/run_claude_subprocess.ts`, line ~429): Used by `executeReviewMode()` and `tim subagent`. Also calls `sendSinglePromptAndWait(streaming, prompt)`.

Both paths use `spawnWithStreamingIO()` from `src/common/process.ts` which returns a `StreamingProcess` with `stdin: FileSink`, `result: Promise<SpawnAndLogOutputResult>`, and `kill()`.

#### Claude Code's stream-json Input Format

The Claude Code CLI accepts streaming JSON input via `--input-format stream-json`. Messages are newline-delimited JSON written to stdin:

```json
{"type":"user","message":{"role":"user","content":"Your message here"}}
```

The `buildSingleUserInputMessageLine()` function in `streaming_input.ts` already creates this format. The process keeps reading stdin until it receives EOF (stdin closed). This means we can send multiple messages before closing.

### Tunnel Architecture

#### How Tunneling Currently Works

The tunnel system uses Unix domain sockets for bidirectional communication between parent and child tim processes.

**Key files:**
- `src/logging/tunnel_server.ts` — Server-side socket listener (parent process)
- `src/logging/tunnel_client.ts` — Client adapter (child process)
- `src/logging/tunnel_protocol.ts` — Message types
- `src/logging/tunnel_prompt_handler.ts` — Renders prompts on behalf of tunnel clients

**Environment variable**: `TIM_OUTPUT_SOCKET` contains the socket path. Set by the parent executor and detected by child processes.

**Current message types (client → server)**:
- `TunnelArgsMessage`: log/error/warn/debug with serialized args
- `TunnelDataMessage`: raw stdout/stderr data
- `StructuredTunnelMessage`: rich structured messages (35+ types)

**Current message types (server → client)**:
- `TunnelPromptResponseMessage`: prompt responses with requestId

**Bidirectional prompt flow**: When a child process calls `promptConfirm()` etc., the `TunnelAdapter` sends a `prompt_request` as a structured message to the parent via the socket. The parent's `tunnel_prompt_handler.ts` renders the inquirer prompt and sends back a `prompt_response`.

#### What Needs to Change for Tunnel Input

A new message type is needed for the server-to-client direction: "user input" messages that flow from the parent (where the user is typing) to the child (which has the Claude Code subprocess). This is analogous to the existing `prompt_response` but for unsolicited user input rather than responses to specific prompts.

### Stdin Sharing Considerations

**Permission prompts**: The permissions MCP uses a separate Unix socket for communication (not stdin). The parent process renders permission prompts using `@inquirer/prompts`. While an inquirer prompt is active, it takes control of stdin. User input for Claude Code and inquirer prompts need to be coordinated.

**Key insight**: Inquirer prompts are relatively brief (a few seconds while user answers). The simplest approach is to suspend terminal input collection while a prompt is active, and resume after.

### Process I/O Architecture

`StreamingProcess` from `src/common/process.ts`:
- `stdin: FileSink` — Bun's `FileSink` type for writing to stdin
- `result: Promise<SpawnAndLogOutputResult>` — Resolves when process exits
- `kill(signal?)` — Kill the subprocess

The `FileSink` supports `write()` (synchronous, returns count) and `end()` (async, closes the pipe). Multiple writes before `end()` are fully supported.

### Relevant Files Summary

| File | Role |
|------|------|
| `src/tim/executors/claude_code/streaming_input.ts` | Current one-shot prompt sending — needs new multi-message variant |
| `src/tim/executors/claude_code.ts` | Main executor — needs to integrate terminal input reading |
| `src/tim/executors/claude_code/run_claude_subprocess.ts` | Shared subprocess runner — needs terminal input option |
| `src/common/process.ts` | `StreamingProcess` type, `spawnWithStreamingIO()` |
| `src/common/terminal.ts` | Existing stdin patterns (`waitForEnter`, `readStdinUntilTimeout`) |
| `src/common/input.ts` | Prompt functions with tunnel/headless awareness |
| `src/logging/tunnel_protocol.ts` | Tunnel message types — needs new input message type |
| `src/logging/tunnel_server.ts` | Tunnel server — needs to forward user input |
| `src/logging/tunnel_client.ts` | `TunnelAdapter` — needs to receive user input |
| `src/logging/tunnel_prompt_handler.ts` | Prompt rendering for tunnel clients |
| `src/tim/commands/agent/agent.ts` | Top-level agent command (1290 lines) |
| `src/tim/commands/agent/batch_mode.ts` | Batch mode execution loop |

### Key Design Decisions

1. **Simple line-based input**: User just types while output streams. Press Enter to send the line. No visual prompt prefix or mode switching. Minimal and unobtrusive.

2. **On by default**: Terminal input is enabled when `process.stdin.isTTY` is true and not in noninteractive mode. Add `--no-terminal-input` CLI flag to disable.

3. **Claude Code executor only**: This plan covers only the Claude Code executor. Codex CLI support can be added separately later.

4. **Forward through tunnel**: When a tunnel is active, the parent process reads terminal input and forwards it through the tunnel to the active child agent. Only one child agent is active at a time.

5. **Echo and structured logging**: When user input is sent, echo it visually (e.g., "→ You: <message>") and emit a structured message for audit logging.

6. **Prompt coordination**: Pause/resume the readline interface when inquirer prompts become active. If pause/resume doesn't work cleanly with inquirer (since inquirer creates its own readline), close the readline and save any partially-typed input, then restore it when creating a new readline after the prompt completes.

7. **Batch mode**: Reset the terminal input reader between batch iterations. Partial input from one iteration is not carried to the next.

8. **Where to read input**: stdin is read in the process that owns the terminal. For top-level execution, this is the `tim agent` process. For tunnel-nested execution, the root process reads and forwards through the tunnel.

## Implementation Guide

### Step 1: Create Terminal Input Reader Module

Create `src/tim/executors/claude_code/terminal_input.ts` to encapsulate the terminal input reading logic.

This module should export a class like `TerminalInputReader` that:
- Starts listening on `process.stdin` for line-based input
- When a complete line is received (user presses Enter), calls a provided callback
- Can be paused/resumed (for when inquirer prompts are active)
- Can be stopped (when execution completes)
- Handles Ctrl+C gracefully
- Only activates when `process.stdin.isTTY` is true (skip in non-interactive contexts)

Use the existing `readStdinUntilTimeout` pattern from `src/common/terminal.ts` as a reference for raw stdin handling, but adapt for continuous line-based reading.

**Important**: When reading lines, use readline interface (`node:readline`) with `process.stdin` rather than raw mode. This provides line editing, history, and proper line buffering. The readline interface can be paused/resumed cleanly.

When a line is received, format it using `buildSingleUserInputMessageLine()` from `streaming_input.ts` and write it to the provided `FileSink` (Claude Code's stdin).

### Step 2: Modify `streaming_input.ts` to Support Multi-Message Mode

Add a new function alongside `sendSinglePromptAndWait()`:

```typescript
export function sendInitialPrompt(
  streamingProcess: StreamingProcess,
  content: string
): void {
  streamingProcess.stdin.write(buildSingleUserInputMessageLine(content));
  // Note: stdin is NOT closed here
}

export function sendFollowUpMessage(
  stdin: FileSink,
  content: string
): void {
  stdin.write(buildSingleUserInputMessageLine(content));
}

export async function closeStdinAndWait(
  streamingProcess: StreamingProcess
): Promise<SpawnAndLogOutputResult> {
  await streamingProcess.stdin.end();
  return streamingProcess.result;
}
```

Keep `sendSinglePromptAndWait()` as-is for backward compatibility — callers that don't need terminal input can continue using it.

### Step 3: Integrate Terminal Input into the Main Executor

Modify `src/tim/executors/claude_code.ts` in the `execute()` method:

1. After `spawnWithStreamingIO()` returns the streaming process (around line 999), instead of calling `sendSinglePromptAndWait()`:
   - Call `sendInitialPrompt()` to send the task prompt without closing stdin
   - If terminal input is enabled (flag from options/config), create a `TerminalInputReader` that writes follow-up messages to `streaming.stdin`
   - Wait for the process to complete (the `result` promise)
   - When the process exits or a result message is detected, stop the terminal input reader and close stdin

2. Add an option to `ExecutorCommonOptions` (in `src/tim/executors/types.ts`) to enable/disable terminal input. This can default to `true` when the process has a TTY and is not running in noninteractive mode.

3. Wire the option through from the agent command's CLI options.

### Step 4: Integrate Terminal Input into `run_claude_subprocess.ts`

Apply the same pattern to `runClaudeSubprocess()`. This is used by review mode and subagent execution. For subagent execution specifically, terminal input may not make sense (the orchestrator is driving it), so make it configurable.

Add a `terminalInput?: boolean` option to `RunClaudeSubprocessOptions`. When enabled, use the `sendInitialPrompt()` + `TerminalInputReader` pattern instead of `sendSinglePromptAndWait()`.

### Step 5: Add Tunnel Protocol Support for User Input

Extend the tunnel protocol to support forwarding user input from parent to child:

1. In `src/logging/tunnel_protocol.ts`, add a new server-to-client message type:

```typescript
export interface TunnelUserInputMessage {
  type: 'user_input';
  content: string;
}

export type ServerTunnelMessage = TunnelPromptResponseMessage | TunnelUserInputMessage;
```

2. In `src/logging/tunnel_server.ts`, add a method to broadcast user input to connected clients:

```typescript
// On the TunnelServer type, add:
sendUserInput(content: string): void
```

This writes the `user_input` message as JSONL to all connected client sockets.

3. In `src/logging/tunnel_client.ts`, handle incoming `user_input` messages:
   - Add a callback or event emitter for user input
   - When a `user_input` message arrives, invoke the registered callback

### Step 6: Wire Tunnel Input to Claude Code Subprocess

When the `TerminalInputReader` is running in a process that owns a tunnel server:
- The reader captures user input from the terminal
- It writes the input to Claude Code's stdin (for the local subprocess)
- It also sends it through the tunnel so nested processes receive it

When running as a tunnel client (nested process):
- Register a `user_input` handler on the tunnel adapter
- When `user_input` arrives from the parent, forward it to the local Claude Code subprocess's stdin

### Step 7: Handle Prompt/Input Coordination

When permission prompts or other inquirer prompts are active, the terminal input reader must be paused to avoid conflicting with inquirer's stdin handling.

Approach:
- Add `pause()` / `resume()` methods to `TerminalInputReader`
- `pause()` should close/pause the readline interface and save any partially-typed input (the current line buffer)
- `resume()` should recreate the readline interface and restore any saved partial input
- Export a module-level `getActiveTerminalInputReader()` function
- In `src/common/input.ts`, wrap each prompt function to call `reader.pause()` before the inquirer prompt and `reader.resume()` after it resolves

Since inquirer creates its own readline interface internally, our readline should be fully closed (not just paused) before inquirer starts. After the inquirer prompt completes, create a fresh readline and restore the buffered partial input. Test whether `readline.pause()` is sufficient — if so, use that simpler approach. If inquirer conflicts with a paused readline, fall back to the close/reopen strategy.

### Step 8: Add CLI Options

Add `--no-terminal-input` flag to the `tim agent` command to disable terminal input. This is useful for CI/CD or scripted execution.

In `src/tim/commands/agent/agent.ts`, add the option and pass it through to the executor.

Also consider adding a config option in `configSchema.ts` for this setting.

### Step 9: Add User Feedback / UX

When terminal input is active, print a brief indicator so the user knows they can type:
- A subtle message like "Type a message and press Enter to send input to the agent" when execution starts

When the user sends input:
- Echo it visually (e.g., "→ You: <their message>") via `log()` so it's clear in the output stream
- Emit a structured message (new type: `user_terminal_input`) with the content and timestamp for audit logging and tunnel forwarding
- Add the `user_terminal_input` type to `src/logging/structured_messages.ts`

### Step 10: Testing

1. **Unit tests for `TerminalInputReader`**: Test start/stop, pause/resume, line reading, callback invocation.

2. **Unit tests for multi-message `streaming_input.ts` functions**: Test `sendInitialPrompt()`, `sendFollowUpMessage()`, `closeStdinAndWait()`.

3. **Integration tests for tunnel user input**: Extend `src/logging/tunnel_integration.test.ts` to test the new `user_input` message type flowing from server to client.

4. **Test prompt/input coordination**: Verify that `TerminalInputReader` pauses when an inquirer prompt starts and resumes when it ends.

### Manual Testing Steps

1. Run `tim agent --next` on a plan with tasks
2. While Claude Code is executing, type a message and press Enter
3. Verify the message appears in Claude Code's input stream
4. Verify Claude Code acknowledges/processes the input
5. Test with permission prompts active — verify input reading pauses
6. Test with `--no-terminal-input` — verify input is not captured
7. Test in a tunnel scenario (nested agent) — verify input propagates through tunnel

### Potential Gotchas

1. **`FileSink.write()` after process exit**: If the Claude Code process exits while the user is typing, writing to stdin will throw. Guard with a try/catch and the streaming process's result promise state.

2. **Readline vs raw mode conflict**: The existing `waitForEnter()` in `terminal.ts` uses raw mode. If both are active simultaneously, they'll conflict. The terminal input reader should only be active during execution, not during other phases.

3. **Process.stdin cleanup**: After the readline interface is closed, `process.stdin` must be properly unref'd/paused to allow the Node.js event loop to exit cleanly.

4. **Batch mode iterations**: In batch mode (`batch_mode.ts`), the executor runs multiple iterations. The terminal input reader should be active for each iteration (each Claude Code subprocess) but properly cleaned up between iterations.

5. **Result message detection**: Currently, `seenResultMessage` is detected in the `formatStdout` callback. The terminal input reader should stop accepting input once a result message is seen, even before the process formally exits.

6. **Bun's FileSink behavior**: Bun's `FileSink` may not immediately flush writes. Verify that `write()` calls to stdin are promptly delivered to the subprocess.

## Current Progress
### Current State
- All 15 tasks are complete. The terminal input feature is fully functional with proper module layering, safe stdin cleanup, consistent pause/resume semantics, tunnel prompt coordination, and deduplicated executor wiring.
### Completed (So Far)
- Task 1: Added `sendInitialPrompt()`, `sendFollowUpMessage()`, `closeStdinAndWait()` to `streaming_input.ts` alongside existing `sendSinglePromptAndWait()`
- Task 2: Created `TerminalInputReader` class in `terminal_input.ts` with full lifecycle (start/stop/pause/resume), singleton enforcement, and `getActiveTerminalInputReader()` export
- Task 3: Added `user_terminal_input` structured message type to `structured_messages.ts` with tunnel server validation and console formatter handling
- Task 4: Integrated terminal input into main Claude Code executor (`claude_code.ts`) using shared lifecycle helper
- Task 5: Integrated terminal input into `run_claude_subprocess.ts` with same shared lifecycle helper
- Task 6: Added prompt/input coordination in `input.ts` with `withTerminalInputPaused()` wrapping all four inquirer prompt functions
- Task 7: Added `TunnelUserInputMessage` to tunnel protocol, `sendUserInput()` broadcast on TunnelServer, `setUserInputHandler()` on TunnelAdapter with try/catch safety
- Task 8: Wired tunnel forwarding in both executors — `setupTerminalInput` accepts optional `tunnelServer` for broadcast, executors register `setUserInputHandler` on tunnel adapter for child-side forwarding, stdin kept open when `isTunnelActive()` even if terminal reader is disabled
- Task 9: Added `--no-terminal-input` CLI flag, `terminalInput` config option, wired through to `ExecutorCommonOptions`
- Task 10: Batch mode lifecycle works implicitly — each `execute()` call manages its own `setupTerminalInput`/`awaitAndCleanup` lifecycle, singleton pattern ensures previous readers are stopped, sequential lifecycle tests verify no leaks
- Task 11: Moved terminal-input pause/resume coordination to `src/common/input_pause_registry.ts` with `PausableInputSource` interface. `common/input.ts` no longer imports from `tim` module. `TerminalInputReader` registers/unregisters itself with the common registry.
- Task 12: Added `safeEndStdin()` helper in `streaming_input.ts` that wraps `stdin.end()` in try/catch for both sync throws and async rejections. Applied to all 3 call sites: `claude_code.ts`, `run_claude_subprocess.ts`, `terminal_input_lifecycle.ts`. Also fixed `closeStdinAndWait()` to use protected `end()`.
- Task 13: Fixed `withTerminalInputPaused` to capture the input source reference once at function entry and resume the same instance in the finally block, eliminating the asymmetry.
- Task 14: Added pause/resume coordination in `tunnel_prompt_handler.ts` using `getActiveInputSource()` from the common registry. Captures the input source reference at handler entry and resumes the same instance in the finally block.
- Task 15: Extracted duplicated terminal input wiring into `executeWithTerminalInput()` in `terminal_input_lifecycle.ts`. Both `claude_code.ts` and `run_claude_subprocess.ts` now use this shared helper, eliminating ~50 lines of duplicated code each.
### Remaining
- None — all tasks complete
### Next Iteration Guidance
- None — all tasks complete
### Decisions / Changes
- `sendFollowUpMessage()` takes raw `FileSink` while `sendInitialPrompt()` takes `StreamingProcess` — intentional asymmetry since follow-up callers may only have the stdin reference
- Readline uses `process.stdout` for output (visible character echoing) and `terminal: true` when stdin is TTY — this gives users real-time feedback while typing, with the structured message echo (`→ You: <message>`) showing the completed message after Enter
- SIGINT is NOT intercepted — Ctrl+C propagates normally to the process for standard interrupt behavior
- Console formatter uses Unicode `→ You:` prefix for user terminal input echo
- TTY check is a hard-gate in `agent.ts` — config `terminalInput: true` cannot override missing TTY. Executors trust the resolved boolean without re-checking.
- `user_terminal_input` structured message is always emitted on user input (even if the subprocess write fails) to maintain complete audit trail
- On write failure to subprocess stdin, the reader is stopped and stdin is closed (subprocess is likely dead)
- Shared terminal input lifecycle extracted to `terminal_input_lifecycle.ts` with `setupTerminalInput()` returning a controller object with `onResultMessage()` and `awaitAndCleanup()` methods
- Higher-level `executeWithTerminalInput()` added to `terminal_input_lifecycle.ts` encapsulating the full three-path branching (terminal input / tunnel forwarding / single prompt), tunnel handler wiring, and closeStdin management
- `process.stdin.unref()` is always called directly in `awaitAndCleanup()` regardless of reader state, not relying on `reader.stop({ unref: true })`
- stdin is closed immediately when `seenResultMessage` is detected (via `onResultMessage()` callback) to prevent deadlock — Claude Code may wait for EOF before exiting
- Tunnel client API uses `setUserInputHandler` (not `onUserInput`) to clarify single-listener semantics; accepts `undefined` to clear
- Tunnel broadcast errors are isolated from subprocess stdin writes — tunnel failure does not stop the local terminal input reader
- When `isTunnelActive()` is true but `terminalInputEnabled` is false, executors use multi-message stdin lifecycle (sendInitialPrompt + closeStdinAndWait) to keep stdin open for tunnel-forwarded input
- Tunnel adapter listener is cleared both on result message and in finally block to prevent writes to closed stdin
- Terminal-input pause/resume coordination uses a `common`-owned `PausableInputSource` registry (`src/common/input_pause_registry.ts`) to avoid `common -> tim` dependency inversion
- All `stdin.end()` calls in cleanup paths use `safeEndStdin()` which handles both sync throws and async rejections
- Tunnel prompt handler (`tunnel_prompt_handler.ts`) pauses/resumes the active input source around each inquirer call, matching the pattern in `input.ts`
### Lessons Learned
- The readline `close` event fires synchronously when `.close()` is called. The close handler must check the reader state before clearing `partialInput` or `activeTerminalInputReader`, otherwise `pause()` (which calls `closeReadline()`) wipes out the saved partial input.
- Test mocks for readline must also emit the `close` event from `close()` to faithfully reproduce real behavior — otherwise tests pass while hiding real bugs.
- The microtask-deferred `onLine` callback (`Promise.resolve().then(...)`) needs a state guard to prevent firing after the reader has been stopped/paused between the line event and the microtask execution.
- stdin close ordering is critical: if you await `streaming.result` before closing stdin, Claude Code (with `--input-format stream-json`) may hang waiting for EOF, creating a deadlock. Always close stdin when the result message is detected.
- When calling `reader.stop()` from `onResultMessage` and later from `awaitAndCleanup`, the `unref` logic must be handled independently because `stop()` early-returns if already stopped.
- Structured audit messages should be emitted before attempting write operations, not after — otherwise audit trails have gaps when writes fail.
- Redundant defensive checks across multiple layers (agent.ts, executor, reader) create confusion about which layer owns the decision. Pick one authoritative layer and trust the resolved value downstream.
- When adding tunnel forwarding alongside local stdin, keep error handling separate — a tunnel broadcast failure should not affect local subprocess communication.
- When a child process receives input via tunnel (not TTY), stdin must still be kept open using the multi-message lifecycle, not the single-shot `sendSinglePromptAndWait` path.
- Always clear callback handlers on result message, not just in finally blocks — there's a window between result detection and process exit where stale handlers can fire.
- `Promise.resolve(fn()).catch(...)` does NOT catch synchronous throws from `fn()` — the throw occurs before `Promise.resolve` wraps the result. Always use `try { const r = fn(); Promise.resolve(r).catch(...) } catch (e) { ... }` for functions that may throw synchronously.
- When introducing a common abstraction to break a dependency inversion, keep it minimal (just an interface + getter/setter). The feature module registers itself; the common module only knows about the interface.
- When extracting duplicated code into a shared helper, watch for dual state tracking — if the inner helper and outer function both track the same state (e.g., `stdinClosed`), explicitly synchronize them to avoid misleading guards.
### Risks / Blockers
- None
