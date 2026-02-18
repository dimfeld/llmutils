# Claude Code Executor & Execution Conventions

Conventions and gotchas for the Claude Code executor's stdin management, terminal input, tunnel forwarding, and pre-execution setup.

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

## Tunnel and Headless Forwarding

### Error Isolation

Tunnel and headless broadcast errors must be isolated from local subprocess stdin writes. A failure to send input through the tunnel or headless adapter should not prevent the local Claude Code subprocess from receiving input, and vice versa.

### Callback Cleanup

Clear tunnel and headless `userInputHandler` callbacks both on result message detection **and** in finally blocks. There's a window between result detection and process exit where stale handlers can fire and attempt writes to closed stdin.

### Headless Adapter User Input

The `HeadlessAdapter` supports a `setUserInputHandler()` callback, mirroring the tunnel's `setUserInputHandler()`. When `executeWithTerminalInput()` detects the logger adapter is a `HeadlessAdapter`, it wires a handler that:

1. Checks `stdinGuard.isClosed` before writing
2. Calls `sendFollowUpMessage()` to forward input to the Claude Code subprocess
3. Broadcasts via `tunnelServer?.sendUserInput()` (if a tunnel is also active)
4. Emits a `user_terminal_input` structured message for logging/display

This enables tim-gui to send user messages to running agent sessions via the headless WebSocket connection.

## `executeWithTerminalInput()` Branching

The shared helper in `terminal_input_lifecycle.ts` handles three distinct modes:

1. **Terminal input enabled**: Full readline lifecycle with `setupTerminalInput()` / `awaitAndCleanup()`
2. **Tunnel or headless forwarding active, no terminal**: Multi-message lifecycle (`sendInitialPrompt` + `closeStdinAndWait`) to keep stdin open for forwarded input. A `headlessForwardingEnabled` boolean is computed from `loggerAdapter instanceof HeadlessAdapter` — this ensures the headless adapter (tim-gui) keeps stdin open for follow-up messages, just like tunnel forwarding does.
3. **Neither**: Single-shot `sendSinglePromptAndWait()`

Both `claude_code.ts` and `run_claude_subprocess.ts` delegate to this helper to avoid duplicating the branching logic.

### Tunnel and Headless Forwarding as Interactive Input Sources

Tunnel and headless forwarding are interactive input sources alongside terminal input. When writing validation guards (e.g., "is this session interactive?"), check for **all** of `terminalInputEnabled`, tunnel-active state, and headless adapter presence — not just terminal input. For example, a command that requires user interaction to function (like chat with no initial prompt) must allow execution when any of these can provide input. Checking only `terminalInputEnabled` would break Tim-GUI integration where input arrives via the tunnel or the headless WebSocket.

### Optional Initial Prompt

The `prompt` parameter in `executeWithTerminalInput()` is optional. When no prompt is provided:

- **Terminal input / tunnel / headless paths**: The subprocess spawns but nothing is written to stdin until the user sends their first message (via terminal readline, tunnel, or headless GUI). The first message uses `sendFollowUpMessage()`.
- **Single-prompt path**: A prompt is required — if none is provided and neither terminal input, tunnel, nor headless forwarding is active, this is an error. The caller should validate this before reaching the executor.

## `logSpawn()` and Exit Codes

The `logSpawn()` function returns a Bun `Subprocess` where `exitCode` may be `null` before the process finishes. Always `await subprocess.exited` before checking `exitCode`.

## Workspace Locking Conventions

Both `tim agent` and `tim generate` use `setupWorkspace()` from `workspace_setup.ts` for workspace selection and locking. Key invariants and gotchas:

- **Execution must always hold a lock.** Even when no workspace flags are provided and the command falls back to cwd, it must acquire a PID lock on cwd before returning. Early returns from the workspace selection branches must not skip this.
- **`createWorkspace()` acquires persistent locks, not PID locks.** Persistent locks are not released by signal handlers. For signal-based cleanup to work, the persistent lock must be released and re-acquired as a PID lock after workspace creation. This is handled inside `setupWorkspace()`.
- **Auto-claim should happen before executor execution** (after workspace setup), so the plan is assigned even if the executor fails or is interrupted. This matches the ordering in both `agent` and `generate` commands.
