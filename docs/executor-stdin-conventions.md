# Claude Code Executor & Stdin Conventions

Conventions and gotchas for the Claude Code executor's stdin management, terminal input, and tunnel forwarding.

## Stdin Lifecycle with `--input-format stream-json`

Claude Code reads stdin until EOF when using `--input-format stream-json`. This has critical ordering implications:

- **Close stdin on result message, not after awaiting the result.** If you `await streaming.result` before closing stdin, Claude Code may hang waiting for EOF — creating a deadlock. The `onResultMessage` callback should trigger stdin close immediately.
- **Use `safeEndStdin()`** for all stdin close operations in cleanup paths. It wraps `stdin.end()` to handle both synchronous throws and async rejections (e.g., when the subprocess has already exited).
- **Tunnel children need multi-message lifecycle.** When a child process receives input via tunnel (not TTY), stdin must be kept open using `sendInitialPrompt` + `closeStdinAndWait`, not the single-shot `sendSinglePromptAndWait` path.

## Terminal Input Reader

The `TerminalInputReader` manages a readline interface for interactive user input during agent execution.

### Readline `close` Event

The readline `close` event fires **synchronously** when `.close()` is called. The close handler must check the reader's state before clearing `partialInput` or `activeTerminalInputReader`, because `pause()` calls `closeReadline()` internally — if the handler unconditionally clears state, it wipes out saved partial input that `pause()` is trying to preserve.

### Microtask-Deferred Callbacks

The `onLine` callback uses `Promise.resolve().then(...)` to defer execution. This requires a state guard to prevent the callback from firing after the reader has been stopped or paused between the line event and the microtask execution.

### Stop Idempotency

`reader.stop()` early-returns if already stopped. This means `unref` logic (`process.stdin.unref()`) must be handled independently of `stop()`, because the first caller (e.g., `onResultMessage`) may stop without unreffing, while the final caller (`awaitAndCleanup`) needs to ensure unref happens regardless.

### Prompt Coordination

When inquirer prompts are active, the terminal input reader must be fully paused (readline closed, not just `readline.pause()`). Inquirer creates its own readline interface and conflicts with an existing one.

The `withTerminalInputPaused()` helper captures the input source reference at function entry and resumes the **same instance** in the finally block, preventing asymmetric pause/resume if the active source changes during the prompt.

## Tunnel Forwarding

### Error Isolation

Tunnel broadcast errors must be isolated from local subprocess stdin writes. A failure to send input through the tunnel should not prevent the local Claude Code subprocess from receiving input, and vice versa.

### Callback Cleanup

Clear tunnel `userInputHandler` callbacks both on result message detection **and** in finally blocks. There's a window between result detection and process exit where stale handlers can fire and attempt writes to closed stdin.

## `executeWithTerminalInput()` Three-Path Branching

The shared helper in `terminal_input_lifecycle.ts` handles three distinct modes:

1. **Terminal input enabled**: Full readline lifecycle with `setupTerminalInput()` / `awaitAndCleanup()`
2. **Tunnel active, no terminal**: Multi-message lifecycle (`sendInitialPrompt` + `closeStdinAndWait`) to keep stdin open for tunnel-forwarded input
3. **Neither**: Single-shot `sendSinglePromptAndWait()`

Both `claude_code.ts` and `run_claude_subprocess.ts` delegate to this helper to avoid duplicating the branching logic.
