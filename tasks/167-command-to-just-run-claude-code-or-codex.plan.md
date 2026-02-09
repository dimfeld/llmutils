---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Command to just run Claude Code or Codex
goal: ""
id: 167
uuid: b0cf87ed-ba48-4d26-b028-476cf38e0cff
generatedBy: agent
status: done
priority: medium
dependencies:
  - 166
parent: 160
references:
  "160": 514cedb9-6431-400a-a997-12d139376146
  "166": 783bf184-9ec5-4919-bf30-8ae618785f0c
planGeneratedAt: 2026-02-09T19:39:41.622Z
promptsGeneratedAt: 2026-02-09T19:39:41.622Z
createdAt: 2026-01-12T06:45:11.424Z
updatedAt: 2026-02-09T21:07:12.436Z
tasks:
  - title: Extend headless protocol command type
    done: true
    description: Update the command type union in src/tim/headless.ts
      (RunWithHeadlessOptions and CreateHeadlessAdapterOptions) to include
      'run-prompt' alongside 'agent' and 'review'. The
      HeadlessSessionInfo.command in headless_protocol.ts is already typed as
      string so it does not need changes.
  - title: Create run_prompt command handler
    done: true
    description: >-
      Create src/tim/commands/run_prompt.ts with handleRunPromptCommand().
      Implement:


      1. Executor alias resolution: map 'claude' to Claude Code spawning,
      'codex' to Codex CLI spawning. Default is 'claude'.


      2. JSON schema resolution: if --json-schema value starts with @, read from
      file path; otherwise use as inline JSON string. Validate JSON.


      3. Prompt resolution (priority order): --prompt-file > stdin (if
      !process.stdin.isTTY) > positional arg > error.


      4. Output routing: execution log to stderr via logger, final result text
      (or structured JSON) to stdout after execution. If --quiet, call
      setQuiet(true).


      5. Claude Code execution: spawn 'claude' with --no-session-persistence
      --verbose --output-format stream-json --print <prompt>. Add --model,
      --json-schema, --dangerously-skip-permissions (via ALLOW_ALL_TOOLS env
      var) as needed. Use spawnAndLogOutput with formatStdout using
      createLineSplitter + formatJsonMessage + extractStructuredMessages.
      Capture structuredOutput from result messages when json-schema used, or
      last result text otherwise. Create tunnel server for output forwarding.


      6. Codex execution: spawn 'codex exec' with --json, -c
      model_reasoning_effort=<level>, sandbox settings. If json-schema, write
      schema to temp file and pass via --output-schema. Use
      createCodexStdoutFormatter. Capture final agent message. Clean up temp
      files.


      7. Headless integration: wrap in runWithHeadlessAdapterIfEnabled with
      command 'run-prompt'.


      Reference patterns: src/tim/executors/claude_code.ts (executeReviewMode),
      src/tim/executors/codex_cli/codex_runner.ts (executeCodexStep).
  - title: Register tim run-prompt CLI command
    done: true
    description: >-
      Add the tim run-prompt command registration to src/tim/tim.ts near the
      other execution commands (agent/run). Options:

      - -x, --executor <name>: Executor shortname (claude or codex, default
      claude)

      - -m, --model <model>: Model to use

      - --reasoning-level <level>: Reasoning effort for Codex (low, medium,
      high, xhigh)

      - --json-schema <schema>: JSON schema for structured output (prefix with @
      for file path)

      - --prompt-file <path>: Read prompt from file

      - -q, --quiet: Suppress execution log on stderr


      Use dynamic import for the handler: const { handleRunPromptCommand } =
      await import('./commands/run_prompt.js').
  - title: Write tests for run_prompt command
    done: true
    description: >-
      Create src/tim/commands/run_prompt.test.ts. Extract arg building, prompt
      resolution, and schema resolution into testable pure functions within
      run_prompt.ts. Test:


      1. Prompt resolution: positional arg, file (write temp file and read),
      stdin detection

      2. Schema resolution: @path reads from file, inline JSON passes through,
      invalid JSON errors

      3. Claude Code args construction: with/without json-schema, model, quiet
      mode, ALLOW_ALL_TOOLS

      4. Codex args construction: with/without json-schema, reasoning level,
      sandbox settings

      5. Executor alias mapping: 'claude' and 'codex' map correctly, unknown
      executor errors

      6. Error handling: missing prompt produces clear error


      Do not mock spawnAndLogOutput or test actual process spawning—focus on
      pure function unit tests for the arg construction and input resolution
      logic.
  - title: Update README with run-prompt documentation
    done: true
    description: >-
      Add a section to README.md documenting the tim run-prompt command.
      Include:

      - Basic usage: tim run-prompt "What is 2 + 2?"

      - Using with Codex: tim run-prompt -x codex --reasoning-level high
      "prompt"

      - Structured JSON output: tim run-prompt --json-schema '...' "prompt"

      - Schema from file: tim run-prompt --json-schema @schema.json "prompt"

      - Reading from stdin: echo "prompt" | tim run-prompt

      - Reading from file: tim run-prompt --prompt-file task.md

      - Piping result: tim run-prompt "summarize this" > result.txt

      - Quiet mode: tim run-prompt -q "question" > answer.txt
changedFiles:
  - README.md
  - src/logging/console_formatter.test.ts
  - src/logging/console_formatter.ts
  - src/logging/structured_messages.ts
  - src/tim/commands/run_prompt.test.ts
  - src/tim/commands/run_prompt.ts
  - src/tim/executors/claude_code/format.test.ts
  - src/tim/executors/claude_code/format.ts
  - src/tim/executors/codex_cli/format.test.ts
  - src/tim/executors/codex_cli/format.ts
  - src/tim/headless.ts
  - src/tim/tim.ts
tags: []
---

This will allow us to run a raw Claude or Codex session to format the output and forward the structured output.

Optional arguments should be:
-x,--executor codex-cli|claude (default claude)
--model
--reasoning_level (for codex)
--json-schema (enable structured output, similarly to how we do for review mode)

--prompt-file (a file to read the prompt from)

If prompt-file is omitted, then the prompt should be read from stdin if "not a tty" and from the command line otherwise

## Research

### Overview

This plan adds a new `tim run-prompt` subcommand that allows running a raw Claude Code or Codex CLI session with a user-provided prompt, formatting output through the existing structured logging pipeline, and optionally producing structured JSON output via a JSON schema. The command serves as a simpler alternative to the full `tim agent` workflow when you just want to run a single prompt through an LLM without plan-based orchestration.

### Key Findings

#### Product & User Story

A user wants to run a one-shot prompt through Claude Code or Codex CLI without creating a plan file or going through agent orchestration. They provide a prompt (via stdin, file, or command line argument), optionally a JSON schema for structured output, and get formatted output with structured logging through the headless protocol.

Use cases:
- Quick one-off LLM tasks with structured output capture
- Scripting pipelines that need structured JSON output from an LLM
- Integration with the monitor dashboard (plan 160) to observe and control raw LLM sessions

#### Existing Executor Patterns

The codebase has well-established patterns for running both Claude Code and Codex CLI:

**Claude Code Executor** (`src/tim/executors/claude_code.ts`):
- Spawns `claude` CLI with `--verbose --output-format stream-json --print <prompt>`
- Uses `--json-schema <schema>` for structured output (used in `executeReviewMode`)
- Uses `--model <model>` for model selection (only passes through if it contains 'haiku', 'sonnet', or 'opus')
- Output parsed via `createLineSplitter()` + `formatJsonMessage()` + `extractStructuredMessages()`
- Result extraction from stream-json messages: looks for `result` type messages with `structuredOutput` field
- Uses `spawnAndLogOutput()` from `src/common/process.ts` for process management with inactivity timeouts
- Tunnel server created for output forwarding from child processes to parent via `TIM_OUTPUT_SOCKET`

**Codex CLI Executor** (`src/tim/executors/codex_cli/codex_runner.ts`):
- Spawns `codex exec --json <prompt>` with reasoning level via `-c model_reasoning_effort=<level>`
- Uses `--output-schema <path>` for structured output (file path to JSON schema, not inline)
- Uses `--sandbox workspace-write` or `--dangerously-bypass-approvals-and-sandbox`
- Output parsed via `createCodexStdoutFormatter()`
- Has retry logic (max 3 attempts) with thread resume support
- Reasoning levels: 'low', 'medium', 'high', 'xhigh' (from `codexReasoningLevelSchema`)

**Key Difference**: Claude uses `--json-schema <inline-json>`, while Codex uses `--output-schema <file-path>`. Both need a temp file or inline string for the schema.

#### Headless Protocol Integration

The headless protocol (plan 166, completed) provides structured output forwarding:

- `HeadlessAdapter` wraps a `LoggerAdapter` and forwards output over WebSocket
- `runWithHeadlessAdapterIfEnabled()` from `src/tim/headless.ts` is the standard integration point
- Session info includes: `command`, `planId`, `planTitle`, `workspacePath`, `gitRemote`
- The `command` field is currently typed as `'agent' | 'review'` — will need to add `'run-prompt'`
- URL resolved from `TIM_HEADLESS_URL` env var → config `headless.url` → default `ws://localhost:8123/tim-agent`

Current integration pattern in `agent.ts`:
```typescript
await runWithHeadlessAdapterIfEnabled({
  enabled: !isTunnelActive(),
  command: 'agent',
  config,
  plan: { id: resolvedPlan?.id, title: resolvedPlan?.title },
  callback: async () => { /* main logic */ },
});
```

#### CLI Structure

Tim uses Commander.js for CLI. Subcommands are registered in `src/tim/tim.ts` with dynamic imports to handlers in `src/tim/commands/`. The pattern:

```typescript
program
  .command('commandname [args]')
  .description('...')
  .option('-x, --executor <name>', '...')
  .action(async (args, options, command) => {
    const { handleCommandName } = await import('./commands/commandname.js');
    await handleCommandName(args, options, command.parent.opts()).catch(handleCommandError);
  });
```

#### Structured Output Handling

For review mode, the JSON schema is generated from Zod via `getReviewOutputJsonSchemaString()` in `src/tim/formatters/review_output_schema.ts`. For this new command, the user provides their own JSON schema string or file path.

The Claude Code executor captures structured output by looking at `result.structuredOutput` in the stream-json messages. If a `--json-schema` is passed, the result message includes a `structuredOutput` field that is either a string (JSON) or an object.

#### Prompt Input Patterns

The codebase uses several patterns for reading input:
- `rmrun.ts`: Reads from stdin if `!process.stdin.isTTY`, else from file, else from clipboard
- `Bun.stdin.text()` for reading all stdin
- `Bun.file(path).text()` for reading files
- Commander positional args for command-line text

#### Output Handling

The new command should:
1. Format and display output to the terminal via the existing structured message pipeline
2. Forward output through the headless protocol for the monitor dashboard
3. When `--json-schema` is used, capture and output the structured JSON result

### Design & UX Approach

**Command name**: `tim run-prompt` — avoids confusion with the existing `tim prompts` (plural) command which generates prompts from plan files.

**Executor aliases**: `-x claude` and `-x codex` as short aliases for the full `claude-code` and `codex-cli` executor names. The command defaults to `claude`.

**Input priority**: `--prompt-file <path>` > stdin (if not a TTY) > positional argument as the prompt text.

**JSON schema input**: `--json-schema` accepts either inline JSON or a file path prefixed with `@` (e.g. `--json-schema @schema.json`), following the curl convention.

**Output routing**:
- Execution log (formatted structured messages) goes to stderr
- Final result text (or structured JSON when `--json-schema` is used) goes to stdout
- This enables clean piping: `tim run-prompt "summarize" > summary.txt` or `tim run-prompt --json-schema '...' "prompt" > result.json`
- `--quiet` flag suppresses the execution log on stderr entirely

**Session persistence**: `--no-session-persistence` is passed to Claude Code by default since this is a one-shot command.

**Permissions**: Uses the existing `ALLOW_ALL_TOOLS` env var for dangerous mode; no explicit CLI flag.

**Headless protocol forwarding**: Output forwarded through headless protocol for dashboard integration.

### Technical Plan & Risks

**Risks**:
1. The headless `command` type is currently `'agent' | 'review'` — needs extension to include `'run-prompt'`
2. Claude's `--json-schema` takes inline JSON while Codex's `--output-schema` takes a file path — need to handle both
3. For Codex, the schema must be written to a temp file then cleaned up

**Complexity**: Medium. Most of the infrastructure exists; this is primarily composing existing pieces.

### Pragmatic Effort Estimate

This is a moderate-sized feature. The executor integration, prompt handling, and headless forwarding all have clear existing patterns to follow. Estimated 3-4 tasks.

## Expected Behavior/Outcome

- User can run `tim run-prompt "do something"` to send a one-shot prompt to Claude Code, with the result text on stdout
- User can run `echo "prompt" | tim run-prompt` to pipe a prompt from stdin
- User can run `tim run-prompt --prompt-file task.md` to read a prompt from a file
- User can run `tim run-prompt -x codex --reasoning-level high "do something"` to use Codex
- User can run `tim run-prompt --json-schema '{"type":"object",...}'` for structured JSON output to stdout
- User can run `tim run-prompt --json-schema @schema.json "prompt"` to load schema from a file
- User can run `tim run-prompt -q "question" > result.txt` to suppress execution log and capture only the result
- Execution log is formatted and displayed on stderr via the existing structured message pipeline
- Output is forwarded through the headless protocol for dashboard monitoring

### Acceptance Criteria

- [ ] `tim run-prompt "text"` runs Claude Code with the given prompt. Result text to stdout, execution log to stderr.
- [ ] `tim run-prompt --prompt-file <path>` reads the prompt from a file
- [ ] `echo "text" | tim run-prompt` reads the prompt from stdin when not a TTY
- [ ] `tim run-prompt -x codex "text"` runs Codex CLI instead of Claude
- [ ] `tim run-prompt --model <model>` passes the model to the executor
- [ ] `tim run-prompt --reasoning-level <level>` passes reasoning level to Codex
- [ ] `tim run-prompt --json-schema <schema>` enables structured JSON output to stdout
- [ ] `tim run-prompt --json-schema @path` loads the JSON schema from a file
- [ ] `tim run-prompt -q "text"` suppresses the execution log on stderr
- [ ] Output is forwarded through the headless protocol when enabled
- [ ] All new code paths are covered by tests

### Dependencies & Constraints

- **Dependencies**: Plan 166 (headless mode) must be done — it is marked done.
- **Technical Constraints**: Must handle both Claude Code and Codex CLI's different structured output mechanisms (inline JSON schema vs file path). Must handle prompt input from three sources (positional arg, file, stdin).

### Implementation Notes

**Recommended Approach**: Create a new `tim run-prompt` subcommand with a handler in `src/tim/commands/run_prompt.ts`. Reuse the existing executor spawning patterns from `claude_code.ts` (for Claude) and `codex_runner.ts` (for Codex), but strip away the plan-based orchestration. Integrate headless protocol forwarding using the existing `runWithHeadlessAdapterIfEnabled` pattern.

**Potential Gotchas**:
- The `HeadlessSessionInfo.command` field type needs to be expanded from `'agent' | 'review'` to include `'run-prompt'`
- When using `--json-schema` with Codex, the schema needs to be written to a temp file, then passed via `--output-schema`, and the temp file cleaned up afterward
- Need to ensure that reading from stdin works correctly with Bun's `Bun.stdin.text()` — it blocks if stdin is a TTY
- Execution log must go to stderr, result to stdout. The `log()` function writes to stderr by default via the logger adapter, but `spawnAndLogOutput` may write to stdout — need to ensure the `formatStdout` callback routes structured messages to stderr via the logger
- The `--json-schema @path` convention needs to check if the value starts with `@`, then read the file, and use the contents as the schema string

## Implementation Guide

### Step 1: Extend Headless Protocol Command Type

**Files**: `src/tim/headless.ts`

Extend the `command` field type in `RunWithHeadlessOptions` and `CreateHeadlessAdapterOptions` from `'agent' | 'review'` to include `'run-prompt'`. Note that `HeadlessSessionInfo.command` in `headless_protocol.ts` is already typed as `string`, so it doesn't need changes.

Check all locations where the command type union is used and add `'run-prompt'` to it.

### Step 2: Create the Run-Prompt Command Handler

**Files**: `src/tim/commands/run_prompt.ts` (new file)

Create `handleRunPromptCommand(promptText, options, globalOpts)` following the pattern of other command handlers.

**Executor alias resolution**:
Map short names to full names: `'claude'` → uses Claude Code spawning, `'codex'` → uses Codex CLI spawning. Default is `'claude'`.

**JSON schema resolution**:
If `--json-schema` value starts with `@`, read the remainder as a file path and load the schema from that file. Otherwise use the value as an inline JSON string. Validate that the string is valid JSON.

**Prompt resolution logic** (in priority order):
1. If `--prompt-file <path>` is provided, read from the file using `Bun.file(path).text()`
2. Else if stdin is not a TTY (`!process.stdin.isTTY`), read from stdin using `Bun.stdin.text()`
3. Else use the positional argument `promptText`
4. If no prompt is available from any source, print an error and exit

**Output routing**:
- The execution log (structured messages from `formatStdout`) must be written to stderr. The `log()` function already writes to the logger adapter which defaults to stderr through the console. Use `extractStructuredMessages()` on the parsed output and write them to stderr via the logging pipeline.
- The final result text (or structured JSON) must be written to stdout at the end, after execution completes.
- If `--quiet` is set, call `setQuiet(true)` from `src/common/process.ts` to suppress execution logging.

**Core execution logic for Claude Code**:
- Build args: `['claude', '--no-session-persistence', '--verbose', '--output-format', 'stream-json', '--print', prompt]`
- Add `--model <model>` if specified
- Add `--json-schema <schema>` if `--json-schema` option provided (resolved inline string)
- Support `ALLOW_ALL_TOOLS` env var: if set to `true`/`1`, add `--dangerously-skip-permissions`
- Create a tunnel server for output forwarding (same pattern as `executeReviewMode`)
- Use `spawnAndLogOutput()` with a `formatStdout` callback that uses `createLineSplitter()` + `formatJsonMessage()` + `extractStructuredMessages()` to format output
- Capture the result: look for `result.structuredOutput` when json-schema is used, or the last `result` message text otherwise
- After execution, write the captured result to stdout

**Core execution logic for Codex CLI**:
- Build args: `['codex', '--enable', 'web_search_request', 'exec', '-c', 'model_reasoning_effort=<level>', '--json', prompt]`
- Add sandbox settings based on `ALLOW_ALL_TOOLS` env var
- If `--json-schema` is provided, write the resolved schema to a temp file and add `--output-schema <tempFilePath>`
- Use `spawnAndLogOutput()` with `createCodexStdoutFormatter()` for output formatting
- Capture the final agent message via `formatter.getFinalAgentMessage()`
- Clean up temp schema file in a `finally` block
- After execution, write the captured result to stdout

**Headless integration**:
- Load config via `loadEffectiveConfig(globalOpts.config)`
- Wrap the entire execution in `runWithHeadlessAdapterIfEnabled()` with `command: 'run-prompt'`

### Step 3: Register the CLI Command in tim.ts

**Files**: `src/tim/tim.ts`

Add the `tim run-prompt` command registration near the other execution commands (agent/run):

```typescript
program
  .command('run-prompt [prompt]')
  .description('Run a one-shot prompt through Claude Code or Codex CLI. Result is printed to stdout.')
  .option('-x, --executor <name>', 'Executor to use: claude (default) or codex', 'claude')
  .option('-m, --model <model>', 'Model to use for the LLM')
  .option('--reasoning-level <level>', 'Reasoning effort level for Codex (low, medium, high, xhigh)')
  .option('--json-schema <schema>', 'JSON schema for structured output (prefix with @ to load from file)')
  .option('--prompt-file <path>', 'Read the prompt from a file')
  .option('-q, --quiet', 'Suppress execution log output on stderr')
  .action(async (promptText, options, command) => {
    const { handleRunPromptCommand } = await import('./commands/run_prompt.js');
    await handleRunPromptCommand(promptText, options, command.parent.opts()).catch(handleCommandError);
  });
```

### Step 4: Write Tests

**Files**: `src/tim/commands/run_prompt.test.ts` (new file)

Extract the arg building, prompt resolution, and schema resolution logic into testable pure functions within `run_prompt.ts`. Then test:

1. **Prompt resolution**: Test that prompt is correctly resolved from positional arg, file, and stdin (mock `process.stdin.isTTY`)
2. **Schema resolution**: Test `@path` convention reads from file, inline JSON passes through, invalid JSON errors
3. **Claude Code args construction**: Test that the correct CLI args are built with and without JSON schema, model, quiet mode
4. **Codex args construction**: Test that the correct CLI args are built with and without JSON schema, reasoning level
5. **Executor alias mapping**: Test that `'claude'` and `'codex'` map correctly
6. **Error handling**: Test that missing prompt produces a clear error

Focus on unit-testing the arg building, prompt resolution, and schema resolution logic. The actual spawning of Claude/Codex doesn't need to be tested since the underlying `spawnAndLogOutput` is already tested.

### Step 5: Update README

**Files**: `README.md`

Add documentation for the new `tim run-prompt` command with usage examples:
- Basic usage: `tim run-prompt "What is 2 + 2?"`
- Using with Codex: `tim run-prompt -x codex --reasoning-level high "prompt"`
- Structured JSON output: `tim run-prompt --json-schema '...' "prompt"`
- Reading from stdin: `echo "prompt" | tim run-prompt`
- Reading from file: `tim run-prompt --prompt-file task.md`
- Piping result: `tim run-prompt "summarize this" > result.txt`
- Quiet mode: `tim run-prompt -q "question" > answer.txt`

### Manual Testing Steps

1. `tim run-prompt "What is 2 + 2?"` — should run Claude, show execution log on stderr, print result text to stdout
2. `echo "What is 2 + 2?" | tim run-prompt` — should read from stdin
3. `tim run-prompt --prompt-file /tmp/test-prompt.txt` — should read from file
4. `tim run-prompt -x codex --reasoning-level high "What is 2 + 2?"` — should use Codex
5. `tim run-prompt --json-schema '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}' "What is the capital of France? Reply with JSON."` — should output structured JSON to stdout
6. `tim run-prompt --json-schema @/tmp/schema.json "prompt"` — should load schema from file
7. `tim run-prompt -q "What is 2 + 2?" > /tmp/answer.txt` — should capture result only, no log noise
8. Test with `TIM_HEADLESS_URL` set to verify headless forwarding

## Current Progress
### Current State
- Core `run-prompt` implementation is complete, including follow-up fixes for structured-output parsing, executor-specific option handling, and `ALLOW_ALL_TOOLS` dependency injection.
- README coverage is complete for `run-prompt` usage and examples, and the quick command reference now places `run-prompt` with execution commands (`agent`/`run`) for consistency.
- Reviewer compatibility fix is complete: `run-prompt` alias resolution and docs/help now accept `codex-cli`/`claude-code`.
- Console formatter cleanup is complete: duplicate command rendering in `command_result` has been removed.

### Completed (So Far)
- Updated `src/tim/headless.ts` command unions to accept `run-prompt`.
- Implemented `src/tim/commands/run_prompt.ts` with executor alias resolution, prompt/schema resolution, Claude/Codex execution, and headless wrapping.
- Registered `run-prompt` in `src/tim/tim.ts`.
- Updated Claude model handling in `run_prompt`: unrecognized `--model` values now warn and omit `--model`, allowing Claude CLI defaults instead of forcing `opus`.
- Updated Codex timeout handling so a timeout only errors when no final agent message was captured, preserving valid output if the final message arrives before inactivity kill.
- Updated Codex run-prompt execution so a detected FAILED agent message sets `process.exitCode = 1` while still returning the message body.
- Added `stdinIsTTY` to `RunPromptCommandDeps` and routed `handleRunPromptCommand` prompt resolution through it to remove brittle `process.stdin` mutation from tests.
- Updated structured JSON normalization to accept markdown-fenced JSON payloads before parsing, so Codex schema-mode output can be parsed even when wrapped in code fences.
- Added a warning when `--reasoning-level` is used with the Claude executor, matching existing warning behavior for executor-specific option misuse.
- Updated `README.md` with a dedicated `run-prompt` section and complete command examples for default usage, Codex reasoning level, inline/file schema, stdin/file prompts, piping, and quiet mode.
- Added a dedicated `tim run-prompt --model ...` usage example in `README.md` so model selection is visible in the examples section (not only in the command reference).
- Added `envAllowAllTools` to `RunPromptCommandDeps` and updated `handleRunPromptCommand` to use the injected value before falling back to `process.env`.
- Reorganized the complete command reference in `README.md` so `run-prompt` appears with execution commands instead of utilities.
- Restored `cwd` display in `src/logging/console_formatter.ts` for `command_result` so begin/finish command logs remain symmetric, with coverage in `src/logging/console_formatter.test.ts`.
- Added `cwd?: string` to `CommandResultMessage` in `src/logging/structured_messages.ts` so the restored formatter output is fully type-safe.
- Updated `resolveExecutorAlias` in `src/tim/commands/run_prompt.ts` to accept `claude-code` and `codex-cli`, normalized to internal executor values.
- Updated run-prompt CLI/help text in `src/tim/tim.ts` and command-reference docs in `README.md` so accepted executor names are listed consistently.
- Removed duplicate command rendering in `src/logging/console_formatter.ts` for `command_result` and added formatter coverage to assert a single command line rendering.
- Added regression coverage in `src/tim/commands/run_prompt.test.ts` verifying `codex-cli` and `claude-code` alias resolution.

### Remaining
- Perform manual command-level validation against live executors for stdin/file/json-schema flows.

### Next Iteration Guidance
- Keep further changes scoped to live runtime validation unless new defects are observed.
- During manual validation, confirm Codex schema output remains parseable in both raw JSON and fenced JSON forms.
- If additional executor naming aliases are introduced later, extend `resolveExecutorAlias` and docs/help in the same change.

### Decisions / Changes
- Quiet behavior remains logger-adapter scoped so local stderr logging can be suppressed without suppressing structured/headless forwarding.
- Claude formatter cache handling should follow existing caller pattern by resetting cache at the start of each run.
- `--model` is treated as Claude-only for `run-prompt`; Codex now emits an explicit warning instead of silently dropping the option.
- For Claude run-prompt, provided model names are validated against existing family convention (`haiku`/`sonnet`/`opus`); invalid values now trigger a warning and omit `--model` so Claude CLI can choose its own default.
- For Codex run-prompt, FAILED agent messages are now treated as command failure for scripting by setting a non-zero process exit code.
- Prompt-source TTY behavior is now dependency-injected in the command handler for stable tests and reduced global process mutation.
- For Codex run-prompt timeouts, a captured final message is treated as sufficient completion to avoid discarding valid output on inactivity kill.
- Structured-output normalization now strips optional markdown code fences before JSON parse to reduce Codex-output fragility in schema mode.
- `--reasoning-level` is treated as Codex-only with explicit warning when supplied to Claude, matching the existing `--model` warning on Codex.
- `ALLOW_ALL_TOOLS` resolution for run-prompt is now dependency-injectable (`envAllowAllTools`) so tests can cover true/false behavior deterministically.
- The `run-prompt` examples now explicitly show `--model` usage to match acceptance criteria visibility in quick-start docs.
- In the quick command reference, `run-prompt` is intentionally grouped with execution commands for consistency with the main documentation flow.
- `command_result` keeps `cwd` visible (matching `command_exec`) to preserve start/end context symmetry in console logs.
- `command_result` schema now permits optional `cwd`, aligning message typing with formatter rendering.
- Executor aliases for run-prompt are now intentionally permissive at the CLI edge (`claude`, `claude-code`, `codex`, `codex-cli`) while preserving internal normalized values.
- `command_result` now prints the command once to avoid duplicate lines while keeping existing header/cwd/exit/stdout/stderr ordering.

### Risks / Blockers
- None

## Unresolved Review Issues

### Tasks Worked On

- Extend headless protocol command type
- Create run_prompt command handler
- Register tim run-prompt CLI command
- Write tests for run_prompt command

### Review Output

# Code Review Report
**Plan:** 167 - Command to just run Claude Code or Codex
**Date:** 2/9/2026, 10:36:59 AM
**Base Branch:** main

## Summary
- **Total Issues:** 3
- **Files Reviewed:** 10

### Issues by Severity
- Critical: 0
- Major: 0
- Minor: 2
- Info: 1

### Issues by Category
- Bug: 1
- Testing: 1
- Other: 1

## Issues Found
### Minor Issues

#### 1. When stdin is not a TTY and provides whitespace-only input, `resolvePromptText` throws 'Prompt is required' even when a valid positional argument is available. The priority order (prompt-file > stdin > positional arg) means `tim run-prompt "my prompt" < /dev/null` will fail. This is confirmed as the intended behavior by the test at line 58-68 and matches the plan's specified priority order, but may surprise users who pipe empty stdin while also providing a positional arg.
**Category:** bug
**File:** src/tim/commands/run_prompt.ts:140-166


**Suggestion:** Consider falling through to the positional arg when stdin is available but empty/whitespace-only, or document this behavior clearly in the help text.

#### 2. `handleRunPromptCommand` reads `process.env.ALLOW_ALL_TOOLS` directly at line 520 rather than accepting it via the `deps` injection parameter. This means the integration test that verifies option threading to the executor (line 437-462) cannot test the `allowAllTools=true` path without mutating the actual process environment. This is inconsistent with the otherwise thorough dependency injection approach used throughout the handler.
**Category:** testing
**File:** src/tim/commands/run_prompt.ts:520


**Suggestion:** Add an optional `envAllowAllTools` field to `RunPromptCommandDeps` so the `allowAllTools` path can be unit tested without environment mutation.

### Info Issues

#### 1. Pre-existing: `console_formatter.ts` is listed as a changed file in the review scope but has no diff from main — it's a dirty working tree file unrelated to this PR.
**Category:** other
**File:** src/logging/console_formatter.ts:1


**Suggestion:** No action needed; this file is not part of the actual changeset.

## Recommendations
- The implementation is well-structured and follows established codebase patterns. No architectural recommendations.

## Action Items
- [x] Optional: Inject ALLOW_ALL_TOOLS via deps parameter for better testability of the allowAllTools code path
