---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "web: use structured data for client-side messages"
goal: ""
id: 253
uuid: eaf60266-b11f-4524-bfd0-505ed40f8836
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-03-24T08:34:13.237Z
promptsGeneratedAt: 2026-03-24T08:34:13.237Z
createdAt: 2026-03-22T07:23:12.505Z
updatedAt: 2026-03-24T09:26:21.214Z
tasks:
  - title: Add StructuredMessageBody type and update DisplayMessage types
    done: true
    description: 'In src/lib/types/session.ts: add import type for StructuredMessage
      from structured_messages.ts. Define StructuredMessagePayload as
      Omit<StructuredMessage, "timestamp" | "transportSource">. Add
      StructuredMessageBody interface { type: "structured", message:
      StructuredMessagePayload }. Add "structured" to MessageBodyType and
      DisplayMessageBody unions. Simplify MessageCategory to "log" | "error" |
      "structured". Update any other types affected by the MessageCategory
      change.'
  - title: Simplify server-side formatTunnelMessage for structured messages
    done: true
    description: 'In src/lib/server/session_manager.ts: replace the case
      "structured" branch in formatTunnelMessage() to set category to
      "structured", strip timestamp and transportSource from the
      StructuredMessage, and return { type: "structured", message:
      strippedMessage } as the body. Keep the triggersNotification computation
      (check transportSource before stripping). Remove the
      summarizeStructuredMessage() function entirely. Update or remove the
      categorizeMessage() export (check for external callers first). Update
      cloneBody() to handle the "structured" body type using structuredClone()
      for the message payload.'
  - title: Create client-side message formatting utilities
    done: true
    description: "Create src/lib/utils/message_formatting.ts. Port the formatting
      logic from the old summarizeStructuredMessage() into this client-side
      module. Implement getDisplayCategory(message: StructuredMessagePayload):
      DisplayCategory that maps structured message type to display categories
      (lifecycle, llmOutput, toolUse, fileChange, command, progress, error,
      userInput). Implement formatStructuredMessage(message:
      StructuredMessagePayload): DisplayMessageBody | null that replicates the
      old server-side text formatting for all message types except review_result
      (return null for that). Port helper functions like formatJsonValue(),
      keyValueEntries(), summarizeCommandResult(). Define the DisplayCategory
      type."
  - title: Update SessionMessage.svelte and session_colors.ts for new message types
    done: true
    description: 'Update src/lib/utils/session_colors.ts: change
      categoryColorClass() to accept the new DisplayCategory type (the rich
      values like lifecycle, llmOutput, toolUse etc). In
      src/lib/components/SessionMessage.svelte: add an {:else if
      message.body.type === "structured"} branch. For structured messages, use
      getDisplayCategory() to compute the color class, and
      formatStructuredMessage() for the default body rendering. For
      review_result, delegate to the dedicated ReviewResultDisplay component.
      Update truncation logic (skipTruncation for review_result rawType check
      may need adjustment).'
  - title: Create ReviewResultDisplay component for rich review rendering
    done: true
    description: "Create src/lib/components/ReviewResultDisplay.svelte. Receives the
      review_result structured message data as a prop. Render inline in the
      message stream: verdict line with emoji indicator (checkmark for
      ACCEPTABLE, X for NEEDS_FIXES), fix instructions as text if present,
      issues grouped by severity (all expanded) with severity header showing
      emoji and count with severity-specific coloring on headers only, each
      issue showing [category] file:line content with suggestion as indented
      text line, recommendations as ul/li list, action items as ul/li list."
  - title: Update server-side tests for pass-through behavior
    done: true
    description: 'In src/lib/server/session_manager.test.ts: update the
      review_result formatting test to expect bodyType "structured" and body
      containing the raw structured message data (minus
      timestamp/transportSource). Update other tests that assert specific body
      types for structured messages — all should now produce bodyType
      "structured" with the raw message. Add a test for cloneBody() with the
      structured body type. Verify triggersNotification still works correctly
      for agent_session_end.'
  - title: Add client-side formatting tests
    done: true
    description: Create src/lib/utils/message_formatting.test.ts. Test
      getDisplayCategory() maps each structured message type to the correct
      display category. Test formatStructuredMessage() produces equivalent text
      output to the old server-side summarizeStructuredMessage() for
      representative message types (agent_session_start, llm_tool_use,
      command_result, todo_update, file_change_summary, etc.). Test that
      formatStructuredMessage() returns null for review_result. Verify
      session_state_events tests still pass with the new structured body type.
changedFiles:
  - CLAUDE.md
  - docs/web-interface.md
  - src/lib/components/ReviewResultDisplay.svelte
  - src/lib/components/SessionMessage.svelte
  - src/lib/components/SessionMessage.test.ts
  - src/lib/server/session_integration.test.ts
  - src/lib/server/session_manager.test.ts
  - src/lib/server/session_manager.ts
  - src/lib/server/session_routes.test.ts
  - src/lib/server/ws_server.test.ts
  - src/lib/stores/session_state_events.test.ts
  - src/lib/types/session.ts
  - src/lib/utils/message_formatting.test.ts
  - src/lib/utils/message_formatting.ts
  - src/lib/utils/session_colors.ts
  - src/routes/api/sessions/events/events.server.test.ts
tags: []
---

Currently the server does the text formatting of messages, but this is not conducive to rich formatting on the client.

Instead, we should just pass the structured message down to the client, which can store it, and then do better
formatting.

The first example here should be to show much nicer output for review issues. The rest of the text formatting can stay
the same for now at least.

## Research

### Problem Overview

The web UI's session message pipeline currently flattens structured data into text strings on the server before sending to the client. In `session_manager.ts`, the `summarizeStructuredMessage()` function converts all 29 structured message types into one of 5 simple `DisplayMessageBody` variants (text, monospaced, todoList, fileChanges, keyValuePairs). This means the client receives pre-formatted text and can only render it as-is — no rich formatting, no expandable sections, no structured rendering of review issues, etc.

The goal is to send the raw `StructuredMessage` data through to the client for all structured message types, and move all formatting/rendering logic to the client. Non-structured tunnel messages (stdout, stderr, log, error, warn) continue to use the current body types since they don't have structured data.

As a first demonstration of the richer client-side rendering this enables, the `review_result` message type will get a dedicated rich UI component. All other structured message types will be rendered on the client in the same way they currently appear (replicating the server-side formatting logic), but the infrastructure will be in place to upgrade any message type's rendering in the future.

### Architecture of the Current Message Pipeline

The message pipeline has these layers:

1. **StructuredMessage** (`src/logging/structured_messages.ts`) — 29 typed message variants with rich fields, discriminated union on `type`
2. **TunnelMessage** (`src/logging/tunnel_protocol.ts`) — wraps structured messages in `{ type: 'structured', message: StructuredMessage }`, also handles `stdout`, `stderr`, `log`, `error`, `warn`, `debug`
3. **HeadlessOutputMessage** (`src/logging/headless_protocol.ts`) — envelope with `seq` number
4. **SessionManager** (`src/lib/server/session_manager.ts`) — receives WebSocket messages, calls `formatTunnelMessage()` which calls `summarizeStructuredMessage()` to create `DisplayMessage`
5. **DisplayMessage** (`src/lib/types/session.ts`) — the type sent over SSE to the browser and stored in the client-side session store
6. **SessionMessage.svelte** (`src/lib/components/SessionMessage.svelte`) — renders based on `body.type` discriminant

**Current `DisplayMessageBody` variants** (defined in `src/lib/types/session.ts`):
- `TextMessageBody` — `{ type: 'text', text: string }`
- `MonospacedMessageBody` — `{ type: 'monospaced', text: string }`
- `TodoListMessageBody` — `{ type: 'todoList', items: TodoUpdateItem[], explanation?: string }`
- `FileChangesMessageBody` — `{ type: 'fileChanges', changes: FileChangeItem[], status?: string }`
- `KeyValuePairsMessageBody` — `{ type: 'keyValuePairs', entries: KeyValuePairEntry[] }`

**Current `formatTunnelMessage()` function** (`session_manager.ts:686-758`):
- For `type: 'structured'` — calls `summarizeStructuredMessage()` to produce a `DisplayMessage` with category, bodyType, body
- For `stdout`/`stderr` — creates `MonospacedMessageBody` with `category: 'log'`
- For `log`/`error`/`warn` — creates `TextMessageBody` with appropriate category
- For `debug` — returns null (filtered out)

**Current `summarizeStructuredMessage()` function** (~400 lines) — a large switch on all 29 structured message types that:
- Determines `category` (lifecycle, llmOutput, toolUse, fileChange, command, progress, error, log, userInput)
- Flattens the structured data into one of the 5 body types

**The `categorizeMessage()` export** — used externally, calls `summarizeStructuredMessage()` just to get category + bodyType. After this refactor, this function will need to either be updated or removed.

**The `cloneBody()` function** (`session_manager.ts:1303`) — deep-clones each body variant. Must handle any new body types.

### The 29 Structured Message Types

From `src/logging/structured_messages.ts`, the `StructuredMessage` discriminated union:
- **Lifecycle**: `agent_session_start`, `agent_session_end`, `agent_iteration_start`, `agent_step_start`, `agent_step_end`, `prompt_request`, `prompt_answered`, `plan_discovery`, `workspace_info`, `input_required`
- **LLM Output**: `llm_thinking`, `llm_response`, `llm_status`
- **Tool Usage**: `llm_tool_use` (has `input: unknown`), `llm_tool_result` (has `result: unknown`)
- **File Changes**: `file_write`, `file_edit`, `file_change_summary`
- **Commands**: `command_exec`, `command_result`
- **Review**: `review_start`, `review_result`
- **Progress**: `todo_update`, `task_completion`, `workflow_progress`, `execution_summary`, `token_usage`
- **User**: `user_terminal_input`
- **Error**: `failure_report`

The imports in `structured_messages.ts` are all `import type` — safe for client-side use:
- `import type { ReviewOutput } from '../tim/formatters/review_output_schema.js'`
- `import type { ExecutionSummary } from '../tim/summary/types.js'`

### How Review Results Are Currently Handled (First Rich Rendering Target)

**The `review_result` case** (session_manager.ts:406-475) flattens `ReviewResultMessage` into monospaced text:
- Groups issues by severity with text icons (`!!`, `!`, `~`, `i`)
- Formats each issue as `  - [category] (file:line) content` with optional suggestion
- Returns `{ category: 'error', body: { type: 'monospaced', text: ... } }`

**ReviewResultMessage fields**: `verdict` ('ACCEPTABLE' | 'NEEDS_FIXES' | 'UNKNOWN'), `fixInstructions?`, `issues[]` (severity, category, content, file?, line?, suggestion?), `recommendations[]`, `actionItems[]`

### Key Files That Must Change

**Types:**
- `src/lib/types/session.ts` — Add `StructuredMessageBody` variant to `DisplayMessageBody`; add `import type` for `StructuredMessage`; move `MessageCategory` computation types if needed

**Server-side:**
- `src/lib/server/session_manager.ts` — Simplify `formatTunnelMessage()` for structured messages to pass through the raw data instead of calling `summarizeStructuredMessage()`; remove or simplify `summarizeStructuredMessage()`; update `cloneBody()`; move `categorizeMessage()` or mark deprecated; handle `triggersNotification` computation without full summarization

**Client-side:**
- New file for client-side message formatting/categorization (e.g. `src/lib/utils/message_formatting.ts`) — port the `summarizeStructuredMessage()` and category logic here for the default rendering of most message types
- `src/lib/components/SessionMessage.svelte` — Add rendering branch for `structured` body type; delegate to per-type components or inline formatting
- `src/lib/components/ReviewResultDisplay.svelte` (new) — rich rendering for `review_result`

**Tests:**
- `src/lib/server/session_manager.test.ts` — Update tests for the new pass-through behavior
- New tests for client-side formatting logic
- Verify existing session_state_events tests still pass

### Important Patterns and Constraints

1. **Client/server type boundary**: `src/lib/types/session.ts` cannot import modules that use `bun:sqlite`. The `structured_messages.ts` file only uses `import type`, so direct `import type { StructuredMessage }` from there should work. If not, a separate type-only file can be created.

2. **Non-structured messages unchanged**: `stdout`, `stderr`, `log`, `error`, `warn` tunnel messages have no structured data — they continue to use `TextMessageBody` and `MonospacedMessageBody` as today.

3. **Clone function**: Must handle the new `StructuredMessageBody`. Since structured messages can contain nested objects and arrays, a deep clone approach is needed. `structuredClone()` or manual cloning of the message data.

4. **SSE serialization**: All `StructuredMessage` fields must be JSON-serializable. Most are primitives/strings/arrays. The `llm_tool_use.input` and `llm_tool_result.result` fields are typed as `unknown` but documented as JSON-serializable.

5. **`triggersNotification` computation**: Currently computed in `formatTunnelMessage()` by checking `message.message.type === 'agent_session_end' && message.message.transportSource !== 'tunnel'`. This logic stays on the server since it doesn't need the full summarization — just a type check on the raw message. Note: `transportSource` is stripped from the payload sent to the client, but it's available at the point where `triggersNotification` is computed (before stripping).

6. **`categorizeMessage()` export**: Used by `src/logging/headless_message_utils.ts` or similar. Needs to be checked for external callers and updated or removed.

7. **Category simplification**: `MessageCategory` changes from 9 values to 3: `'log' | 'error' | 'structured'`. The server sets `'structured'` for all structured messages. The client computes the effective display category (for coloring, filtering) from the structured message's `type` field. Non-structured messages retain `'log'` or `'error'`.

### Considerations

- **Stripping fields**: The `StructuredMessage` has `timestamp` and `transportSource` fields that are redundant with `DisplayMessage` fields. Strip `timestamp` (already on DisplayMessage) but keep `type` (needed for discriminated union type safety). `transportSource` can also be stripped.

- **Message size**: Passing through raw structured data may be slightly larger than the current flattened text for some messages (e.g., `llm_tool_use` with large `input` objects). However, the current approach already serializes these as JSON strings via `formatJsonValue()`, so the size difference is minimal.

- **Incremental approach**: The client-side formatting can initially replicate `summarizeStructuredMessage()` exactly for all types except `review_result`. This means the visual output stays the same for most messages while the infrastructure is in place for future improvements.

## Implementation Guide

### Step 1: Add StructuredMessageBody to Client Types

**File:** `src/lib/types/session.ts`

Add `import type { StructuredMessage } from '../../logging/structured_messages.js'` at the top (using `import type` for client safety).

Define a type that strips `timestamp` and `transportSource` from the structured message but keeps `type` for discrimination:

```typescript
type StructuredMessagePayload = Omit<StructuredMessage, 'timestamp' | 'transportSource'>
```

Add a new body variant:

```typescript
interface StructuredMessageBody {
  type: 'structured'
  message: StructuredMessagePayload
}
```

Add `'structured'` to the `MessageBodyType` union. Add `StructuredMessageBody` to the `DisplayMessageBody` union.

Simplify the `MessageCategory` type to `'log' | 'error' | 'structured'`. For non-structured tunnel messages (stdout/stderr/log/warn), the server sets `'log'` or `'error'` as appropriate. For all structured messages, the server sets `'structured'`, meaning the client should look at the structured body to determine rendering (colors, filtering, etc.). The client computes the effective display category from the structured message `type` field when needed.

### Step 2: Simplify Server-Side formatTunnelMessage for Structured Messages

**File:** `src/lib/server/session_manager.ts`

Replace the `case 'structured'` branch in `formatTunnelMessage()` to:
1. Set `category` to `'structured'` for all structured messages
2. Strip `timestamp` and `transportSource` from the message
3. Return `{ type: 'structured', message: strippedMessage }` as the body
4. Keep the `triggersNotification` computation (just a type check, no formatting needed)

The large `summarizeStructuredMessage()` function can be removed entirely. The `categorizeMessage()` export should be checked for external callers and updated or removed.

Update `cloneBody()` to handle the new `'structured'` body type. Use `structuredClone()` for the message payload since it can contain arbitrary nested objects (especially `llm_tool_use.input` and `llm_tool_result.result` which are `unknown`).

### Step 3: Create Client-Side Message Formatting Utilities

**File:** `src/lib/utils/message_formatting.ts` (new)

Port the formatting logic from `summarizeStructuredMessage()` into a client-side module. This module provides two things:

1. **Category computation**: A function that maps a structured message `type` to a display category (the old 9-value `MessageCategory` values like `'lifecycle'`, `'llmOutput'`, `'toolUse'`, etc.) used for color classes and filtering. This replaces the server-side category logic.

2. **Default body formatting**: A function that takes a `StructuredMessagePayload` and returns the rendered content for the default rendering of each message type.

For the initial implementation, the body formatting should replicate the exact same text output that `summarizeStructuredMessage()` currently produces — the goal is behavioral equivalence for all types except `review_result`. This means porting the helper functions like `formatJsonValue()`, `keyValueEntries()`, `summarizeCommandResult()`, etc.

The function signatures:
```typescript
// Display category for coloring/filtering — the rich version of the old MessageCategory
type DisplayCategory = 'lifecycle' | 'llmOutput' | 'toolUse' | 'fileChange' | 'command' | 'progress' | 'error' | 'log' | 'userInput'

function getDisplayCategory(message: StructuredMessagePayload): DisplayCategory

// Returns a formatted body for default rendering, or null for types with dedicated components
function formatStructuredMessage(message: StructuredMessagePayload): DisplayMessageBody | null
```

For `review_result`, `formatStructuredMessage()` returns null, signaling that `SessionMessage.svelte` should use the dedicated `ReviewResultDisplay` component directly with the structured data.

The key insight: this module is the client-side equivalent of `summarizeStructuredMessage()`, but it lives in client-safe code (`src/lib/utils/`) and can be incrementally updated to return richer body types for specific message types.

### Step 4: Create ReviewResultDisplay Component

**File:** `src/lib/components/ReviewResultDisplay.svelte` (new)

Create a component for rendering review results inline in the message stream. It receives the structured `review_result` message data as a prop (the `StructuredMessagePayload` narrowed to the `ReviewResultMessage` fields).

Design:
- **Verdict line** — simple text with a small emoji indicator (checkmark for ACCEPTABLE, X for NEEDS_FIXES)
- **Fix instructions** — text below verdict if present
- **Issues section** grouped by severity, all groups expanded:
  - Severity header with small emoji and count (similar to console formatter icons: `🔴` critical, `🟡` major, `🟠` minor, `ℹ️` info). Severity-specific coloring on these headers.
  - Each issue: category in brackets, file:line location, content text, suggestion as a simple indented line ("Suggestion: ...")
- **Recommendations** as `<ul>` / `<li>`
- **Action items** as `<ul>` / `<li>`

### Step 5: Update SessionMessage.svelte to Handle Structured Body Type

**File:** `src/lib/components/SessionMessage.svelte`

Add a new `{:else if message.body.type === 'structured'}` branch. This branch:
1. Checks if the structured message type has a dedicated rich component (initially only `review_result` → `ReviewResultDisplay`)
2. For all other types, calls the client-side `formatStructuredMessage()` utility and renders the result using the existing body type rendering logic (text, monospaced, todoList, fileChanges, keyValuePairs)

This can be done with a derived value that computes the formatted output, or by extracting the body rendering into a sub-component that accepts any `DisplayMessageBody`.

The existing `skipTruncation` logic for `rawType === 'review_result'` should be updated to work with the new structured body type.

### Step 6: Update Tests

**Server-side tests** (`src/lib/server/session_manager.test.ts`):
- Update the `review_result` formatting test to expect `bodyType: 'structured'` and `body: { type: 'structured', message: { type: 'review_result', ... } }`
- Update any other tests that assert specific body types for structured messages
- All structured messages should now produce `bodyType: 'structured'`

**Client-side formatting tests** (new file, e.g. `src/lib/utils/message_formatting.test.ts`):
- Port relevant test cases from the server-side tests that verify text output
- Test that `formatStructuredMessage()` produces the same output as the old `summarizeStructuredMessage()` for each message type
- Test the review result case returns the dedicated body type

**Session state event tests** (`src/lib/stores/session_state_events.test.ts`):
- Verify the new structured body type survives the SSE event application pipeline

### Step 7: Manual Testing

1. Run the web UI and connect to an active agent session
2. Verify all message types render the same as before (behavioral equivalence)
3. Trigger a review (`tim review`) and verify the review result renders with the new rich component
4. Test SSE reconnection — verify replayed messages render correctly
5. Test with various review scenarios: ACCEPTABLE (no issues), NEEDS_FIXES (mixed severity issues), UNKNOWN

### Rationale for This Approach

- **All structured messages go through at once**: Rather than converting one message type at a time, all structured messages get the new `StructuredMessageBody` wrapper. This is a clean cut that avoids maintaining two code paths.
- **Default rendering preserves behavior**: The client-side formatting utility replicates the server-side logic, so all messages look the same initially. Only `review_result` gets a new rich component.
- **Category simplification**: `MessageCategory` on the wire reduces to 3 values (`log`, `error`, `structured`). The rich display category (lifecycle, toolUse, etc.) is computed client-side from the structured message type, keeping the server lean and the client in full control of display logic.
- **Extensible**: Once this is in place, adding rich rendering for any other message type is just: write a new component, add a case to the structured message rendering branch.
- **Type-safe**: Using `import type` for `StructuredMessage` preserves the discriminated union on the client, enabling exhaustive switches on `message.type`.

## Current Progress
### Current State
- All 7 tasks complete. The full structured message pass-through pipeline is working end-to-end.
- 347 web tests passing.
### Completed (So Far)
- Task 1: Added StructuredMessageBody type and StructuredMessagePayload (distributive Omit to preserve discriminated union narrowing) to both client and server type files. Simplified MessageCategory to 'log' | 'error' | 'structured'.
- Task 2: Removed ~400 lines of summarizeStructuredMessage() and helpers from server. formatTunnelMessage() now passes structured data through with defensive error handling for malformed payloads. cloneBody() uses structuredClone() for structured bodies.
- Task 3: Created src/lib/utils/message_formatting.ts with getDisplayCategory(), formatStructuredMessage(), and ported helper functions. Returns null for review_result.
- Task 4: Updated SessionMessage.svelte with structured body rendering branch. Computes displayCategory from structured payload for color class, truncation, and key-value behavior. Updated session_colors.ts to accept DisplayCategory with restored pre-refactor color mapping.
- Task 5: Created ReviewResultDisplay.svelte with verdict line, issues grouped by severity with emoji headers, recommendations and action items lists. Hardened against missing/invalid arrays.
- Task 6: Server-side tests updated for pass-through behavior including malformed payload validation (null, undefined, arrays, objects without type).
- Task 7: Client-side formatting tests comprehensive. SessionMessage.test.ts rewritten for structured body type.
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Used distributive conditional type for StructuredMessagePayload instead of simple Omit, to preserve discriminated union narrowing on the client
- categorizeMessage() was removed entirely (no external callers found outside of tests)
- Color mapping restored to match pre-refactor values (green for lifecycle/llmOutput, cyan for toolUse/fileChange/command, blue for progress, orange for userInput, red for error)
- Server now validates structured payloads are plain objects with a string `type` before passing through; rejects malformed payloads to a text log fallback
- Server strips `llm_tool_result.result` when `resultSummary` is present to avoid sending heavy payloads the client doesn't render
- ReviewResultDisplay hardened with Array.isArray guards for issues, recommendations, actionItems
### Lessons Learned
- When removing server-side formatting and replacing with pass-through, don't forget to preserve defensive error handling for malformed WebSocket payloads. The try/catch around structured message processing is important.
- Both src/lib/types/session.ts (client) and src/lib/server/session_manager.ts (server) have mirrored type definitions that must be kept in sync.
- When passing raw structured data through to the client, validate payload shape at the boundary (not just null checks) — arrays, primitives, and objects without a `type` field can slip through and crash client-side rendering.
- Pass-through architectures need to strip heavy fields the client doesn't use, especially for high-volume messages like tool results. The client formatter may only use a summary field while the full result stays in memory.
### Risks / Blockers
- None
