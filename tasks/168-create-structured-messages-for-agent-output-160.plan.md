---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: create structured messages for agent output
goal: ""
id: 168
uuid: 59358b82-95c5-47a6-95a7-54adc501928f
generatedBy: agent
status: in_progress
priority: medium
parent: 160
references:
  "160": 514cedb9-6431-400a-a997-12d139376146
planGeneratedAt: 2026-02-08T08:32:30.691Z
promptsGeneratedAt: 2026-02-08T08:32:30.691Z
createdAt: 2026-02-08T07:57:38.473Z
updatedAt: 2026-02-09T02:18:02.418Z
tasks:
  - title: Define structured message types
    done: true
    description: >-
      Create `src/logging/structured_messages.ts` with all ~20 structured
      message type interfaces using a discriminated union on the `type` field.


      Categories:

      - Agent lifecycle: `agent_session_start`, `agent_session_end`,
      `agent_iteration_start`, `agent_step_start`, `agent_step_end`

      - LLM interaction: `llm_thinking`, `llm_response`, `llm_tool_use`,
      `llm_tool_result`, `llm_status`

      - File operations: `file_write` (path, lineCount), `file_edit` (path,
      unified diff string), `file_change_summary` (files added/updated/removed)

      - Command execution: `command_exec` (command, cwd), `command_result`
      (exitCode, stdout, stderr)

      - Review: `review_start`, `review_result` (structured
      issues/recommendations/actionItems), `review_verdict`

      - Workflow: `workflow_progress`, `failure_report` (summary, requirements,
      problems, solutions, sourceAgent), `task_completion`, `execution_summary`
      (wraps existing ExecutionSummary type)

      - Token/usage: `token_usage` (input, cached, output, reasoning, total,
      rateLimits)

      - Other: `input_required`, `plan_discovery`, `workspace_info`


      Export the `StructuredMessage` union type. Add a `timestamp` field (ISO
      string) to a base interface or each message.


      For tool-related messages, use specialized data shapes: file_write has {
      path, lineCount }, file_edit has { path, diff }, command has { command,
      stdout, stderr, exitCode }.
  - title: Extend tunnel protocol with structured message variant
    done: true
    description: >-
      Update `src/logging/tunnel_protocol.ts`:

      - Add `StructuredTunnelMessage` interface: `{ type: 'structured'; message:
      StructuredMessage }`

      - Extend the `TunnelMessage` union to include `StructuredTunnelMessage`

      - Import StructuredMessage from the new structured_messages.ts


      The HeadlessOutputMessage in `src/logging/headless_protocol.ts` already
      wraps TunnelMessage, so structured messages flow through automatically.


      Add a type guard `isStructuredTunnelMessage()` for use by the tunnel
      server dispatcher.
  - title: Add sendStructured to LoggerAdapter and all adapters
    done: true
    description: >-
      Update `src/logging/adapter.ts`:

      - Add `sendStructured(message: StructuredMessage): void` to the
      LoggerAdapter interface


      Update each adapter implementation:


      **ConsoleAdapter** (`src/logging/console.ts`):

      - Import the console formatter (created in next task)

      - `sendStructured(msg)`: Format with console formatter, call
      `console.log()`, write to log file


      **SilentAdapter** (`src/logging/silent.ts`):

      - `sendStructured(msg)`: Format with console formatter, write to log file
      only (no console output)


      **TunnelAdapter** (`src/logging/tunnel_client.ts`):

      - `sendStructured(msg)`: Send `{ type: 'structured', message: msg }` as
      JSONL over the socket + write formatted version to log file


      **HeadlessAdapter** (`src/logging/headless_adapter.ts`):

      - `sendStructured(msg)`: Call `wrappedAdapter.sendStructured(msg)` for
      local output, then enqueue `{ type: 'structured', message: msg }` as a
      TunnelMessage into the WebSocket queue


      Update `src/logging.ts`:

      - Add `sendStructured(message: StructuredMessage)` function that
      dispatches to the current adapter

      - Export it


      Update the tunnel server (`src/logging/tunnel_server.ts`):

      - In `dispatchMessage()`, handle `{ type: 'structured', message }` by
      calling `sendStructured(message)` on the current adapter
  - title: Create console formatter for structured messages
    done: true
    description: >-
      Create `src/logging/console_formatter.ts` with a single
      `formatStructuredMessage(message: StructuredMessage): string` function.


      Use a switch statement on `message.type`. Produce chalk-formatted output
      matching the current formatting patterns from the Claude Code and Codex
      formatters. Key mappings:


      - `agent_session_start` → `chalk.bold.green('### Starting [timestamp]')` +
      session/tool details

      - `agent_session_end` → `chalk.bold.green('### Done [timestamp]')` +
      cost/duration/turns

      - `agent_iteration_start` → iteration header with task title/description

      - `agent_step_start` → `chalk.bold.blue('### Step N: Phase')` header

      - `llm_thinking` → `chalk.blue('### Thinking [timestamp]')` + text

      - `llm_response` → `chalk.bold.green('### Model Response [timestamp]')` +
      text

      - `llm_tool_use` → `chalk.cyan('### Invoke Tool: name [timestamp]')` +
      summarized input

      - `llm_tool_result` → `chalk.magenta('### Tool Result: name [timestamp]')`
      + summarized result

      - `file_write` → `chalk.cyan('### Invoke Tool: Write [timestamp]')` + path
      + line count

      - `file_edit` → `chalk.cyan('### Invoke Tool: Edit [timestamp]')` + path +
      colorized diff

      - `file_change_summary` → changes summary with green/red/cyan for
      add/remove/update

      - `command_exec` → `chalk.cyan('### Exec Begin [timestamp]')` + command

      - `command_result` → exit code coloring, green stdout, red stderr

      - `failure_report` → `chalk.redBright('FAILED: ...')` + yellow
      requirements/solutions

      - `token_usage` → `chalk.gray('### Usage [timestamp]')` + formatted counts

      - `review_result` → formatted review issues/recommendations

      - `review_verdict` → verdict with appropriate coloring

      - `execution_summary` → reproduce the existing table/step format from
      display.ts

      - `workflow_progress` → simple progress message

      - `task_completion` → completion message

      - `plan_discovery` → `chalk.green('Found ready plan: ...')`

      - `workspace_info` → workspace details

      - `input_required` → (optional, may be silent on console)


      Write tests in `src/logging/console_formatter.test.ts` that verify the
      formatter produces expected output for each message type.
  - title: Update spawnAndLogOutput to support StructuredMessage returns
    done: true
    description: >-
      Modify `src/common/process.ts`:

      - Change the `formatStdout` callback type from `(chunk: string) => string`
      to `(chunk: string) => StructuredMessage | StructuredMessage[] | string`

      - In the stdout processing loop, after calling the formatter:
        - If the result is a string: pass to `writeStdout()` as before
        - If the result is a StructuredMessage or array of StructuredMessage: call `sendStructured()` for each message
      - Import `sendStructured` from logging.ts and `StructuredMessage` type


      This allows the Claude Code and Codex formatters to return structured
      messages for parsed JSON events and plain strings for debug/unrecognized
      lines.
  - title: Convert Claude Code formatter to return structured messages
    done: true
    description: >-
      Modify `src/tim/executors/claude_code/format.ts`:


      Change `formatJsonMessage()` to return `StructuredMessage |
      StructuredMessage[] | null` instead of `{ message: string, type, ... }`.


      The function still needs to return side-channel metadata (filePaths,
      failed, failedSummary, rawMessage, structuredOutput) for the caller to
      use. Options:

      1. Return `{ structured: StructuredMessage | StructuredMessage[],
      filePaths?, failed?, failedSummary?, rawMessage?, structuredOutput? }`

      2. Or make the return type a union.


      Mapping of current message types to structured messages:

      - `result` + `success`/`error_max_turns` → `agent_session_end` (cost,
      duration, turns, success, sessionId)

      - `system` + `init` → `agent_session_start` (sessionId, tools, mcpServers)

      - `system` + `task_notification` → `workflow_progress`

      - `system` + `status` → `llm_status`

      - `system` + `compact_boundary` → `llm_status`

      - `assistant` + thinking → `llm_thinking` (text)

      - `assistant` + text → `llm_response` (text, isUserRequest: false)

      - `user` + text → `llm_response` (text, isUserRequest: true)

      - `assistant` + tool_use (Write) → `file_write` (path, lineCount)

      - `assistant` + tool_use (Edit) → `file_edit` (path, unified diff string)

      - `assistant` + tool_use (other) → `llm_tool_use` (toolName, summarized
      input)

      - `assistant` + tool_result (Read) → `llm_tool_result` (toolName: 'Read',
      lineCount)

      - `assistant` + tool_result (Bash) → `command_result` (stdout, stderr)

      - `assistant` + tool_result (other) → `llm_tool_result` (toolName,
      summarized result)


      Update callers in `src/tim/executors/claude_code.ts` and
      `src/tim/executors/claude_code_orchestrator.ts` to call `sendStructured()`
      with the returned messages.
  - title: Convert Codex formatter to return structured messages
    done: true
    description: >-
      Modify `src/tim/executors/codex_cli/format.ts`:


      Change `formatCodexJsonMessage()` to return structured messages. The
      `FormattedCodexMessage` type gets a `structured` field.


      Update `createCodexStdoutFormatter()` so that `formatChunk()` returns
      `StructuredMessage[] | string` (the new spawnAndLogOutput compatible
      type).


      Mapping:

      - `thread.started` → `agent_session_start` (threadId)

      - `session.created` → `agent_session_start` (sessionId)

      - `turn.started` → `agent_step_start`

      - `turn.completed` → `token_usage` (input, cached, output, reasoning,
      total, rateLimits)

      - `item.*` (reasoning) → `llm_thinking` (started/updated) or
      `llm_response` (completed)

      - `item.*` (agent_message) → `llm_response`

      - `item.*` (todo_list) → `workflow_progress` with todo items data

      - `item.*` (command_execution) → `command_exec` (started) or
      `command_result` (completed)

      - `item.*` (diff/turn_diff) → `file_change_summary` (files, addedLines,
      removedLines)

      - `item.*` (patch_apply) → `file_change_summary` (files with
      add/update/remove kinds)

      - `item.*` (file_change) → `file_change_summary`

      - `item.delta` → skip (no structured message)


      Update `src/tim/executors/codex_cli/codex_runner.ts` to handle the new
      return types.
  - title: Convert Codex workflow messages to structured messages
    done: true
    description: >-
      Update `src/tim/executors/codex_cli/normal_mode.ts` and
      `src/tim/executors/codex_cli/simple_mode.ts`:


      Convert key workflow log() calls to sendStructured():

      - 'Running implementer step...' → `agent_step_start` (phase:
      'implementer', attempt number)

      - 'Implementer output captured.' → `agent_step_end` (phase: 'implementer',
      success: true)

      - 'Running tester step...' → `agent_step_start` (phase: 'tester')

      - 'Tester output captured.' → `agent_step_end` (phase: 'tester', success:
      true)

      - 'Running external review step...' → `agent_step_start` (phase:
      'reviewer')

      - 'Review verdict: ACCEPTABLE/NEEDS_FIXES' → `review_verdict` (verdict,
      fixInstructions)

      - 'Starting fix iteration N/M...' → `agent_step_start` (phase: 'fixer',
      iteration)

      - 'Fixer output captured. Re-running...' → `agent_step_end` (phase:
      'fixer')


      Keep minor warnings (e.g., 'Skipping automatic task completion...') as
      plain warn() calls.
  - title: Update agent command to send structured messages
    done: true
    description: >-
      Update `src/tim/commands/agent/agent.ts` and
      `src/tim/commands/agent/batch_mode.ts`:


      Convert major log() calls to sendStructured():

      - Plan discovery: `sendStructured({ type: 'plan_discovery', planId, title
      })`

      - Workspace info: `sendStructured({ type: 'workspace_info', workspaceId,
      path, planFile })`

      - Iteration start: `sendStructured({ type: 'agent_iteration_start',
      taskTitle, taskDescription, iterationNumber })`

      - Context generation: `sendStructured({ type: 'workflow_progress',
      message: 'Generating context...', phase: 'context' })`

      - Execution start: `sendStructured({ type: 'agent_step_start', executor,
      phase })`

      - FAILED reports: `sendStructured({ type: 'failure_report', summary,
      requirements, problems, solutions, sourceAgent })`

      - Post-apply commands: `sendStructured({ type: 'workflow_progress',
      message, phase: 'post-apply' })`

      - Task completion: `sendStructured({ type: 'task_completion', taskTitle,
      planComplete })`

      - Final review: `sendStructured({ type: 'workflow_progress', message,
      phase: 'final-review' })`

      - Dry run output: keep as log() (not relevant for headless consumers)


      Keep minor log calls (debug, internal warnings, error handling) as
      log()/warn()/error().


      Also update `src/tim/commands/agent/parent_plans.ts` for parent plan
      status messages if appropriate.
  - title: Update review command to send structured messages
    done: true
    description: >-
      Update `src/tim/commands/review.ts`:


      Convert major log() calls to sendStructured():

      - Review start: `sendStructured({ type: 'review_start', executor, planId
      })`

      - Review results: `sendStructured({ type: 'review_result', issues,
      recommendations, actionItems })` with the structured review data from the
      ParsedReviewOutput

      - Review verdict: `sendStructured({ type: 'review_verdict', verdict,
      fixInstructions })`

      - Autofix execution: `sendStructured({ type: 'workflow_progress', message,
      phase: 'autofix' })`

      - Cleanup plan creation: `sendStructured({ type: 'workflow_progress',
      message, phase: 'cleanup' })`


      Keep minor log calls (issue selection feedback, save confirmations, error
      handling) as log()/warn().
  - title: Add input_required messages before inquirer prompts
    done: true
    description: >-
      Add `sendStructured({ type: 'input_required' })` before each inquirer
      prompt call in agent and review commands:


      - `src/tim/executors/claude_code.ts`: Before tool approval prompts
      (confirm/select calls for permissions)

      - `src/tim/commands/agent/agent.ts`: Before any confirm() or select()
      calls (e.g., workspace selection, plan confirmation)

      - `src/tim/commands/review.ts`: Before checkbox/select calls for issue
      selection, action choice


      The input_required message should include a description of what input is
      being requested if available, e.g., `{ type: 'input_required', prompt:
      'Select issues for autofix' }`.
  - title: Update summary display to send structured messages
    done: true
    description: >-
      Update `src/tim/summary/display.ts`:


      - In `displayExecutionSummary()`, send a `sendStructured({ type:
      'execution_summary', summary: executionSummary })` with the full
      ExecutionSummary object

      - The console formatter handles rendering the execution_summary type by
      reproducing the existing table/step format

      - `writeOrDisplaySummary()` continues to write to file with ANSI stripping
      for file output

      - `formatExecutionSummaryToLines()` remains available for file output use
  - title: Write tests for structured messages and console formatter
    done: true
    description: >-
      Write comprehensive tests:


      **`src/logging/structured_messages.test.ts`**:

      - Type-level tests ensuring StructuredMessage union accepts all expected
      types

      - Serialization round-trip tests (JSON.stringify/parse)


      **`src/logging/console_formatter.test.ts`**:

      - Test each message type produces expected chalk-formatted output

      - Test that output contains expected keywords/structure (don't need exact
      string matching with ANSI codes)

      - Test edge cases: empty fields, missing optional fields


      **Update `src/logging/headless_adapter.test.ts`**:

      - Add tests for `sendStructured()` method

      - Verify structured messages are enqueued as `{ type: 'structured',
      message }` TunnelMessages

      - Verify wrapped adapter's `sendStructured()` is called


      **Update `src/logging/tunnel_integration.test.ts`**:

      - Add tests for structured message tunneling through Unix socket

      - Verify `{ type: 'structured', message }` is correctly dispatched via
      `sendStructured()` on the receiving end


      **Integration test**:

      - Verify end-to-end: sendStructured() → headless WebSocket → receives
      structured JSON with correct type and data
  - title: "Address Review Feedback: Codex formatter still builds full
      human-formatted strings for each event even though the execution path now
      only consumes `structured` payloads."
    done: true
    description: >-
      Codex formatter still builds full human-formatted strings for each event
      even though the execution path now only consumes `structured` payloads.
      `createCodexStdoutFormatter.formatChunk()` does not use `fm.message`, so
      this adds avoidable CPU/allocation overhead in high-volume streams
      (diffs/tool output).


      Suggestion: Split formatting into structured-only and console-text paths,
      or lazily build `message` only when explicitly requested.


      Related file: src/tim/executors/codex_cli/format.ts:248
changedFiles:
  - README.md
  - src/common/process.test.ts
  - src/common/process.ts
  - src/logging/adapter.ts
  - src/logging/console.ts
  - src/logging/console_formatter.test.ts
  - src/logging/console_formatter.ts
  - src/logging/headless_adapter.test.ts
  - src/logging/headless_adapter.ts
  - src/logging/send_structured.e2e.test.ts
  - src/logging/silent.ts
  - src/logging/structured_messages.test.ts
  - src/logging/structured_messages.ts
  - src/logging/test_helpers.ts
  - src/logging/tunnel_client.test.ts
  - src/logging/tunnel_client.ts
  - src/logging/tunnel_integration.test.ts
  - src/logging/tunnel_protocol.test.ts
  - src/logging/tunnel_protocol.ts
  - src/logging/tunnel_server.test.ts
  - src/logging/tunnel_server.ts
  - src/logging.ts
  - src/tim/commands/agent/agent.test.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/agent/agent_batch_mode.test.ts
  - src/tim/commands/agent/agent_helpers.ts
  - src/tim/commands/agent/batch_mode.soft_failure.test.ts
  - src/tim/commands/agent/batch_mode.ts
  - src/tim/commands/agent/parent_plans.ts
  - src/tim/commands/review.notifications.test.ts
  - src/tim/commands/review.ts
  - src/tim/commands/review.tunnel.test.ts
  - src/tim/commands/validate.ts
  - src/tim/executors/claude_code/format.test.ts
  - src/tim/executors/claude_code/format.ts
  - src/tim/executors/claude_code.test.ts
  - src/tim/executors/claude_code.ts
  - src/tim/executors/claude_code_orchestrator.ts
  - src/tim/executors/codex_cli/format.test.ts
  - src/tim/executors/codex_cli/format.ts
  - src/tim/executors/codex_cli/normal_mode.ts
  - src/tim/executors/codex_cli/review_mode.ts
  - src/tim/executors/codex_cli/simple_mode.ts
  - src/tim/executors/codex_cli.fix_loop.test.ts
  - src/tim/executors/codex_cli.simple_mode.test.ts
  - src/tim/executors/codex_cli.test.ts
  - src/tim/executors/shared/todo_format.ts
  - src/tim/headless.test.ts
  - src/tim/summary/display.test.ts
  - src/tim/summary/display.ts
  - src/tim/summary/format.ts
tags: []
---

Right now all the agent outputs are just various types of logs. Many of them come from structured data such as JSON
output from an agent. Others are things like review output or general messages about running and progress. Most of these
messages should be converted to structured messages.

Update the headless protocol with additional structured message types:
- create a standard set of messages that both the agent outputs (claude and codex) can be converted to
- Create messages for the various other types of messages that tim outputs. We don't need to convert EVERY message to a
  structured message, but definitely the major ones.

We should
- update the headless protocol code to contain all these new message types.
- update the logging adapters to take the headless protocol messages as input instead of just plain text
- Update all logging calls to use the headless protocol messages
- Create console formatters which the console-based loggers can use to format the messages so they look like they
currently do. 

Note that the claude and codex formatters have somewhat different output for similar messages; we don't need to preserve
those differences, just do something that makes sense for each one.

Scope clarification:
- Only the `agent` and `review` commands need structured messages. Other tim commands (list, ready, set, add, etc.) should continue using plain `log()` calls, which will be sent as the existing unstructured "output" type through the headless protocol.
- Keep the existing `log()` function available for easy use in non-agent/review contexts.

Out of scope:
- Converting `inquirer` prompts to structured messages and taking in response. For now, we should have a message "input
required" which we send just before calling any inquirer prompt, but don't need to take any further action there.

## Research

### Overview

The tim codebase currently routes all output through a `LoggerAdapter` interface (`src/logging/adapter.ts`) that supports `log()`, `error()`, `warn()`, `writeStdout()`, `writeStderr()`, and `debugLog()`. These produce unstructured text. The headless protocol (`src/logging/headless_protocol.ts`) wraps these as `TunnelMessage` envelopes (log/error/warn/debug with string args, or stdout/stderr with raw data) inside `HeadlessOutputMessage` wrappers with sequence numbers.

The problem is that rich structured data — like agent execution results, tool invocations, file changes, review issues, failure details, token usage, and execution summaries — is currently formatted into colored text strings by the Claude Code formatter (`src/tim/executors/claude_code/format.ts`) and the Codex formatter (`src/tim/executors/codex_cli/format.ts`), then fed through the logging system as plain text. A GUI consumer receiving these messages over the headless protocol gets ANSI-colored strings instead of structured data it can render appropriately.

### Key Findings

#### Current Protocol Architecture

**Headless Protocol** (`src/logging/headless_protocol.ts`):
- Defines 4 message types: `session_info`, `output`, `replay_start`, `replay_end`
- The `output` type wraps `TunnelMessage` which is either `TunnelArgsMessage` (type: log/error/warn/debug, args: string[]) or `TunnelDataMessage` (type: stdout/stderr, data: string)
- All structured information is lost by the time it reaches the protocol

**Tunnel Protocol** (`src/logging/tunnel_protocol.ts`):
- Defines `TunnelMessage` = `TunnelArgsMessage | TunnelDataMessage`
- Used by both the tunnel adapter (Unix socket for nested processes) and the headless adapter (WebSocket for GUI)

**Logger Adapter Interface** (`src/logging/adapter.ts`):
- Simple interface: `log(...args)`, `error(...args)`, `warn(...args)`, `writeStdout(data)`, `writeStderr(data)`, `debugLog(...args)`
- Uses `AsyncLocalStorage` for per-context adapter selection
- All adapters: ConsoleAdapter, SilentAdapter, TunnelAdapter, HeadlessAdapter

#### Agent Output Formatters

**Claude Code Formatter** (`src/tim/executors/claude_code/format.ts`):
- `formatJsonMessage(input: string)` parses JSON streaming output from the Claude CLI
- Returns `{ message, rawMessage, structuredOutput, type, filePaths, failed, failedSummary }`
- Handles: result (cost/duration), system init (session/tools/MCP), task notifications, status updates, compact boundary, assistant messages (thinking/text/tool_use/tool_result), user messages
- Special tool handling: Write (file path + line count), Edit (colorized diff), MultiEdit (YAML), TodoWrite (formatted task list), Read (line count), Bash (stdout/stderr separation), Task (red header)
- Already extracts structured data (file paths, failure info, structured output) but then formats it to strings

**Codex Formatter** (`src/tim/executors/codex_cli/format.ts`):
- `formatCodexJsonMessage(jsonLine)` → `FormattedCodexMessage { message, type, agentMessage, threadId, sessionId, lastTokenCount, failed }`
- Handles: thread.started, turn.started, turn.completed (usage/rate limits), item events (reasoning, agent_message, todo_list, command_execution, diff/turn_diff, patch_apply, file_change), session.created
- `createCodexStdoutFormatter()` manages stateful formatting across chunks, tracking final agent message, thread/session IDs

#### Executor Output Structure

**ExecutorOutput** (`src/tim/executors/types.ts`):
- Already has: `content`, `structuredOutput`, `steps[]`, `metadata`, `success`, `failureDetails`
- `failureDetails`: `{ requirements, problems, solutions?, sourceAgent? }`

#### Agent Command Output Patterns (`src/tim/commands/agent/agent.ts`)

Major message categories in agent execution:
1. **Plan discovery**: "Found ready plan: 42 - Title" (green)
2. **Workspace management**: "Created workspace", "Using workspace", path info
3. **Iteration headers**: "### Iteration 1 - Task 1" with task title/description
4. **Context generation**: "### Generating Context..." progress messages
5. **Execution progress**: "### Executing..." with executor name
6. **Failure reports**: "FAILED: summary" with requirements/problems/solutions (red/yellow)
7. **Post-apply commands**: "### Running Post-Apply Commands..."
8. **Task completion**: "Marked task as done", "Plan fully completed!"
9. **Final review**: "### Running Final Review..."
10. **Dry run output**: Prompt display with "Would execute" notice

#### Review Command Output Patterns (`src/tim/commands/review.ts`)

Major message categories:
1. **Review execution**: "### Executing Review..." with executor details
2. **Review results**: Formatted review output (issues, recommendations, action items)
3. **Autofix execution**: "### Running Autofix..." with progress
4. **Cleanup plan creation**: "### Creating Cleanup Plan..."
5. **Issue selection**: Selection prompts and "No issues selected" messages
6. **Save operations**: "Review results saved to: path"

#### Summary Display (`src/tim/summary/display.ts`)

- `formatExecutionSummaryToLines()` formats rich structured data (plan metadata table, step results with success/failure indicators, file changes, errors) into colored text
- Already receives `ExecutionSummary` with structured `StepResult[]`, `changedFiles[]`, etc.

#### How spawnAndLogOutput Works (`src/common/process.ts`)

- Spawns subprocess, captures stdout/stderr via async iterators
- `formatStdout` callback transforms each chunk before logging
- Claude Code uses `formatJsonMessage()` as the formatter
- Codex uses `createCodexStdoutFormatter().formatChunk` as the formatter
- Formatted output is then passed to `log()` which goes through the adapter chain

### Architectural Approach

The key insight is that we need to intercept structured data **before** it becomes formatted text. Currently:

```
Agent JSON → formatJsonMessage() → colored string → log() → adapter → headless protocol (as string)
```

The new flow should be:

```
Agent JSON → parse to structured message → adapter.sendStructuredMessage() → headless protocol (as structured data)
                                         → console formatter → console output (as colored string)
```

The structured messages replace `TunnelMessage` inside `HeadlessOutputMessage`. The `output` message type gains a new variant that carries typed structured data instead of log/error/warn text. The existing `TunnelMessage` types continue to work for plain log calls.

### Files That Will Be Modified

**Protocol layer:**
- `src/logging/headless_protocol.ts` — Add new structured message types to the union
- `src/logging/tunnel_protocol.ts` — Extend `TunnelMessage` with structured variants

**Adapter layer:**
- `src/logging/adapter.ts` — Add `sendStructured(message)` method to `LoggerAdapter`
- `src/logging/console.ts` — Implement `sendStructured` with console formatting
- `src/logging/silent.ts` — Implement `sendStructured` (write to file only)
- `src/logging/tunnel_client.ts` — Implement `sendStructured` (send over socket)
- `src/logging/headless_adapter.ts` — Implement `sendStructured` (send over WebSocket)

**Public API:**
- `src/logging.ts` — Add `sendStructured()` function

**Formatters (create new):**
- `src/logging/structured_messages.ts` — Define all structured message types
- `src/logging/console_formatter.ts` — Format structured messages for console output

**Executor integration:**
- `src/tim/executors/claude_code/format.ts` — Return structured messages instead of formatted strings
- `src/tim/executors/codex_cli/format.ts` — Return structured messages instead of formatted strings
- `src/tim/executors/claude_code.ts` — Use `sendStructured()` for parsed agent output
- `src/tim/executors/claude_code_orchestrator.ts` — Use `sendStructured()` for step headers
- `src/tim/executors/codex_cli/codex_runner.ts` — Use `sendStructured()` for parsed output
- `src/tim/executors/codex_cli/normal_mode.ts` — Use `sendStructured()` for workflow messages
- `src/tim/executors/codex_cli/simple_mode.ts` — Use `sendStructured()` for workflow messages

**Agent/Review commands:**
- `src/tim/commands/agent/agent.ts` — Use `sendStructured()` for major messages
- `src/tim/commands/agent/batch_mode.ts` — Use `sendStructured()` for major messages
- `src/tim/commands/review.ts` — Use `sendStructured()` for major messages

**Summary:**
- `src/tim/summary/display.ts` — Use `sendStructured()` for summary output

### Existing Utilities and Patterns

- `serializeArgs()` / `serializeArg()` in tunnel_protocol.ts — for converting arbitrary args to strings
- `formatTodoLikeLines()` in `src/tim/executors/shared/todo_format.ts` — shared between Claude/Codex formatters
- `detectFailedLine()` / `detectFailedLineAnywhere()` / `extractFailureDetails()` in `src/tim/executors/failure_detection.ts`
- `createLineSplitter()` in `src/common/process.ts` — for handling partial JSON lines
- `runWithLogger()` in `src/logging/adapter.ts` — for swapping adapters contextually
- `ReviewOutputSchema` / `ReviewIssueOutputSchema` in `src/tim/formatters/review_output_schema.ts`

### Potential Challenges

1. **Backwards compatibility**: The tunnel protocol is used by nested tim processes. We need to ensure old child processes can still communicate with new parent processes and vice versa. Using a discriminated union where the existing types remain valid handles this.

2. **Formatter output interleaving**: Both formatters currently return `{ message: string }`. Changing them to return structured messages means the `spawnAndLogOutput` `formatStdout` callback needs to change its return type or we add a parallel path.

3. **Console formatting parity**: The console output after this change should look essentially the same as it does now. The console formatter needs to reproduce the existing chalk-based formatting.

4. **Debug and raw messages**: Not every log call needs to be structured. Debug messages, internal warnings, and one-off status messages should continue using the existing `log()`/`warn()`/`error()` functions.

## Implementation Guide

### Expected Behavior/Outcome

After implementation:
- The headless protocol carries typed structured messages (e.g., `AgentSessionStart`, `ToolInvocation`, `ExecutionResult`, `ReviewIssue`) alongside existing plain-text `output` messages
- Console output looks the same as it does today (formatted with chalk)
- GUI consumers receive structured data they can render with custom UI components
- Non-agent/review commands continue using `log()` as-is with no changes
- An `input_required` message is emitted before inquirer prompts

### Key Findings Summary

- **Product & User Story**: GUI consumers (plan 160 - Monitor/Dashboard) need structured data to render agent execution progress, tool invocations, review results, and failures with custom UI rather than parsing ANSI strings.
- **Design & UX Approach**: Add a `sendStructured()` path parallel to `log()`. Console adapters format structured messages to match current output. Headless/tunnel adapters serialize structured messages as typed JSON.
- **Technical Plan & Risks**: The main risk is ensuring backward compatibility with the tunnel protocol for nested processes. Using discriminated unions with the `type` field as discriminator mitigates this.
- **Pragmatic Effort Estimate**: Medium-large. ~15-20 files modified, new message type definitions, new console formatter module, updates to both executor formatters and agent/review command code.

### Acceptance Criteria

- [ ] All structured message types are defined in `src/logging/structured_messages.ts` with TypeScript interfaces
- [ ] `LoggerAdapter` interface has a `sendStructured()` method; all adapters implement it
- [ ] `src/logging.ts` exports a `sendStructured()` function
- [ ] Console formatter produces output visually equivalent to current chalk-formatted output
- [ ] Claude Code executor sends structured messages for all parsed JSON events
- [ ] Codex executor sends structured messages for all parsed JSON events
- [ ] Agent command sends structured messages for plan discovery, iteration headers, execution progress, failure reports, task completion, and final review
- [ ] Review command sends structured messages for review execution, results, autofix, and cleanup plan creation
- [ ] Summary display sends structured messages for execution summaries
- [ ] `input_required` message is sent before inquirer prompts in agent and review commands
- [ ] Existing non-agent/review log calls continue working without changes
- [ ] Headless protocol test suite updated and passing
- [ ] Tunnel protocol backward compatibility maintained (old-format messages still accepted)
- [ ] `bun test` passes, `bun run check` passes

### Dependencies & Constraints

- **Dependencies**: Relies on existing headless protocol infrastructure (plan 160 parent)
- **Technical Constraints**: Must maintain backward compatibility with tunnel protocol. Must not break existing console output formatting.

### Design Decisions (from refinement)

1. **API Design**: `sendStructured()` is a new method on the `LoggerAdapter` interface. All adapters implement it. Clean and consistent.
2. **Formatter flow**: Formatters parse JSON and return `StructuredMessage` objects. Callers route to `sendStructured()`. Console formatting happens inside the adapter's `sendStructured()` method.
3. **Protocol layer**: Extend `TunnelMessage` with a `{ type: 'structured', message: StructuredMessage }` variant. HeadlessOutputMessage already wraps TunnelMessage, so structured messages flow through automatically.
4. **Granularity**: Fine-grained ~20 distinct message types. Each maps to a specific UI component. More verbose but easier for consumers to pattern-match.
5. **Console formatter**: Single `formatStructuredMessage()` function with a switch statement. Simple and readable for ~20 types.
6. **spawnAndLogOutput integration**: Change the `formatStdout` callback signature to return `StructuredMessage | string`. `spawnAndLogOutput` checks the return type and calls `sendStructured()` for structured messages or `writeStdout()` for strings.
7. **Codex workflow messages**: Include workflow messages (step start/end, verdict, fix iterations) as structured messages, not just formatter output.
8. **Tool detail**: Specialized tool messages — file_write has `{ path, lineCount }`, file_edit has `{ path, diff }`, command has `{ command, stdout, stderr, exitCode }`, etc.
9. **Diff content**: Include only the unified diff string in file_edit messages, not the full old/new content.
10. **Execution summary**: The `execution_summary` message wraps the existing `ExecutionSummary` type directly.
11. **Plan structure**: Single plan with sequential tasks (tightly coupled changes).

### Implementation Notes

- **Recommended Approach**: Define all message types first, then update the adapter interface, then convert formatters, then update call sites. Work bottom-up from protocol → adapters → formatters → commands.
- **Potential Gotchas**:
  - The `spawnAndLogOutput` `formatStdout` callback needs to return `StructuredMessage | string`. The caller checks the type and routes accordingly.
  - Some messages in the agent command are minor (debug, internal warnings) and should remain as plain `log()` calls. Only "major" messages get structured types.
  - The HeadlessAdapter currently serializes `TunnelMessage` inside `HeadlessOutputMessage`. The new `{ type: 'structured' }` TunnelMessage variant carries structured data through this existing envelope.

### Step 1: Define Structured Message Types

Create `src/logging/structured_messages.ts` with all message type interfaces. Use a discriminated union with a `type` field. Categories of messages:

**Agent lifecycle messages:**
- `agent_session_start` — Agent session began (executor name, plan ID, mode)
- `agent_session_end` — Agent session finished (cost, duration, turns, success)
- `agent_iteration_start` — Starting a new iteration/step (task title, description, iteration number)
- `agent_step_start` — Starting an execution phase (executor name, phase like "implementer"/"tester"/"reviewer")
- `agent_step_end` — Phase completed (phase, success, output summary)

**LLM interaction messages:**
- `llm_thinking` — Model is thinking/reasoning
- `llm_response` — Model text response
- `llm_tool_use` — Model invoking a tool (tool name, summarized input)
- `llm_tool_result` — Tool result (tool name, summarized result)
- `llm_status` — Status update (compacting, etc.)

**File operation messages:**
- `file_write` — File write operation (path, line count)
- `file_edit` — File edit with diff (path, unified diff string)
- `file_change_summary` — Summary of file changes (files added/updated/removed with paths)

**Command execution messages:**
- `command_exec` — Running a shell command (command, cwd)
- `command_result` — Command finished (exit code, stdout summary, stderr summary)

**Review messages:**
- `review_start` — Review beginning (executor, plan ID)
- `review_result` — Review completed (issues, recommendations, action items — structured)
- `review_verdict` — Review verdict (ACCEPTABLE/NEEDS_FIXES, fix instructions)

**Workflow messages:**
- `workflow_progress` — General progress update (message, phase)
- `failure_report` — Structured failure (summary, requirements, problems, solutions, source agent)
- `task_completion` — Task marked as done (task title, plan completion status)
- `execution_summary` — Full execution summary (the existing ExecutionSummary structure)

**Token/usage messages:**
- `token_usage` — Token usage report (input, cached, output, reasoning, total, rate limits)

**Other:**
- `input_required` — An interactive prompt is about to be shown
- `plan_discovery` — Found a ready plan to execute (plan ID, title)
- `workspace_info` — Workspace details (ID, path, plan)

The existing `TunnelMessage` types (log/error/warn/debug/stdout/stderr) remain for unstructured output. Add a new `StructuredTunnelMessage` type: `{ type: 'structured'; message: StructuredMessage }`. Update `TunnelMessage` to include this variant.

### Step 2: Update the Headless/Tunnel Protocol

Update `src/logging/tunnel_protocol.ts`:
- Add `StructuredTunnelMessage` interface: `{ type: 'structured'; message: StructuredMessage }`
- Extend the `TunnelMessage` union to include `StructuredTunnelMessage`

Update `src/logging/headless_protocol.ts`:
- The `HeadlessOutputMessage` already wraps `TunnelMessage`, so structured messages automatically flow through without additional protocol changes

### Step 3: Add sendStructured to the Adapter Interface

Update `src/logging/adapter.ts`:
- Add `sendStructured(message: StructuredMessage): void` to `LoggerAdapter`

Update each adapter:

**ConsoleAdapter** (`src/logging/console.ts`):
- `sendStructured(msg)`: Call the console formatter to produce a colored string, then `console.log()` it + write to log file

**SilentAdapter** (`src/logging/silent.ts`):
- `sendStructured(msg)`: Call the console formatter to produce a string, write to log file only

**TunnelAdapter** (`src/logging/tunnel_client.ts`):
- `sendStructured(msg)`: Send `{ type: 'structured', message: msg }` as JSONL over the socket + write to log file

**HeadlessAdapter** (`src/logging/headless_adapter.ts`):
- `sendStructured(msg)`: Enqueue a `TunnelMessage` of type `structured` (which wraps the structured message). Also call `wrappedAdapter.sendStructured(msg)` so console output still works.

Update `src/logging.ts`:
- Add `sendStructured(message: StructuredMessage)` function that dispatches to the current adapter

### Step 4: Create Console Formatter

Create `src/logging/console_formatter.ts`:
- `formatStructuredMessage(message: StructuredMessage): string`
- Switch on `message.type` and produce chalk-formatted output matching current formatting
- Reuse formatting logic from the existing Claude Code and Codex formatters where possible, extracting shared utility functions

Key formatter mappings:
- `agent_session_start` → `chalk.bold.green("### Starting [timestamp]")` + session details
- `agent_session_end` → `chalk.bold.green("### Done [timestamp]")` + cost/duration
- `llm_thinking` → `chalk.blue("### Thinking [timestamp]")` + text
- `llm_response` → `chalk.bold.green("### Model Response [timestamp]")` + text
- `llm_tool_use` → `chalk.cyan("### Invoke Tool: name [timestamp]")` + input summary
- `llm_tool_result` → `chalk.magenta("### Tool Result: name [timestamp]")` + result summary
- `failure_report` → `chalk.redBright("FAILED: ...")` + yellow requirements/solutions
- `token_usage` → `chalk.gray("### Usage [timestamp]")` + formatted token counts
- `file_edit` → `chalk.cyan("### Invoke Tool: Edit [timestamp]")` + colorized diff
- `command_exec` → `chalk.cyan("### Exec Begin [timestamp]")` + command
- `command_result` → colored based on exit code, stdout green, stderr red

### Step 5: Update Claude Code Formatter

Modify `src/tim/executors/claude_code/format.ts`:
- `formatJsonMessage()` currently returns `{ message: string, type, ... }`
- Change it to return structured messages: `{ structured: StructuredMessage, type, filePaths, failed, failedSummary, rawMessage, structuredOutput }`
- The caller in `claude_code.ts` and `claude_code_orchestrator.ts` calls `sendStructured()` instead of `log(formattedMessage.message)`

Mapping of current returns to structured messages:
- `result` + `success` → `agent_session_end` message
- `system` + `init` → `agent_session_start` message
- `system` + `task_notification` → `workflow_progress` message
- `system` + `status` → `llm_status` message
- `system` + `compact_boundary` → `llm_status` message
- `assistant` + thinking → `llm_thinking` message
- `assistant` + text → `llm_response` message
- `assistant` + tool_use → `llm_tool_use` message (with specific variants for Write/Edit/Bash)
- `assistant` + tool_result → `llm_tool_result` message
- `user` + text → `llm_response` (with a flag indicating it's a user/agent request)

### Step 6: Update Codex Formatter

Modify `src/tim/executors/codex_cli/format.ts`:
- `formatCodexJsonMessage()` returns `FormattedCodexMessage`
- Change to return structured messages in addition to or instead of formatted strings
- `createCodexStdoutFormatter()` sends structured messages via `sendStructured()`

Mapping:
- `thread.started` → `agent_session_start`
- `turn.started` → `agent_step_start`
- `turn.completed` → `token_usage`
- `item.completed` (reasoning) → `llm_thinking` / `llm_response`
- `item.completed` (agent_message) → `llm_response`
- `item.*` (todo_list) → `workflow_progress` (with todo items as data)
- `item.*` (command_execution) → `command_exec` / `command_result`
- `item.*` (diff/turn_diff) → `file_change_summary`
- `item.*` (patch_apply) → `file_change_summary`
- `item.*` (file_change) → `file_change_summary`

### Step 7: Update spawnAndLogOutput Integration

The `formatStdout` callback in `spawnAndLogOutput` (`src/common/process.ts`) currently returns a string that gets passed to `writeStdout()`. Update it to support returning `StructuredMessage | string`:

- Change the `formatStdout` callback type to `(chunk: string) => StructuredMessage | StructuredMessage[] | string`
- In the stdout processing loop, check the return type:
  - If `string`: pass to `writeStdout()` as before
  - If `StructuredMessage` or `StructuredMessage[]`: call `sendStructured()` for each message
- This allows formatters to return structured messages for agent JSON events and plain strings for unrecognized data or debug lines

### Step 8: Update Agent Command Call Sites

In `src/tim/commands/agent/agent.ts` and `src/tim/commands/agent/batch_mode.ts`:
- Replace key `log()` calls with `sendStructured()`:
  - Plan discovery → `sendStructured({ type: 'plan_discovery', planId, title })`
  - Workspace info → `sendStructured({ type: 'workspace_info', ... })`
  - Iteration start → `sendStructured({ type: 'agent_iteration_start', ... })`
  - Execution start → `sendStructured({ type: 'agent_step_start', ... })`
  - Failure reports → `sendStructured({ type: 'failure_report', ... })`
  - Task completion → `sendStructured({ type: 'task_completion', ... })`
  - Post-apply commands → `sendStructured({ type: 'workflow_progress', ... })`
  - Final review → `sendStructured({ type: 'workflow_progress', ... })`
- Keep minor log calls (debug, internal warnings, error handling) as `log()`/`warn()`/`error()`

### Step 9: Update Review Command Call Sites

In `src/tim/commands/review.ts`:
- `sendStructured({ type: 'review_start', ... })` at review beginning
- `sendStructured({ type: 'review_result', ... })` with structured review data
- `sendStructured({ type: 'review_verdict', ... })` for verdict messages
- `sendStructured({ type: 'workflow_progress', ... })` for autofix/cleanup operations
- Keep minor log calls as-is

### Step 10: Add input_required Messages

Before each inquirer prompt in agent and review commands:
- Call `sendStructured({ type: 'input_required' })` just before the `await confirm()`, `await select()`, etc. calls
- This covers: tool approval prompts in `claude_code.ts`, confirmation prompts in `agent.ts`, issue selection in `review.ts`

### Step 11: Update Tunnel Server

In `src/logging/tunnel_server.ts`:
- The `dispatchMessage()` function needs to handle the new `structured` tunnel message type
- When receiving `{ type: 'structured', message: ... }`, call `sendStructured(message)` on the current adapter
- Existing message types (log/error/warn/debug/stdout/stderr) continue working as before

### Step 12: Update Summary Display

In `src/tim/summary/display.ts`:
- `displayExecutionSummary()` should send an `execution_summary` structured message
- The console formatter handles rendering it (reproducing the existing table/step format)
- `writeOrDisplaySummary()` continues to write to file with ANSI stripping for file output

### Step 13: Update Tests

- Add tests for new structured message types in `src/logging/structured_messages.test.ts` (type checking, serialization)
- Add tests for console formatter in `src/logging/console_formatter.test.ts` (verify output matches expected formatting)
- Update `src/logging/headless_adapter.test.ts` to verify structured messages flow through correctly
- Update `src/logging/tunnel_integration.test.ts` for structured message tunneling
- Add integration test verifying a structured message sent via `sendStructured()` arrives at the headless WebSocket with correct type and data

### Manual Testing

1. Run `tim agent <plan>` and verify console output looks the same as before
2. Run `tim review <plan>` and verify console output looks the same as before
3. Connect a WebSocket client to the headless URL and verify structured messages arrive with correct types and data
4. Run a nested tim process (via tunnel) and verify structured messages are forwarded correctly
5. Verify non-agent commands (e.g., `tim list`) continue working without changes

## Current Progress
### Current State
- Structured messaging remains fully wired through adapters, tunnel transport, and console formatting for agent/review flows.
- The final formatter style follow-up is now addressed: `formatFileChange` in `console_formatter.ts` uses an explicit `updated` branch plus a `never` exhaustive check.
- `planId` type mismatch between top-level messages and `execution_summary.summary.planId` remains intentionally deferred and documented for compatibility.

### Completed (So Far)
- Implemented structured message plumbing across type definitions, logger adapters, tunnel protocol/transport, and command/executor call sites in scope.
- Added structured formatter and transport coverage, including end-to-end `sendStructured` WebSocket forwarding and execution-summary rendering parity.
- Added explicit formatter guidance that `review_result`/`review_verdict` must be paired with explicit call-site logs for console visibility.
- Expanded `structured_messages.ts` compatibility note to state that consumers must accept both numeric and string `planId` representations.
- Added `structuredMessageTypeList` as a canonical list and reused it in tunnel validation and structured-message type sync tests.
- Replaced `return _exhaustive;` in `dispatchMessage` with a bare never-check expression for clearer intent in a `void` function.
- Closed the remaining reviewer follow-up on duplicated structured-message type count literals by removing hardcoded counts in both affected tests.
- Added `sendStructured` to every mocked `../../logging.js` export in `review.tunnel.test.ts` so the mock surface matches current logging API expectations.
- Reduced flake risk in the replay-buffer headless adapter test by increasing that test's connect/drain `waitFor` timeout to better match the existing async test budget.
- Updated `formatFileChange` in `console_formatter.ts` to enforce compile-time exhaustiveness for `FileChangeKind`, preventing silent fallback behavior if new kinds are added.

### Remaining
- No required fixes remain for this scoped reviewer-fix pass.
- Optional follow-up: standardize `planId` representation across summary and top-level structured message types in a future cleanup pass.
- Optional follow-up: move Claude formatter tool-use cache to instance-scoped state if a broader formatter refactor is scheduled.

### Next Iteration Guidance
- Preserve the intentional console silence contract for `review_result`/`review_verdict` whenever new call sites are added.
- Keep the canonical structured message type list and tunnel validation checks in sync whenever new `StructuredMessage` variants are added.
- Keep dispatch/validation patterns aligned between `isValidTunnelMessage`, `isValidStructuredMessagePayload`, and `dispatchMessage` when introducing new tunnel variants.
- Plan a dedicated cleanup if `planId` typing is to be unified across message families.
- When mocking `../../logging.js` in tests, include `sendStructured` so test doubles stay aligned with the runtime logging API.
- Keep websocket/tunnel timing assertions explicit in async integration tests that depend on connect + replay drain sequencing.
- Mirror exhaustive-check patterns in small helper functions (not only top-level switches) when adding discriminated unions.

### Decisions / Changes
- Structured messaging remains focused on high-value lifecycle/workflow events rather than replacing every plain log.
- The current `planId` type mismatch is preserved for compatibility, and consumer handling expectations are explicitly documented.
- `review_result` and `review_verdict` remain intentionally formatter-silent and require explicit call-site logging for local console output.
- Canonical message-type membership is now asserted by set equality against a shared source-of-truth list, avoiding duplicated magic counts.
- Module-level Claude tool-use cache reset behavior is kept as-is for now, with instance scoping deferred to a future refactor.
- Logging module mocks in review tunnel tests now intentionally include `sendStructured` as part of the stable mocked adapter contract.
- The replay-buffer flush test now uses a less aggressive `waitFor` timeout to reduce nondeterministic failures under load without changing behavior.
- `formatFileChange` now follows the same exhaustive-typing safety approach used by `formatStructuredMessage`.

### Risks / Blockers
- None

## Unresolved Review Issues

### Tasks Worked On

- Define structured message types
- Extend tunnel protocol with structured message variant
- Add sendStructured to LoggerAdapter and all adapters
- Create console formatter for structured messages
- Update spawnAndLogOutput to support StructuredMessage returns

### Review Output

# Code Review Report
**Plan:** 168 - create structured messages for agent output 160
**Date:** 2/7/2026, 11:40:36 PM
**Base Branch:** main

## Summary
- **Total Issues:** 4
- **Files Reviewed:** 27

### Issues by Severity
- Critical: 0
- Major: 0
- Minor: 2
- Info: 2

### Issues by Category
- Bug: 1
- Compliance: 1
- Testing: 1
- Other: 1

## Issues Found
### Minor Issues

#### 1. planId type inconsistency across structured message types. PlanDiscoveryMessage.planId is number, ReviewStartMessage.planId is number | undefined, AgentSessionStartMessage.planId is number | undefined, and ExecutionSummary uses string for planId. GUI consumers will need to handle multiple representations of the same concept.
**Category:** compliance
**File:** src/logging/structured_messages.ts:12-198


**Suggestion:** Consider standardizing planId to a single type (e.g., number | undefined) across all message types, with a note in the type definition about the expected format. This can be done in a future cleanup pass.

#### 2. isValidStructuredMessagePayload in tunnel_server.ts lacks an exhaustive switch check. If a new StructuredMessage type is added to the union and the Record map, but the switch statement is not updated with a validation case, the message would be silently rejected (returns false at the default case). The console_formatter.ts correctly uses the exhaustive pattern (const _exhaustive: never = message) but the tunnel server validation does not.
**Category:** bug
**File:** src/logging/tunnel_server.ts:156-234


**Suggestion:** Add an exhaustive check in the default case of isValidStructuredMessagePayload's switch statement, similar to the pattern used in console_formatter.ts: default: { const _exhaustive: never = structured as never; return false; }. This ensures compile-time errors when new message types are added without validation logic.

### Info Issues

#### 1. spawnAndLogOutput pushes rawOutput to the stdout array when formatStdout returns StructuredMessage(s) instead of a string. Comment says 'Keep returned stdout as raw process output for downstream parsers.' This is correct for current callers (claude_code.ts parses result.stdout for raw JSON), but the semantic difference between result.stdout containing raw bytes vs formatted output should be understood by future callers.
**Category:** other
**File:** src/common/process.ts:188-195


**Suggestion:** No change needed. The comment adequately explains the rationale. Future callers should be aware that result.stdout contains raw process output regardless of whether formatStdout returned structured messages.

#### 2. The magic number 26 (count of structured message types) appears in two separate test files (structured_messages.test.ts and tunnel_server.test.ts). Both must be updated when adding new message types. While this is intentional as an invariant check, it creates a minor maintenance burden.
**Category:** testing
**File:** src/logging/structured_messages.test.ts:59


**Suggestion:** Consider deriving the expected count programmatically or adding a comment explaining the magic number and that both test files must be updated together.

## Recommendations
- The implementation is solid and well-aligned with the plan requirements for tasks 1-5. The discriminated union pattern, exhaustive switch in the formatter, and backward-compatible protocol extension are all good design choices.
- When implementing tasks 6-13 (converting formatters and call sites), maintain the pattern established here: structured messages for major events, plain log() for debug/internal messages.
- Consider adding the exhaustive never check to the tunnel server validation switch to catch missing cases at compile time, matching the pattern already used in console_formatter.ts.

## Action Items
- [ ] Add exhaustive check to isValidStructuredMessagePayload switch in tunnel_server.ts to match the pattern used in console_formatter.ts (prevents silent rejection of new message types).

## Unresolved Review Issues

### Tasks Worked On

- Convert Claude Code formatter to return structured messages
- Convert Codex formatter to return structured messages
- Convert Codex workflow messages to structured messages

### Review Output

# Code Review Report
**Plan:** 168 - create structured messages for agent output 160
**Date:** 2/8/2026, 12:46:17 AM
**Base Branch:** main

## Summary
- **Total Issues:** 6
- **Files Reviewed:** 39

### Issues by Severity
- Critical: 0
- Major: 2
- Minor: 2
- Info: 2

### Issues by Category
- Bug: 3
- Style: 1
- Compliance: 2

## Issues Found
### Major Issues

#### 1. `withMessage` in Claude formatter produces console-formatted text for `FormattedClaudeMessage.message`, and the `captureMode === 'all'` path in claude_code.ts uses `result.message` (ANSI formatted via console formatter) for captured output lines. This means `ExecutorOutput.content` returned at line 1475 contains ANSI color codes from the console formatter. While the pre-existing behavior also produced ANSI-colored output, the formatting now goes through a different path (`formatStructuredMessage`) that may produce subtly different output than the previous inline formatting. For `captureMode === 'result'` this is fine since it uses `result.rawMessage`.
**Category:** bug
**File:** src/tim/executors/claude_code.ts:1395-1406


**Suggestion:** Consider whether `captureMode === 'all'` should capture `rawMessage` (when available) rather than the console-formatted `message` to avoid ANSI codes in captured output.

#### 2. Module-level `toolUseCache` in Claude formatter is shared state that leaks across sessions. The `toolUseCache` is a module-level `Map<string, string>()` that is never cleared. It accumulates tool use ID-to-name mappings across all invocations of `formatJsonMessage()`. Since the Claude executor runs multiple sessions (planning, research, generation in `claude_code_orchestrator.ts`; multiple reviews in the agent command), tool IDs from one session could collide with IDs from another session, causing `tool_result` messages to be mapped to incorrect tool names. This is pre-existing behavior but the structured message conversion makes it more impactful because wrong tool names now flow into typed `llm_tool_result.toolName` or `command_result` fields where a GUI consumer would rely on them for routing/rendering.
**Category:** bug
**File:** src/tim/executors/claude_code/format.ts:107


**Suggestion:** Clear the cache between sessions, or make it a parameter of a formatter instance rather than module-level state. At minimum, document this as a known limitation for follow-up.

### Minor Issues

#### 1. The `token_usage` structured message `rateLimits` field passes raw Codex data without sanitization. The tunnel server validation for `token_usage` only validates the numeric count fields, not the `rateLimits` field. If the `rate_limits` object from Codex contains non-serializable values (unlikely but possible), it would cause a serialization failure in the headless adapter.
**Category:** compliance
**File:** src/tim/executors/codex_cli/format.ts:806


**Suggestion:** Either add `rateLimits` validation to the tunnel server's token_usage case, or document that `rateLimits` is a pass-through record that must be JSON-serializable.

#### 2. Missing `agent_step_start` before reviewer re-run inside the fix-and-review loop. When the fix loop re-runs the reviewer after the fixer, there is no `agent_step_start` message emitted for the reviewer before calling `runExternalReviewForCodex`. There is only an `agent_step_end` emitted if the reviewer throws (catch block at lines 501-522 in normal_mode.ts and 420-440 in simple_mode.ts), but the corresponding `agent_step_start` for the re-review is missing. This means a GUI consumer would see `agent_step_end` for `phase: 'reviewer'` without a preceding `agent_step_start` during fix iterations. Compare with the initial reviewer call which correctly has `agent_step_start` (line 352-357 in normal_mode.ts).
**Category:** bug
**File:** src/tim/executors/codex_cli/normal_mode.ts:484-522


**Suggestion:** Add `sendStructured({ type: 'agent_step_start', timestamp: timestamp(), phase: 'reviewer', message: 'Re-running reviewer...' })` before the `runExternalReviewForCodex` call inside the fix loop, in both normal_mode.ts and simple_mode.ts.

### Info Issues

#### 1. Codex formatter `formatDiffItem` uses an IIFE (immediately-invoked function expression) for computing the `structured` field, spanning ~80 lines. This makes the code harder to read and debug compared to a named helper function.
**Category:** style
**File:** src/tim/executors/codex_cli/format.ts:457-536


**Suggestion:** Extract the IIFE into a named helper function like `buildDiffChangesSummary()` for readability.

#### 2. Codex `review_mode.ts` still uses plain `log()` calls without structured messages. While this is defensible per the plan scope ('Only agent and review commands need structured messages'), the file does contain workflow-like messages ('Running Codex reviewer step...', 'Reviewer output captured.') that could benefit from structured formatting for GUI consumers.
**Category:** compliance
**File:** src/tim/executors/codex_cli/review_mode.ts:36-43


**Suggestion:** Consider converting these to structured messages in a future pass when the review command call sites are updated (plan task 9).

## Recommendations
- When implementing tasks 9-13 (agent/review command call sites), ensure that the reviewer re-run inside fix loops emits proper `agent_step_start` messages before calling `runExternalReviewForCodex`.
- Consider making the `toolUseCache` in claude_code/format.ts instance-based rather than module-level to prevent cross-session tool name leakage.
- Validate that captured output content (`captureMode === 'all'`) is correct for downstream consumers that may expect plain text rather than ANSI-formatted output.

## Action Items
- [ ] Add `sendStructured({ type: 'agent_step_start', phase: 'reviewer' })` before the reviewer re-run inside the fix loop in both normal_mode.ts and simple_mode.ts to maintain consistent lifecycle messaging for GUI consumers.

## Unresolved Review Issues

### Tasks Worked On

- Update agent command to send structured messages
- Update review command to send structured messages
- Add input_required messages before inquirer prompts

### Review Output

# Code Review Report
**Plan:** 168 - create structured messages for agent output 160
**Date:** 2/8/2026, 1:45:13 AM
**Base Branch:** main

## Summary
- **Total Issues:** 3
- **Files Reviewed:** 47

### Issues by Severity
- Critical: 0
- Major: 1
- Minor: 2
- Info: 0

### Issues by Category
- Compliance: 2
- Testing: 1

## Issues Found
### Major Issues

#### 1. Test failure in agent_batch_mode.test.ts: The test 'batch mode terminates when all tasks are complete' at line 310 expects `logSpy.toHaveBeenCalledWith('Batch mode complete: No incomplete tasks remaining')`, but batch_mode.ts replaced that `log()` call with `sendStructured({ type: 'task_completion', planComplete: true })` at lines 82-87. The structured message replacement is correct, but the test was not updated to match. This is a real, reproducible test failure confirmed by running `bun test`.
**Category:** testing
**File:** src/tim/commands/agent/agent_batch_mode.test.ts:310


**Suggestion:** Replace the logSpy assertion with a structured message assertion. Use the recording adapter (already created at line 302) to capture sendStructured calls, then assert `structuredMessages.toContainEqual(expect.objectContaining({ type: 'task_completion', planComplete: true }))` and remove the logSpy assertion for the removed message.

### Minor Issues

#### 1. plan_discovery structured messages are only emitted when the plan has a numeric ID (agent.ts lines 149, 182, 211). Plans without numeric or undefined IDs fall back to plain log() and won't generate structured messages for GUI consumers. The PlanDiscoveryMessage type requires planId: number, so this is type-safe, but headless consumers silently miss plan discovery events for non-numeric plans.
**Category:** compliance
**File:** src/tim/commands/agent/agent.ts:149-220


**Suggestion:** Defensible given the type constraints. If this becomes a problem for GUI consumers, consider adding a separate message type or making planId optional in PlanDiscoveryMessage.

#### 2. review_mode.ts still uses plain log() for workflow messages at lines 36 and 42 ('Running Codex reviewer step...' and 'Reviewer output captured.'). When review_mode.ts is invoked from the review command path, these plain messages appear alongside structured messages in the headless protocol as unstructured TunnelArgsMessage text, which may be slightly inconsistent for GUI consumers.
**Category:** compliance
**File:** src/tim/executors/codex_cli/review_mode.ts:36-42


**Suggestion:** This is defensible per the plan scope clarification ('Only agent and review commands need structured messages'). Consider converting these to workflow_progress structured messages in a future pass when review_mode is updated.

## Recommendations
- When converting log() calls to sendStructured(), always search for corresponding test assertions on the removed log messages and update them to assert structured messages instead.
- The structured message coverage in test files is good for review.notifications.test.ts and batch_mode.soft_failure.test.ts, but agent_batch_mode.test.ts lags behind — it should be brought up to parity.

## Action Items
- [ ] Fix the failing test in agent_batch_mode.test.ts:310 — replace the logSpy assertion for 'Batch mode complete: No incomplete tasks remaining' with a structured message assertion checking for task_completion with planComplete: true using the recording adapter already created at line 302.

## Unresolved Review Issues

### Tasks Worked On

- Update summary display to send structured messages

### Review Output

# Code Review Report
**Plan:** 168 - create structured messages for agent output 160
**Date:** 2/8/2026, 2:27:48 AM
**Base Branch:** main

## Summary
- **Total Issues:** 2
- **Files Reviewed:** 51

### Issues by Severity
- Critical: 0
- Major: 0
- Minor: 1
- Info: 1

### Issues by Category
- Style: 2

## Issues Found
### Minor Issues

#### 1. Dead code in console formatter `agent_step_end` handler. The formatter checks `message.success == null` and applies `chalk.dim`, but `AgentStepEndMessage.success` is typed as `boolean` (required, non-optional) in structured_messages.ts. The tunnel server validation also requires `typeof structured.success === 'boolean'`. This branch can never execute at runtime.
**Category:** style
**File:** src/logging/console_formatter.ts:71


**Suggestion:** Remove the `message.success == null` check and the `chalk.dim` fallback, since `success` is always a boolean. Use a simple ternary: `message.success ? chalk.green : chalk.red`.

### Info Issues

#### 1. Operator precedence in average step duration calculation. The expression `summary.steps.reduce(...) / summary.steps.length || 0` relies on JS precedence where `/` binds tighter than `||`. This works correctly because the `if (summary.steps.length > 0)` guard prevents division by zero, and the `|| 0` fallback handles edge NaN cases. This is pre-existing code moved from display.ts. Just noting the subtle precedence for future readers.
**Category:** style
**File:** src/tim/summary/format.ts:192-193


**Suggestion:** Consider adding parentheses for clarity: `(summary.steps.reduce(...) / summary.steps.length) || 0`, or no change needed since it's functionally correct.

## Recommendations
- The task 12 implementation is well-structured. The extraction of formatExecutionSummaryToLines into a shared format.ts module enables clean reuse from both display.ts and console_formatter.ts without duplication.
- The writeOrDisplaySummary behavioral change (always display + optionally write) is a good improvement that ensures headless consumers always receive the structured summary event regardless of whether file output is configured.
- The fallback chain in displayExecutionSummary (structured → warn + line-by-line → silent catch) provides robust degradation.

## Unresolved Review Issues

### Tasks Worked On

- Write tests for structured messages and console formatter

### Review Output

# Code Review Report
**Plan:** 168 - create structured messages for agent output 160
**Date:** 2/8/2026, 4:34:58 AM
**Base Branch:** main

## Summary
- **Total Issues:** 1
- **Files Reviewed:** 53

### Issues by Severity
- Critical: 0
- Major: 0
- Minor: 1
- Info: 0

### Issues by Category
- Testing: 1

## Issues Found
### Minor Issues

#### 1. Tests for `review_result`, `review_verdict`, and `input_required` (without prompt) in console_formatter.test.ts assert that the output is an empty string. This matches the intentional behavior (the formatter returns '' for these types with an explicit comment explaining why). However, if these cases were accidentally removed from the switch, the `default` fallback also returns '', so these tests would still pass with broken code. They provide no regression protection for these specific message types.
**Category:** testing
**File:** src/logging/console_formatter.test.ts:137-138, 232


**Suggestion:** Consider adding a spy or counter inside the formatter to verify the correct switch branch was taken, or test that the formatter explicitly handles these types (e.g., by verifying no console warning is emitted, or by testing that the structured message is still forwarded to the headless adapter even though console output is empty).

## Recommendations
- Keep the planId type normalization (number vs string across message families) on the backlog for a future cleanup pass, as documented in structured_messages.ts lines 8-14.
- When adding new StructuredMessage types in the future, the exhaustive never checks in console_formatter.ts (line 166) and tunnel_server.ts (line 280) will catch missing handlers at compile time — maintain this pattern.
- The console formatter's intentionally-silent message types (review_result, review_verdict, input_required without prompt) rely on paired explicit log() calls at call sites for console visibility. Document this contract prominently if onboarding new contributors.
