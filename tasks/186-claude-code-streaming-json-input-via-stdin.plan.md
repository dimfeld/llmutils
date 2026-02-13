---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Claude Code streaming JSON input via stdin
goal: ""
id: 186
uuid: 06ad50ff-d486-47c2-ab95-d0e0366de585
generatedBy: agent
status: done
priority: medium
parent: 178
references:
  "178": 8970382a-14d8-40e2-9fda-206b952d2591
planGeneratedAt: 2026-02-13T09:06:34.446Z
promptsGeneratedAt: 2026-02-13T09:06:34.446Z
createdAt: 2026-02-13T08:53:54.317Z
updatedAt: 2026-02-13T09:38:00.027Z
tasks:
  - title: Create spawnWithStreamingIO() function in src/common/process.ts
    done: true
    description: "Factor out process spawning and output processing from
      spawnAndLogOutput() into a new function that returns writable stdin + exit
      promise. The function should: spawn the process with stdin as pipe, set up
      stdout/stderr reading with TextDecoder and formatters, set up inactivity
      timer logic, return {stdin, result: Promise, kill()}. Then refactor
      spawnAndLogOutput() to use this new function internally so its behavior is
      unchanged."
  - title: Update ClaudeCodeExecutor.execute() to use stdin streaming
    done: true
    description: 'In src/tim/executors/claude_code.ts execute() method: replace
      --print with --input-format stream-json. Use spawnWithStreamingIO()
      instead of spawnAndLogOutput(). Write the initial prompt to stdin as
      {type: "user", message: {role: "user", content: contextContent}} +
      newline. Close stdin after writing. Keep all existing output processing
      (formatting, failure detection, capture) unchanged.'
  - title: Update ClaudeCodeExecutor.executeReviewMode() to use stdin streaming
    done: true
    description: "In src/tim/executors/claude_code.ts executeReviewMode(): replace
      --print with --input-format stream-json. Use spawnWithStreamingIO(). Write
      the review prompt to stdin as streaming JSON. Close stdin after writing.
      Keep --json-schema flag and output handling unchanged."
  - title: Update subagent.ts to use stdin streaming
    done: true
    description: "In src/tim/commands/subagent.ts: replace --print with
      --input-format stream-json. Use spawnWithStreamingIO(). Write the subagent
      prompt to stdin as streaming JSON. Close stdin after writing. Keep all
      existing output processing unchanged."
  - title: Write tests for spawnWithStreamingIO() and verify existing tests pass
    done: true
    description: "Test the new spawnWithStreamingIO() function: verify it spawns a
      process and returns writable stdin, verify writing to stdin and closing it
      allows the process to complete, verify the result promise resolves with
      exit code/stdout/stderr, verify inactivity timeout works. Ensure
      spawnAndLogOutput() behavior is unchanged by running existing tests. Run
      bun test to verify all tests pass."
changedFiles:
  - src/common/process.test.ts
  - src/common/process.ts
  - src/tim/commands/subagent.test.ts
  - src/tim/commands/subagent.ts
  - src/tim/executors/claude_code.test.ts
  - src/tim/executors/claude_code.ts
  - src/tim/executors/claude_code_model_test.ts
tags: []
---

Switch the Claude Code executor from passing prompts via --print CLI argument to streaming newline-delimited JSON messages via stdin. This enables sending additional guidance messages during execution and lays groundwork for future multi-turn support. The JSON format is: {type: 'user', message: {role: 'user', content: [...]}} written as newline-delimited JSON to the claude process's stdin.

## Research

See parent plan 178 for full codebase analysis. Key points specific to this plan:

### Current stdin Handling

In `src/common/process.ts`, `spawnAndLogOutput()` currently:
- Sets stdin to `'pipe'` only if `options.stdin` string is provided, otherwise `'ignore'` (line 170)
- When stdin string is provided, writes it once and immediately closes (lines 232-235)
- Awaits `proc.exited` before returning, blocking until the process terminates

This is incompatible with streaming input because:
1. We need stdin to remain open as a writable pipe during the entire execution
2. The caller needs access to the stdin writable to send additional messages
3. `spawnAndLogOutput()` blocks until exit, so the caller can't interact during execution

### Planned Architecture Change

Factor out the process startup and output processing from `spawnAndLogOutput()` into a new function (e.g., `spawnWithStreamingIO()`) that:
- Spawns the process with stdin as `'pipe'`
- Sets up the same stdout/stderr reading, formatting, and inactivity detection
- Returns the writable stdin and a promise that resolves when the process exits
- Lets the caller write to stdin and close it when done

The existing `spawnAndLogOutput()` retains its current behavior by calling the new function internally.

### CLI Flags

Replace `--print <content>` with `--input-format stream-json`. The initial prompt is then written to stdin as the first JSON message, and the process stays alive reading from stdin until it's closed.

### Files to Change

| File | Change |
|------|--------|
| `src/common/process.ts` | Add `spawnWithStreamingIO()` that returns stdin + exit promise |
| `src/tim/executors/claude_code.ts` | `execute()` and `executeReviewMode()`: use `--input-format stream-json` + write prompt to stdin |
| `src/tim/commands/subagent.ts` | Same switch from `--print` to stdin streaming |

### Expected Behavior/Outcome

- Claude CLI receives input via stdin as newline-delimited JSON instead of `--print` CLI argument
- Initial prompt is sent as the first stdin message
- stdin remains writable during execution (caller controls when to close)
- The process exits when stdin is closed
- All existing output processing (formatting, failure detection, capture) continues to work unchanged
- Foundation is laid for future features: sending additional guidance messages, multi-turn, images

### Acceptance Criteria

- [ ] `spawnWithStreamingIO()` function exists and returns writable stdin + exit promise
- [ ] `spawnAndLogOutput()` behavior is unchanged (still blocks until exit)
- [ ] `ClaudeCodeExecutor.execute()` uses `--input-format stream-json` instead of `--print`
- [ ] `ClaudeCodeExecutor.executeReviewMode()` uses `--input-format stream-json` instead of `--print`
- [ ] `subagent.ts` uses `--input-format stream-json` instead of `--print`
- [ ] Initial prompt is written to stdin as `{type: "user", message: {role: "user", content: "..."}}` + newline
- [ ] stdin is closed after writing the initial prompt (for now, until future multi-turn work)
- [ ] All existing tests pass
- [ ] Output formatting, failure detection, and capture modes work correctly

### Dependencies & Constraints

- No new dependencies needed
- The `claude` CLI must support `--input-format stream-json` (verified)
- Must be backwards compatible - only the input method changes, output processing stays the same
- The process stays alive as long as stdin is open, so callers must close stdin to allow exit

## Implementation Guide

### Step 1: Create `spawnWithStreamingIO()` in `src/common/process.ts`

Factor out the process spawning and output processing from `spawnAndLogOutput()`. The new function should:

1. Accept the same options as `spawnAndLogOutput()` (cwd, env, formatStdout, formatStderr, inactivity timeouts, etc.)
2. Spawn the process with `stdio: ['pipe', 'pipe', 'pipe']` (stdin always piped)
3. Set up the same stdout/stderr async reading loops with TextDecoder
4. Set up the same inactivity timer logic (initial + running timeouts, SIGTSTP/SIGCONT)
5. Return an object with:
   - `stdin`: The writable stdin stream (from `proc.stdin`)
   - `result`: A promise that resolves when the process exits, with the same return type as `spawnAndLogOutput()` (`{exitCode, stdout, stderr, signal, killedByInactivity}`)
   - Optionally a `kill()` method for cleanup

```typescript
interface StreamingProcess {
  stdin: WritableStream; // or whatever Bun's stdin type is
  result: Promise<SpawnResult>;
  kill: (signal?: NodeJS.Signals) => void;
}

export async function spawnWithStreamingIO(
  cmd: string[],
  options?: SpawnWithStreamingOptions
): Promise<StreamingProcess> {
  // ... spawn process, set up output reading, return stdin + result promise
}
```

Then refactor `spawnAndLogOutput()` to use `spawnWithStreamingIO()` internally:
```typescript
export async function spawnAndLogOutput(cmd, options) {
  const streaming = await spawnWithStreamingIO(cmd, options);
  if (options?.stdin) {
    streaming.stdin.write(options.stdin);
    await streaming.stdin.end();
  } else {
    await streaming.stdin.end();
  }
  return streaming.result;
}
```

This ensures `spawnAndLogOutput()` maintains identical behavior while the new function provides the streaming capability.

### Step 2: Update `ClaudeCodeExecutor.execute()` in `src/tim/executors/claude_code.ts`

In the `execute()` method (around line 1145):

**Before:**
```typescript
args.push('--verbose', '--output-format', 'stream-json', '--print', contextContent);
```

**After:**
```typescript
args.push('--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json');
```

Then use `spawnWithStreamingIO()` instead of `spawnAndLogOutput()`:
```typescript
const streaming = await spawnWithStreamingIO(args, {
  env: { ... },
  cwd: gitRoot,
  inactivityTimeoutMs: executionTimeoutMs,
  // ... same options as before
  formatStdout: (output) => {
    // ... same formatting logic
  },
});

// Write the initial prompt as a streaming JSON message
const initialMessage = JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: contextContent,
  },
}) + '\n';
streaming.stdin.write(initialMessage);
// Close stdin for now (future work will keep it open for additional messages)
await streaming.stdin.end();

// Wait for the process to complete
const result = await streaming.result;
```

The rest of the method (failure detection, output capture, return logic) stays the same.

### Step 3: Update `ClaudeCodeExecutor.executeReviewMode()`

Same pattern as Step 2. In the review mode method (around line 638-643):

**Before:**
```typescript
args.push('--verbose', '--output-format', 'stream-json');
args.push('--json-schema', jsonSchema);
args.push('--print', contextContent + '\n\nBe sure to provide the structured output with your response');
```

**After:**
```typescript
args.push('--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json');
args.push('--json-schema', jsonSchema);
```

Then use `spawnWithStreamingIO()` and write the prompt via stdin.

### Step 4: Update `subagent.ts`

In `src/tim/commands/subagent.ts` (around line 444-445):

**Before:**
```typescript
args.push('--verbose', '--output-format', 'stream-json');
args.push('--print', prompt);
```

**After:**
```typescript
args.push('--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json');
```

Then use `spawnWithStreamingIO()` to write the prompt via stdin. The subagent currently uses `spawnAndLogOutput()` — switch to the new function and close stdin immediately after writing the prompt.

### Step 5: Write tests

Test the new `spawnWithStreamingIO()` function:
- Test that it spawns a process and returns writable stdin
- Test that writing to stdin and closing it allows the process to complete
- Test that the result promise resolves with exit code, stdout, stderr
- Test that `spawnAndLogOutput()` still works identically after the refactor
- Test inactivity timeout still works with the new function

For the executor changes, the existing test suite should continue to pass since only the input method changes. Add targeted tests that verify:
- The `--input-format stream-json` flag is used instead of `--print`
- The initial message is correctly formatted as streaming JSON

### Manual Testing

1. Run `tim agent <planId>` - verify Claude receives the prompt correctly
2. Run `tim subagent implementer <planId>` - verify subagent works
3. Run `tim agent <planId> -m review` - verify review mode works
4. Check that long prompts work (--print had potential arg length limits on some systems)

## Current Progress
### Current State
- All 5 tasks completed. Plan is done.
### Completed (So Far)
- Task 1: Created `spawnWithStreamingIO()` in `src/common/process.ts` that returns `{stdin, result, kill()}`. Refactored internal output-processing setup into `setupOutputProcessing()` shared between both functions.
- Task 2: Updated `ClaudeCodeExecutor.execute()` to use `--input-format stream-json` and write prompt to stdin via `sendSinglePromptAndWait()`.
- Task 3: Updated `ClaudeCodeExecutor.executeReviewMode()` with the same stdin streaming pattern.
- Task 4: Updated `subagent.ts` to use `--input-format stream-json` and write prompt to stdin.
- Task 5: Tests added for `spawnWithStreamingIO()` and updated all executor/subagent test mocks to use proper `StreamingProcess` shape. All targeted tests pass (118 pass, 0 fail).
### Remaining
- None for this plan. Out-of-scope: `claude_code_orchestrator.ts` and `run_prompt.ts` still use `--print` pattern.
### Next Iteration Guidance
- None
### Decisions / Changes
- `spawnAndLogOutput()` preserves original stdin='ignore' behavior when no stdin option is provided, only using `spawnWithStreamingIO()` internally when stdin string is given.
- Shared utilities `sendSinglePromptAndWait()` and `buildSingleUserInputMessageLine()` live in `src/common/process.ts` and are imported by both `claude_code.ts` and `subagent.ts`.
- Test mocks use proper `StreamingProcess` shape via `createStreamingProcessMock()` helper; no type-guard fallback path needed.
### Lessons Learned
- Initial implementation changed `spawnAndLogOutput()` stdin from 'ignore' to 'pipe' globally, which was caught in review as a critical backward-compatibility violation. The fix was to keep the legacy path when no stdin is provided.
- Test mocks returning the wrong shape (flat result vs StreamingProcess) can silently pass when production code has type-guard fallbacks, hiding real bugs. Better to fix mocks and remove dead code paths.
- Duplicated utility functions across modules should be consolidated early to avoid review churn.
### Risks / Blockers
- None
