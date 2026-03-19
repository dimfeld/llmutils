---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Add prefix_select prompt support to web UI
goal: ""
id: 231
uuid: 1a1b1c8e-f3f2-4e38-b5cd-a3d518a23150
generatedBy: agent
status: pending
priority: medium
dependencies:
  - 229
discoveredFrom: 227
references:
  "227": 6787e32d-3918-440e-8b8b-0562ba59e095
  "229": fb9383c8-5ee1-4084-afe6-8a8572189d4e
planGeneratedAt: 2026-03-19T01:11:11.620Z
promptsGeneratedAt: 2026-03-19T01:11:11.620Z
createdAt: 2026-03-17T09:05:46.119Z
updatedAt: 2026-03-19T01:11:11.621Z
tasks:
  - title: Extract extractCommandAfterCd to client-safe module
    done: false
    description: Create src/common/prefix_prompt_utils.ts containing the
      extractCommandAfterCd function. Update src/common/prefix_prompt.ts to
      import and re-export from the new file so existing callers are unaffected.
      Verify existing tests still pass.
  - title: Add prefix_select branch to PromptRenderer.svelte
    done: false
    description: "Add a new {:else if} branch for prefix_select in
      src/lib/components/PromptRenderer.svelte before the {:else} fallback.
      Import extractCommandAfterCd from $common/prefix_prompt_utils.js. Add
      state: prefixWordIndex (number, default last word). Add derived values:
      displayCommand (after extractCommandAfterCd), commandWords (split by
      whitespace). Render command words as clickable spans in monospace font —
      selected words (index <= prefixWordIndex) in green/accent, remaining in
      gray/dimmed. Clicking a word sets prefixWordIndex. Add two action buttons:
      Submit Prefix (sends {exact: false, command: selectedPrefix}) and Allow
      Exact Command (sends {exact: true, command: displayCommand}). Both
      disabled when sending. If command field is missing, fall through to the
      unsupported prompt fallback. Reset prefixWordIndex in the existing
      $effect() block when prompt changes."
  - title: Add server action test for prefix_select prompt response
    done: false
    description: "In src/routes/api/sessions/actions.server.test.ts, add a test that
      sets up a prefix_select prompt (with promptConfig.command set to a
      multi-word command), then calls the respond route with a
      PrefixPromptResult value ({exact: false, command: prefix}) and verifies it
      is forwarded correctly over WebSocket. Follow the existing test pattern."
tags: []
---

Add prefix_select prompt type rendering to the web Sessions view. This is a custom prompt type specific to tim that was deferred from the initial Sessions implementation (plan 229). Requires implementing the prefix selection UI component that matches the CLI behavior.

## Expected Behavior/Outcome

When an agent session sends a `prefix_select` prompt (used for bash command prefix authorization), the web UI should render an interactive component that allows users to:

1. See the full command with visual prefix highlighting (selected portion vs. remaining portion) in a monospace continuous display
2. Adjust the prefix boundary by clicking word segments
3. Confirm the selected prefix, or opt to select the exact full command
4. The response is sent back as a `PrefixPromptResult` object: `{ exact: boolean, command: string }`

**States:**
- **Initial**: Command displayed with all words selected (full prefix), matching CLI default of `selectedWordIndex = words.length - 1`
- **Navigating**: User clicks words to adjust prefix boundary; selected words highlighted in accent color, remaining words dimmed
- **Sending**: Submit button disabled while response is in flight
- **Fallback**: If `command` field is missing from promptConfig, show the existing unsupported-prompt message

## Key Findings

### Product & User Story
As an operator monitoring agent sessions in the web UI, when an agent requests bash command prefix authorization, I want to interactively select the command prefix to allow — just as I would in the terminal — so I don't have to switch to the terminal to respond.

### Design & UX Approach
The CLI uses left/right arrow keys to navigate word boundaries, "a" to toggle all/first, "e" for exact command, and Enter to confirm. The web UI should translate this into a clickable word-segment interface:
- Each word in the command is a clickable segment rendered in monospace font as a continuous command string
- Clicking a word sets the prefix boundary to include that word and all preceding words
- Selected words are visually highlighted (green/accent), remaining words are dimmed (gray)
- A "Submit Prefix" button confirms the selection
- An "Allow Exact Command" button sends `{ exact: true, command: fullCommand }`

### Technical Plan & Risks
- **Low risk**: This is a self-contained addition to `PromptRenderer.svelte` — no server-side changes needed
- **The `command` field** is already part of `PromptConfig` in the client types (`src/lib/types/session.ts:101`)
- **The `extractCommandAfterCd` utility** (`src/common/prefix_prompt.ts:14-18`) strips `cd <dir> &&` prefixes from commands before displaying; the web component should reuse this logic
- **Response format**: Must send `{ exact: boolean, command: string }` as the `value` to `sendPromptResponse`
- **No server changes**: The respond route already accepts arbitrary `value` payloads

### Pragmatic Effort Estimate
Small feature. One new `{:else if}` branch in `PromptRenderer.svelte` plus supporting state, the `extractCommandAfterCd` utility import, and tests. Likely 1-2 hours of focused work.

## Acceptance Criteria

- [ ] Web UI renders prefix_select prompts with clickable word segments showing the command
- [ ] Clicking a word adjusts the prefix boundary; selected portion is visually distinct from unselected
- [ ] "Submit Prefix" sends `{ exact: false, command: selectedPrefix }` via `sendPromptResponse`
- [ ] "Allow Exact Command" sends `{ exact: true, command: fullCommand }` via `sendPromptResponse`
- [ ] `extractCommandAfterCd` is applied to strip `cd <dir> &&` patterns before display
- [ ] Handles edge cases: single-word commands, empty command string
- [ ] All new code paths are covered by tests

## Dependencies & Constraints

- **Dependencies**: Depends on the sessions infrastructure from plan 229 (already completed)
- **Technical Constraints**: The `extractCommandAfterCd` function must be extracted from `src/common/prefix_prompt.ts` (which imports `@inquirer/core` and `chalk`) into its own file to avoid pulling terminal-only dependencies into the SvelteKit client bundle.

## Implementation Notes

### Recommended Approach
Add a new `{:else if prompt.promptType === 'prefix_select'}` branch in `PromptRenderer.svelte` that:
1. Extracts the command from `prompt.promptConfig.command`
2. Applies `extractCommandAfterCd` to get the display command
3. Splits into words and renders each as a clickable `<button>` or `<span>`
4. Tracks `selectedWordIndex` state (defaulting to last word = full command)
5. Provides "Submit Prefix" and "Allow Exact Command" action buttons

### Potential Gotchas
- `extractCommandAfterCd` must be extracted to a separate file (`src/common/prefix_prompt_utils.ts`) since `prefix_prompt.ts` imports `@inquirer/core` and `chalk` which can't be bundled client-side.
- The CLI defaults to selecting the last word (full command). The web UI must match this default for safety.
- Single-word commands should still work — the entire command is both the prefix and the exact match.

## Research

### Existing Prompt Rendering Pattern (PromptRenderer.svelte)

The component at `src/lib/components/PromptRenderer.svelte` renders all prompt types within a single component using `{#if}/{:else if}` branches. It receives `prompt: ActivePrompt` and `connectionId: string` as props.

**Key patterns:**
- State variables declared at component level: `inputValue`, `selectedValue`, `checkedValues`, `sending`
- A shared `respond(value)` async function that calls `sessionManager.sendPromptResponse(connectionId, prompt.requestId, value)`
- `sending` flag disables buttons during the request
- `$effect()` resets state when the prompt changes (via derived defaults)
- Each prompt type has its own handler functions (e.g., `handleConfirm`, `handleInputSubmit`)
- The component is wrapped in a `<div class="border-b border-gray-700 bg-gray-800 px-4 py-3">` container
- Header, message, and question fields are rendered above the prompt-specific UI

**Currently unsupported types** fall through to a `{:else}` block showing "This prompt type is not yet supported in the web UI."

### prefix_select CLI Behavior (src/common/prefix_prompt.ts)

The CLI implementation uses `@inquirer/core`'s `createPrompt` to build a custom terminal prompt:

- **Input**: `{ message: string, command: string }` — the `command` field contains the raw bash command
- **Output**: `{ exact: boolean, command: string }` — `PrefixPromptResult`
- **Word splitting**: `command.split(/\s+/).filter(word => word.length > 0)`
- **Default selection**: Last word index (`words.length - 1`), meaning the full command is selected by default
- **Navigation**: Left/right arrows move word boundary, "a" toggles between first and last word, "e" selects exact command, Enter confirms
- **Display**: Selected prefix in green, remaining in gray
- **Preprocessing**: `extractCommandAfterCd()` strips `cd <dir> && ` prefixes before word splitting

### PromptConfig Type (src/lib/types/session.ts)

The `PromptConfig` interface already includes `command?: string` at line 101, which is the field used by prefix_select prompts. The `ActivePrompt` interface wraps this with `requestId`, `promptType`, `promptConfig`, and optional `timeoutMs`.

### Response Transport

The response flow is:
1. `PromptRenderer` calls `sessionManager.sendPromptResponse(connectionId, requestId, value)`
2. Client store POSTs to `/api/sessions/{connectionId}/respond` with `{ requestId, value }`
3. Server route validates and calls `SessionManager.sendPromptResponse()`
4. Server sends `{ type: 'prompt_response', requestId, value }` over WebSocket to the agent
5. Agent receives the response (the `value` is the `PrefixPromptResult` object)

The respond route accepts any JSON-serializable `value` — no changes needed for the `{ exact, command }` shape.

### Test Patterns

- **Server action tests** (`src/routes/api/sessions/actions.server.test.ts`): Create a `SessionManager` with temp DB, simulate WebSocket connections, send structured messages, then call route handlers directly and verify responses
- **SSE event tests** (`src/lib/stores/session_state_events.test.ts`): Unit test `applySessionEvent()` with mock state objects, verify session data mutations
- **No component tests**: The existing prompt types don't have Svelte component tests — testing is done at the data/event layer

### extractCommandAfterCd Import Consideration

The function at `src/common/prefix_prompt.ts:14-18` is:
```typescript
export function extractCommandAfterCd(command: string): string {
  const cdPattern = /^cd\s+(?:"[^"]+"|'[^']+'|[^\s]+)\s*&&\s*(.+)$/;
  const match = command.match(cdPattern);
  return match ? match[1].trim() : command;
}
```

The file also imports `createPrompt, useState, useKeypress, isEnterKey` from `@inquirer/core` and `chalk`. These are terminal-only dependencies. The function will be extracted to `src/common/prefix_prompt_utils.ts` to avoid bundling issues in SvelteKit client code.

## Implementation Guide

### Step 1: Extract extractCommandAfterCd to a client-safe module

Extract `extractCommandAfterCd` from `src/common/prefix_prompt.ts` to a new file `src/common/prefix_prompt_utils.ts` that has no terminal dependencies (`@inquirer/core`, `chalk`). Update `src/common/prefix_prompt.ts` to re-export from the new file so existing callers are unaffected. Move the existing tests for this function to cover the new import path as well.

The `$common` alias is configured in `svelte.config.js` for importing from the CLI codebase.

### Step 2: Add prefix_select rendering to PromptRenderer.svelte

Add a new `{:else if prompt.promptType === 'prefix_select'}` branch in `src/lib/components/PromptRenderer.svelte`, before the fallback `{:else}` block.

**State to add:**
- `prefixWordIndex`: number state tracking which word is the rightmost selected word (default: last word)
- Derived `commandWords`: the command split into words after `extractCommandAfterCd`
- Derived `displayCommand`: result of `extractCommandAfterCd(prompt.promptConfig.command ?? '')`

**UI structure:**
```
[Command display: clickable word segments]
[Keyboard hint text]
[Submit Prefix] [Allow Exact Command] buttons
```

**Word segments**: Render each word as a `<button>` element. Words at index `<= prefixWordIndex` get the "selected" style (e.g., `text-green-400` or `bg-green-900/50`). Words after get the "dimmed" style (e.g., `text-gray-500`). Clicking a word sets `prefixWordIndex` to that word's index.

**Action buttons:**
- "Submit Prefix": Calls `respond({ exact: false, command: words.slice(0, prefixWordIndex + 1).join(' ') })`
- "Allow Exact Command": Calls `respond({ exact: true, command: displayCommand })`
- Both disabled when `sending` is true

**Handler functions to add:**
- `handlePrefixSubmit()`: Builds the prefix string and calls `respond()`
- `handleExactCommand()`: Calls `respond({ exact: true, command: displayCommand })`

**Reset on prompt change**: The existing `$effect()` block resets state for other prompt types. Add `prefixWordIndex` reset logic there, defaulting to `commandWords.length - 1`.

### Step 3: Handle edge cases

- **Missing command**: If `prompt.promptConfig.command` is undefined or empty, fall through to the existing unsupported-prompt-type message
- **Single word**: Works naturally — one clickable word, Submit Prefix and Allow Exact Command produce the same result
- **Command with cd prefix**: `extractCommandAfterCd` handles this transparently

### Step 4: Add tests

Since the existing prompt types don't have Svelte component-level tests, follow the same testing strategy:

1. **Unit test `extractCommandAfterCd`** — already tested in `src/common/prefix_prompt.ts` tests (verify this)
2. **Server action test**: Add a test case in `src/routes/api/sessions/actions.server.test.ts` that sets up a `prefix_select` prompt and verifies the respond route correctly forwards a `PrefixPromptResult` value
3. **SSE event test**: Add a test in `src/lib/stores/session_state_events.test.ts` that verifies `session:prompt` with `promptType: 'prefix_select'` correctly sets the active prompt

### Step 5: Manual testing

1. Start the web dev server (`bun run dev`)
2. Connect an agent session that triggers a prefix_select prompt (e.g., run a tim agent command that requests bash permissions)
3. Verify:
   - The prompt renders with clickable word segments in monospace font
   - Clicking words adjusts the selection boundary
   - "Submit Prefix" sends the correct prefix
   - "Allow Exact Command" sends the full command with `exact: true`
   - The prompt clears after responding
   - Single-word commands work correctly
