---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: claude code streaming json input
goal: ""
id: 178
uuid: 8970382a-14d8-40e2-9fda-206b952d2591
status: done
priority: medium
epic: true
dependencies:
  - 186
  - 187
references:
  "186": 06ad50ff-d486-47c2-ab95-d0e0366de585
  "187": 91e2545c-751f-4ab1-a4cc-6511191d7498
createdAt: 2026-02-13T06:35:03.721Z
updatedAt: 2026-02-13T18:58:01.199Z
tasks: []
changedFiles:
  - src/common/process.test.ts
  - src/common/process.ts
  - src/tim/commands/subagent.test.ts
  - src/tim/commands/subagent.ts
  - src/tim/executors/claude_code.test.ts
  - src/tim/executors/claude_code.ts
  - src/tim/executors/claude_code_model_test.ts
  - src/tim/executors/claude_code/permissions_mcp.ts
  - src/tim/executors/claude_code/permissions_mcp_setup.test.ts
  - src/tim/executors/claude_code/permissions_mcp_setup.ts
tags: []
---

Enable streaming JSON input for Claude Code via `--input-format stream-json` and add AskUserQuestion support to the permissions MCP.

Split into two child plans:
- **Plan 186**: Streaming JSON input via stdin (replace `--print` with `--input-format stream-json`)
- **Plan 187**: AskUserQuestion support in permissions MCP

The input JSON messages look like regular API messages

```
{
    type: "user" as const,
    message: {
      role: "user" as const,
      content: [
        {
          type: "text",
          text: "Review this architecture diagram"
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: await readFile("diagram.png", "base64")
          }
        }
      ]
    }
  };
```

We also want to integrate support for the AskUserQuestion tool into the Claude Code permissions MCP. This is described at https://platform.claude.com/docs/en/agent-sdk/user-input#handle-clarifying-questions

Although we are not using the SDK, the input and responses are the same. We get the input as described and then we want to get a
response from the user using the prompt mechanisms in src/common/input.ts. To start we can just run one prompt at a time, one for each question. Need to support both
select and checkbox. We should also support a "Free text" option in which the user chooses to type a custom response.

## Research

### Overview

This epic covers two related features for the Claude Code executor, split into child plans:
1. **Plan 186 - Streaming JSON input** - Switch from `--print` CLI argument to `--input-format stream-json` with newline-delimited JSON on stdin
2. **Plan 187 - AskUserQuestion support** - Handle Claude's AskUserQuestion tool calls via the existing permissions MCP `approval_prompt` tool

**Decision: No SDK switch.** The `@anthropic-ai/claude-agent-sdk` was evaluated but its input methods are currently unwieldy. We keep the direct CLI approach and add streaming input via the `--input-format stream-json` flag.

### Current Architecture

#### How Claude Code is Currently Invoked

The `ClaudeCodeExecutor` (in `src/tim/executors/claude_code.ts`) spawns the `claude` CLI as a child process:

```
claude --verbose --output-format stream-json --print <contextContent>
```

Key points:
- The entire prompt is passed as a CLI argument via `--print` (line 1145)
- Output is received as newline-delimited JSON on stdout (`stream-json` format)
- `spawnAndLogOutput()` in `src/common/process.ts` manages the process lifecycle
- stdin is set to `'ignore'` (line 170 of process.ts) when no stdin option is passed
- The `subagent.ts` command also uses the same `--print` pattern (line 445)

#### Permissions MCP Architecture

The permissions system uses a standalone MCP server (`src/tim/executors/claude_code/permissions_mcp.ts`) that communicates with the parent process via Unix socket:

1. `setupPermissionsMcp()` in `permissions_mcp_setup.ts` creates:
   - A Unix socket server for IPC
   - An MCP config file pointing to the permissions MCP script
   - Passed to Claude via `--mcp-config` and `--permission-prompt-tool mcp__permissions__approval_prompt`

2. The MCP server exposes a single `approval_prompt` tool that:
   - Receives `tool_name` and `input` from Claude
   - Sends a `permission_request` JSON message over the Unix socket
   - Waits for a `permission_response` with `approved: boolean`
   - Returns `{behavior: "allow", updatedInput}` or `{behavior: "deny", message}`

3. The parent process (`handlePermissionLine()` in `permissions_mcp_setup.ts`):
   - Checks against allowed tools map for auto-approval
   - If not auto-approved, prompts user via `promptSelect()` with Allow/Allow for Session/Disallow
   - Sends the response back over the socket

**Key insight for AskUserQuestion**: Claude Code routes AskUserQuestion calls through the same `approval_prompt` MCP tool, with `tool_name: "AskUserQuestion"`. We don't need a new MCP tool — just handle this special `tool_name` differently in the existing handler.

#### Input Handling System

`src/common/input.ts` provides prompt functions that work across three contexts:
- **Terminal mode**: Direct `@inquirer/prompts` calls
- **Tunnel mode**: Forwards prompts to parent orchestrator via `TunnelAdapter`
- **Headless mode**: Races terminal prompt against websocket response via `HeadlessAdapter`

Available prompt types:
- `promptConfirm()` - Yes/no confirmation
- `promptSelect<Value>()` - Single-choice selection from a list (generic, type-safe)
- `promptInput()` - Free-form text input
- `promptCheckbox<Value>()` - Multi-select checkbox (generic, type-safe)

All support `timeoutMs` parameter, structured message logging, and the three context modes.

### Streaming JSON Input Format

The `claude` CLI accepts streaming input via `--input-format stream-json`. Instead of `--print`, messages are written to stdin as newline-delimited JSON:

```json
{"type":"user","message":{"role":"user","content":"Analyze this codebase"}}
```

Or with rich content blocks (text + images):
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Review this diagram"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}]}}
```

The process keeps running and reading from stdin until stdin is closed. This enables:
- Sending additional guidance messages during execution
- Future multi-turn conversations within a single process
- Image attachments in messages

### AskUserQuestion Tool Format

The AskUserQuestion tool input schema (from Claude Agent SDK docs at https://platform.claude.com/docs/en/agent-sdk/user-input):
```typescript
interface AskUserQuestionInput {
  questions: Array<{
    question: string;           // Full question text
    header: string;             // Short label (max 12 chars)
    options: Array<{
      label: string;            // Display text (1-5 words)
      description: string;      // Explanation
    }>;
    multiSelect: boolean;       // Allow multiple selections
  }>;
  answers?: Record<string, string>;  // Populated by permission system
}
```

Constraints: 1-4 questions per call, 2-4 options per question. A "Free text" / "Other" option should be presented to the user but is not in the predefined options.

Response format (returned via the permission_response `updatedInput`):
```json
{
  "questions": [...original questions...],
  "answers": {
    "How should I format the output?": "Summary",
    "Which sections to include?": "Introduction, Conclusion"
  }
}
```

For multi-select, multiple labels are joined with ", ". For free text, the user's custom text is used as the value.

### Key Files

| File | Purpose |
|------|---------|
| `src/tim/executors/claude_code.ts` | Main executor - uses `--print` + `spawnAndLogOutput()` |
| `src/tim/executors/claude_code/permissions_mcp.ts` | Standalone MCP server with `approval_prompt` tool |
| `src/tim/executors/claude_code/permissions_mcp_setup.ts` | Socket server + `handlePermissionLine()` handler |
| `src/tim/commands/subagent.ts` | Subagent execution - also uses `--print` |
| `src/common/process.ts` | `spawnAndLogOutput()` - process spawning with output formatting |
| `src/common/input.ts` | `promptSelect()`, `promptCheckbox()`, `promptInput()` |
| `src/tim/executors/claude_code/format.ts` | JSON message parsing (`formatJsonMessage()`) |
| `src/logging/structured_messages.ts` | Prompt message types |
