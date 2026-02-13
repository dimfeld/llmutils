---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: AskUserQuestion support in Claude Code permissions MCP
goal: ""
id: 187
uuid: 91e2545c-751f-4ab1-a4cc-6511191d7498
generatedBy: agent
status: done
priority: medium
parent: 178
references:
  "178": 8970382a-14d8-40e2-9fda-206b952d2591
planGeneratedAt: 2026-02-13T09:06:48.293Z
promptsGeneratedAt: 2026-02-13T09:06:48.293Z
createdAt: 2026-02-13T08:54:00.234Z
updatedAt: 2026-02-13T19:00:50.791Z
tasks:
  - title: Extend permissions_mcp.ts to handle updatedInput in responses
    done: true
    description: "In src/tim/executors/claude_code/permissions_mcp.ts: Change
      handleParentResponse() to resolve with {approved, updatedInput?} instead
      of just boolean. Update requestPermissionFromParent() return type
      accordingly. In the approval_prompt tool execute handler, use
      response.updatedInput when present (falling back to original input). This
      is backwards compatible for regular permission requests."
  - title: Implement AskUserQuestion handler in permissions_mcp_setup.ts
    done: true
    description: 'In src/tim/executors/claude_code/permissions_mcp_setup.ts: Create
      handleAskUserQuestion() function. Detect tool_name === "AskUserQuestion"
      early in handlePermissionLine() and route to this handler. For each
      question: build choices from options + "Free text" sentinel, use
      promptSelect() for single-select or promptCheckbox() for multi-select,
      follow up with promptInput() if Free text chosen. Build answers record
      mapping question text to label(s). Send permission_response with
      approved:true and updatedInput:{questions, answers}. Include timeout
      handling and bell alert.'
  - title: Write tests for AskUserQuestion handling
    done: true
    description: "Add tests in
      src/tim/executors/claude_code/permissions_mcp_setup.test.ts (or a new test
      file): Test single-select question handling, multi-select handling, free
      text input, multiple questions in one request, timeout handling, and
      socket protocol. Mock promptSelect/promptCheckbox/promptInput from
      src/common/input.ts. Verify the permission_response includes updatedInput
      with correct questions and answers structure."
changedFiles:
  - src/tim/commands/subagent.test.ts
  - src/tim/executors/claude_code/permissions_mcp.ts
  - src/tim/executors/claude_code/permissions_mcp_setup.test.ts
  - src/tim/executors/claude_code/permissions_mcp_setup.ts
tags: []
---

Add support for handling Claude's AskUserQuestion tool calls in the Claude Code permissions MCP. When Claude calls AskUserQuestion with a questions array, the MCP server forwards the questions to the parent process via Unix socket, which presents them interactively to the user using promptSelect (single-select) or promptCheckbox (multi-select), plus a Free text option. User answers are sent back to Claude. This uses the same MCP and socket infrastructure as the existing permission approval system.

## Research

See parent plan 178 for full codebase analysis. Key points specific to this plan:

### How AskUserQuestion Flows Through the Permissions MCP

Claude Code routes AskUserQuestion calls through the existing `approval_prompt` MCP tool with `tool_name: "AskUserQuestion"`. This means:

1. Claude wants to ask the user a question
2. Claude calls `mcp__permissions__approval_prompt` with `{tool_name: "AskUserQuestion", input: {questions: [...]}}`
3. The MCP server (`permissions_mcp.ts`) sends this as a `permission_request` to the parent via Unix socket
4. The parent (`permissions_mcp_setup.ts`) receives it and currently treats ALL requests the same (checks allowed tools, prompts Allow/Disallow)
5. We need the parent to detect `tool_name === "AskUserQuestion"` and handle it differently

### Response Protocol Extension

Currently the `permission_response` only has `{requestId, approved: boolean}`. For AskUserQuestion, we need to send back the user's answers. We'll extend the response with an optional `updatedInput` field:

```json
{
  "type": "permission_response",
  "requestId": "req_123",
  "approved": true,
  "updatedInput": {
    "questions": [...original questions...],
    "answers": {
      "How should I format the output?": "Summary"
    }
  }
}
```

The MCP server (`permissions_mcp.ts`) needs to handle this extended response — when `updatedInput` is present in the response, use it instead of the original `input` in the returned permission result.

### AskUserQuestion Input Format

From Claude Agent SDK docs (https://platform.claude.com/docs/en/agent-sdk/user-input):

```typescript
{
  questions: [
    {
      question: "How should I format the output?",
      header: "Format",       // Short label, max 12 chars
      options: [
        { label: "Summary", description: "Brief overview of key points" },
        { label: "Detailed", description: "Full explanation with examples" }
      ],
      multiSelect: false
    }
  ]
}
```

Constraints: 1-4 questions, 2-4 options per question. We add a "Free text" option in the UI that isn't in the predefined options.

### Prompt Mapping

| Question Type | Prompt Function | Extra Logic |
|--------------|----------------|-------------|
| `multiSelect: false` | `promptSelect()` | Options from question + "Free text" choice |
| `multiSelect: true` | `promptCheckbox()` | Options from question + "Free text" choice |
| "Free text" selected | `promptInput()` | Follow-up to get custom text |

### Files to Change

| File | Change |
|------|--------|
| `src/tim/executors/claude_code/permissions_mcp.ts` | Handle `updatedInput` in response from parent |
| `src/tim/executors/claude_code/permissions_mcp_setup.ts` | Detect AskUserQuestion in `handlePermissionLine()`, prompt user, send `updatedInput` |
| `src/tim/executors/claude_code/permissions_mcp_setup.test.ts` | Add tests for AskUserQuestion handling |

### Expected Behavior/Outcome

- When Claude calls AskUserQuestion, the user sees each question presented sequentially in the terminal
- Single-select questions show options via `promptSelect()` with arrow-key navigation, plus a "Free text" option
- Multi-select questions show options via `promptCheckbox()` with checkbox selection, plus a "Free text" option
- Selecting "Free text" triggers a follow-up `promptInput()` for custom text
- Answers are mapped back to the AskUserQuestion format: `{questions, answers}` where answers maps question text to selected label(s)
- Multi-select answers are comma-separated (e.g., "Introduction, Conclusion")
- Free text answers use the user's typed text as the value

### Acceptance Criteria

- [ ] AskUserQuestion calls from Claude are detected in `handlePermissionLine()` by checking `tool_name === "AskUserQuestion"`
- [ ] Single-select questions display as `promptSelect()` with question options + "Free text"
- [ ] Multi-select questions display as `promptCheckbox()` with question options + "Free text"
- [ ] "Free text" selection triggers `promptInput()` for custom text
- [ ] Answers are correctly formatted as `Record<string, string>` mapping question text to label(s)
- [ ] Multi-select answers join labels with ", "
- [ ] The `permission_response` includes `updatedInput` with questions + answers
- [ ] MCP server uses `updatedInput` from response when present
- [ ] Timeout handling works (configurable default, timeout error detection)
- [ ] Multiple questions in one call are handled sequentially
- [ ] Existing permission approval flow is unchanged for non-AskUserQuestion requests
- [ ] Tests cover: single-select, multi-select, free text, multiple questions, timeout

### Dependencies & Constraints

- **Dependencies**: Existing `promptSelect()`, `promptCheckbox()`, `promptInput()` from `src/common/input.ts`
- **Technical Constraints**: The Unix socket protocol is line-based JSON. The response must fit in a single line. Questions are processed sequentially in the terminal.

## Implementation Guide

### Step 1: Extend the MCP server response handling in `permissions_mcp.ts`

In the `approval_prompt` tool's execute handler (around line 242-280), update the response handling to use `updatedInput` from the parent when available.

Currently:
```typescript
resolver(message.approved);  // handleParentResponse resolves with boolean
```

Change `handleParentResponse()` to resolve with an object instead of just a boolean:
```typescript
interface PermissionResponseData {
  approved: boolean;
  updatedInput?: any;
}
```

In `handleParentResponse()`:
```typescript
if (message.type === 'permission_response') {
  resolver({
    approved: message.approved,
    updatedInput: message.updatedInput,
  });
}
```

In the `approval_prompt` tool execute handler:
```typescript
const response = await requestPermissionFromParent(tool_name, input);
return {
  content: [{
    type: 'text',
    text: JSON.stringify(
      response.approved
        ? { behavior: 'allow', updatedInput: response.updatedInput ?? input }
        : { behavior: 'deny', message: `User denied permission for tool: ${tool_name}` }
    ),
  }],
};
```

This is backwards compatible — for regular permission requests, `updatedInput` is undefined and falls back to the original `input`.

### Step 2: Detect and handle AskUserQuestion in `permissions_mcp_setup.ts`

In `handlePermissionLine()`, add early detection for AskUserQuestion before the existing permission logic. At the top of the function after parsing the message:

```typescript
if (tool_name === 'AskUserQuestion') {
  await handleAskUserQuestion(message, socket, options);
  return;
}
```

### Step 3: Implement `handleAskUserQuestion()` in `permissions_mcp_setup.ts`

Create a new function that:

1. Extracts the `questions` array from `input`
2. For each question, presents a prompt to the user:
   - Builds choices from `question.options` mapped to `{name: option.label, value: option.label, description: option.description}`
   - Adds a "Free text" choice: `{name: "Free text", value: "__free_text__"}`
   - If `multiSelect === false`: uses `promptSelect()` to get a single selection
   - If `multiSelect === true`: uses `promptCheckbox()` to get multiple selections
   - If user selected "Free text" (value contains `"__free_text__"`):
     - For single-select: call `promptInput()` to get custom text
     - For multi-select: call `promptInput()`, then combine with any other selected labels
3. Builds the answers record: `{[question.question]: answerString}`
   - Single-select: just the selected label (or custom text)
   - Multi-select: labels joined with ", " (filtering out the `__free_text__` sentinel)
4. Sends the response:
```typescript
const response = {
  type: 'permission_response',
  requestId,
  approved: true,
  updatedInput: {
    questions: input.questions,
    answers,
  },
};
socket.write(JSON.stringify(response) + '\n');
```

Include timeout handling: wrap each prompt call in try/catch, use `isPromptTimeoutError()` to detect timeouts, and send a deny response on timeout.

Display formatting: Show the question header and question text with chalk for visual clarity, similar to how `handlePermissionLine()` formats the tool approval prompt. Use `process.stdout.write('\x07')` (bell) to alert the user.

### Step 4: Update `handlePermissionLine()` for the early return

The only change to `handlePermissionLine()` is the early return for AskUserQuestion at the top. The rest of the permission logic stays unchanged.

### Step 5: Update `requestPermissionFromParent()` in `permissions_mcp.ts`

Change the return type from `Promise<boolean>` to `Promise<PermissionResponseData>`. Update the resolver to pass the full response object instead of just `approved`.

The `pendingRequests` map type changes from `Map<string, (value: any) => void>` — it already uses `any`, so the resolver just needs to pass the full object.

### Step 6: Write tests in `permissions_mcp_setup.test.ts`

Add tests for AskUserQuestion handling. The test approach:

1. **Mock the prompt functions**: Since tests can't use interactive terminal prompts, mock `promptSelect`, `promptCheckbox`, and `promptInput` from `src/common/input.ts`.

2. **Test cases**:
   - **Single-select basic**: One question, user picks first option → verify answer maps question to label
   - **Multi-select basic**: One question with multiSelect, user picks two options → verify comma-separated answer
   - **Free text (single-select)**: User picks "Free text", types "custom answer" → verify answer is "custom answer"
   - **Free text (multi-select)**: User picks two options + "Free text", types "also this" → verify comma-separated with custom text
   - **Multiple questions**: Two questions in one call → verify both answers in the response
   - **Timeout handling**: Prompt times out → verify deny response is sent
   - **Socket protocol**: Verify the `permission_response` includes `updatedInput` with correct structure

3. **Test infrastructure**: Use the existing test patterns from `permissions_mcp_setup.test.ts` which likely creates mock sockets and tests the handler functions directly.

### Manual Testing

1. Run a plan with `tim agent <planId>` that's likely to trigger AskUserQuestion (e.g., a plan in "plan" mode with ambiguous requirements)
2. Verify each question appears with options and "Free text"
3. Test single-select: navigate with arrows, press enter
4. Test multi-select: select with space, submit with enter
5. Test "Free text": select it, type custom response, press enter
6. Verify Claude receives the answers and continues appropriately

## Current Progress
### Current State
- All 3 tasks complete: implementation, handler, and tests
### Completed (So Far)
- Task 1: Extended permissions_mcp.ts with PermissionResponseData interface, handleParentResponse resolves with {approved, updatedInput?}, requestPermissionFromParent returns the full object, approval_prompt tool uses response.updatedInput ?? input
- Task 2: Added handleAskUserQuestion() in permissions_mcp_setup.ts with promptSelect/promptCheckbox/promptInput support, Free text option, timeout handling, and early detection in handlePermissionLine()
- Task 3: 11 tests covering single-select, multi-select, free text, multiple questions, timeout, empty questions denial, and Free text choice presence verification
### Remaining
- None — all tasks complete
### Next Iteration Guidance
- Manual testing recommended: run `tim agent <planId>` with a plan likely to trigger AskUserQuestion
### Decisions / Changes
- handleAskUserQuestion uses narrowed Pick<PermissionsMcpOptions, 'timeout'> instead of the full options type
- Empty/malformed questions arrays are denied (approved: false) rather than silently approved
- handlePermissionLine has a top-level try/catch that sends deny responses on unexpected errors
- Removed redundant requestId validation from handleAskUserQuestion since handlePermissionLine already validates
- Non-timeout errors use log() instead of debugLog() for visibility
### Lessons Learned
- The socket handler needed `void ... .catch()` because handlePermissionLine is async but the socket data callback is sync — without it, unhandled rejections would crash the process
- Review caught that empty questions array silently approving was a real bug — always validate boundary inputs even for internal protocols
- The permissions_mcp.ts MCP server side is hard to unit test directly (requires full FastMCP setup), so testing through the socket protocol from the setup side provides the most practical coverage
### Risks / Blockers
- None
