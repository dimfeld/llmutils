---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "tim-gui: enable interactive prompts"
goal: ""
id: 180
uuid: 4d9ccb0b-e988-479a-8f5a-4920747c72ec
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-02-19T01:07:28.573Z
promptsGeneratedAt: 2026-02-19T01:07:28.573Z
createdAt: 2026-02-13T06:47:24.027Z
updatedAt: 2026-02-19T18:43:43.279Z
tasks:
  - title: Add command field to PromptConfigPayload and promptResponse to
      OutgoingMessage
    done: true
    description: 'In SessionModels.swift: (1) Add `command: String?` property to
      `PromptConfigPayload` with CodingKeys, memberwise init, and custom decoder
      support. This is needed for prefix_select prompts. (2) Create
      `PromptResponseValue` enum with cases: `.bool(Bool)`, `.string(String)`,
      `.int(Int)`, `.double(Double)`, `.array([PromptResponseValue])`,
      `.object([String: PromptResponseValue])`. Implement `Encodable` to
      serialize each case as the correct JSON type. (3) Add
      `.promptResponse(requestId: String, value: PromptResponseValue)` case to
      `OutgoingMessage` enum, encoding as `{"type": "prompt_response",
      "requestId": "...", "value": <typed json>}`. (4) Add tests in
      SessionModelTests.swift: decode command field for prefix_select, encode
      promptResponse for each value type (bool, string, int, array, object with
      mixed types for prefix_select).'
  - title: Add prompt state tracking to SessionState
    done: true
    description: "In SessionModels.swift, add `pendingPrompt: PromptRequestPayload?`
      property to `SessionItem`. In SessionState.swift, add methods: (1)
      `setActivePrompt(connectionId: UUID, prompt: PromptRequestPayload)` — sets
      pendingPrompt on matching session, but no-ops if the connection is
      currently replaying (check `replayingConnections`). (2)
      `clearActivePrompt(connectionId: UUID, requestId: String)` — clears
      pendingPrompt only if requestId matches, also no-ops during replay. (3)
      `sendPromptResponse(sessionId: UUID, requestId: String, value:
      PromptResponseValue) async throws` — sends `.promptResponse`
      OutgoingMessage via sendMessageHandler, clears the active prompt. (4)
      Update `markDisconnected` to clear pendingPrompt. Add tests in
      SessionStateTests.swift: setActivePrompt sets prompt on correct session,
      clearActivePrompt only clears matching requestId, sendPromptResponse sends
      correct message and clears prompt, disconnect clears prompt, replay mode
      prevents setActivePrompt/clearActivePrompt."
  - title: Wire prompt events in TimGUIApp handler
    done: true
    description: "In TimGUIApp.swift wsHandler `.output` case, after the existing
      message formatting and appending, add pattern matching on the tunnel
      message: for `.structured(message: .promptRequest(payload))` call
      `sessionState.setActivePrompt(connectionId:, prompt:)`, for
      `.structured(message: .promptAnswered(payload))` call
      `sessionState.clearActivePrompt(connectionId:, requestId:)`. The replay
      safety is handled inside those SessionState methods (they check
      replayingConnections internally). No new tests needed here — the behavior
      is tested through SessionState tests."
  - title: Build prompt UI components (confirm, input, select, checkbox)
    done: true
    description: "Create new file `tim-gui/TimGUI/PromptViews.swift` with SwiftUI
      views: (1) `ConfirmPromptView` — shows message text and Yes/No buttons,
      default option visually highlighted (e.g. `.borderedProminent` vs
      `.bordered`), tapping sends `PromptResponseValue.bool`. (2)
      `InputPromptView` — shows message, optional validationHint caption,
      TextField pre-filled with default value, submit button. Enter key submits.
      Sends `.string`. (3) `SelectPromptView` — shows message, list of
      radio-style rows (circle icon filled/unfilled), tapping highlights but
      does not submit. Separate submit button. Default pre-selected. Sends the
      choice value (`.string`, `.int`, or `.double` depending on the original
      value). (4) `CheckboxPromptView` — shows message, list of toggleable
      checkbox rows, pre-checked from `checked: true`. Submit button sends
      `.array` of selected values. (5) `PromptContainerView` — switches on
      `promptType` string and renders the appropriate component. Shows message
      as header. For unknown prompt types, show message text with a note that
      the prompt type is not supported in the GUI."
  - title: Build PrefixSelectPromptView
    done: true
    description: 'In `tim-gui/TimGUI/PromptViews.swift`, add
      `PrefixSelectPromptView`: shows the prompt message, then the command
      string split into word segments displayed as clickable chips/buttons in a
      wrapping horizontal layout (using SwiftUI Layout or LazyVGrid). Clicking a
      word selects that word and all words before it (prefix selection) —
      selected words are visually highlighted (e.g. green background),
      unselected words are dimmed. An `Exact` button/toggle selects the full
      command literally (all words highlighted with a different indicator). A
      submit button sends `.object(["exact": .bool(isExact), "command":
      .string(selectedPrefix)])` where selectedPrefix is the joined selected
      words (or full command if exact). Handle edge case: if command field is
      nil, show an error message in the prompt container.'
  - title: Integrate prompt UI into SessionDetailView and add remaining tests
    done: true
    description: "In SessionsView.swift `SessionDetailView`, add
      `PromptContainerView` between the message scroll view and
      `MessageInputBar`. Only show when `session.pendingPrompt != nil` and
      `session.isActive`. Pass a response callback that calls
      `sessionState.sendPromptResponse()`. The prompt container should have a
      visual separator (e.g. `.ultraThinMaterial` background, top border). Add
      test in SessionStateTests: setActivePrompt during replay is no-op. Add
      test in MessageFormatterTests: prompt_request still generates a log
      message for the message list. Verify existing
      prompt_request/prompt_answered formatter tests still pass."
  - title: "Address Review Feedback: `select`/`checkbox` responses do not preserve
      backend value types, violating the prompt contract."
    done: true
    description: >-
      `select`/`checkbox` responses do not preserve backend value types,
      violating the prompt contract.


      - `PromptChoiceConfigPayload` coerces every choice `value` into `String`
      (`tim-gui/TimGUI/SessionModels.swift:524`).

      - `choiceValueToResponseValue` only attempts `Int`/`Double`/`String`,
      never `Bool` (`tim-gui/TimGUI/PromptViews.swift:8`).

      - Result: boolean choices (`true`/`false`) are sent as strings, and string
      values that look numeric are silently converted to numbers.


      Backend prompt APIs explicitly allow `string | number | boolean` for
      select/checkbox (`src/common/input.ts:253`, `src/common/input.ts:385`).
      This implementation changes value identity and can break prompt resolution
      logic that expects exact types.


      Fix: store typed choice/default values in Swift (typed enum), and encode
      exactly that type in `prompt_response`.


      Suggestion: Replace `value: String?` with a typed payload (e.g. enum for
      bool/int/double/string), remove heuristic conversion in
      `choiceValueToResponseValue`, and encode exact original types.


      Related file: tim-gui/TimGUI/SessionModels.swift:524
  - title: "Address Review Feedback: `sendPromptResponse` can clear a newer prompt
      due to an async race."
    done: true
    description: >-
      `sendPromptResponse` can clear a newer prompt due to an async race.


      `SessionState.sendPromptResponse` awaits network send, then
      unconditionally sets `session.pendingPrompt = nil`
      (`tim-gui/TimGUI/SessionState.swift:201`). While suspended, the main actor
      can process incoming `prompt_request` for the next prompt and set
      `pendingPrompt`; when this method resumes, it wipes that new prompt.


      This can leave backend waiting on a prompt while GUI shows none.


      Fix: only clear if `pendingPrompt?.requestId == requestId`, or rely on
      `prompt_answered` to clear state.


      Suggestion: Guard clearing by requestId match after await, and add a
      regression test that injects a new prompt during `sendMessageHandler`
      suspension.


      Related file: tim-gui/TimGUI/SessionState.swift:201
  - title: "Address Review Feedback: `choiceValueToResponseValue` does not handle
      boolean string coercion."
    done: true
    description: >-
      `choiceValueToResponseValue` does not handle boolean string coercion.
      `PromptChoiceConfigPayload` coerces boolean values to strings
      ("true"/"false"), but `choiceValueToResponseValue` only checks for Int and
      Double, falling through to `.string("true")` instead of `.bool(true)`. If
      a select or checkbox prompt ever had boolean choice values, the GUI would
      send the wrong type to the backend. The backend does `return wsValue as T`
      with no validation, so a string where a boolean is expected could cause
      subtle bugs.


      Suggestion: Add boolean checks before the string fallback: if value ==
      "true" { return .bool(true) } and if value == "false" { return
      .bool(false) }.


      Related file: tim-gui/TimGUI/PromptViews.swift:8-16
  - title: "Address Review Feedback: Prompt submit failures are silently swallowed
      in UI."
    done: true
    description: >-
      Prompt submit failures are silently swallowed in UI.


      `SessionDetailView` uses `try?` when sending prompt responses
      (`tim-gui/TimGUI/SessionsView.swift:347`), so send failures are invisible
      to users. This creates silent non-delivery with no retry/error feedback.


      Fix: handle errors explicitly (same pattern as `MessageInputBar`) and
      present an inline error state.


      Suggestion: Replace `try?` with do/catch and UI error feedback + retry
      path.


      Related file: tim-gui/TimGUI/SessionsView.swift:347
  - title: "Address Review Feedback: No double-submission protection on prompt views."
    done: true
    description: >-
      No double-submission protection on prompt views. The prompt buttons can be
      clicked multiple times before the async send completes and pendingPrompt
      is cleared. Unlike MessageInputBar which tracks isSending state and
      disables the send button, the prompt views have no such guard. While the
      backend handles duplicates gracefully (ignores unknown requestIds), this
      is inconsistent with the existing MessageInputBar pattern.


      Suggestion: Consider adding an isSending state or disabling the prompt
      buttons after the first click. Alternatively, clear the prompt
      optimistically before awaiting the send, similar to how confirm/select
      actions are meant to be one-shot.


      Related file: tim-gui/TimGUI/PromptViews.swift:58-318
  - title: "Address Review Feedback: `prefix_select` in the GUI does not implement
      the same command normalization as the terminal custom prefix prompt."
    done: true
    description: >-
      `prefix_select` in the GUI does not implement the same command
      normalization as the terminal custom prefix prompt. In
      `tim-gui/TimGUI/PromptViews.swift:327`, the GUI splits `config.command`
      directly, and in `tim-gui/TimGUI/PromptViews.swift:376` it returns the raw
      command for `exact`. The terminal implementation first strips leading `cd
      <dir> &&` via `extractCommandAfterCd` (`src/common/prefix_prompt.ts:23`)
      and returns that normalized command (`src/common/prefix_prompt.ts:39`).
      This mismatch means GUI responses can include `cd`/path segments and
      produce different permission prefixes than terminal behavior, violating
      the custom prefix prompt contract.


      Suggestion: Normalize `command` in the GUI with the same
      `extractCommandAfterCd` semantics before rendering chips and before
      emitting `prompt_response`. Add regression tests using commands like `cd
      /repo && npm test` to verify parity with terminal behavior.


      Related file: tim-gui/TimGUI/PromptViews.swift:327
changedFiles:
  - README.md
  - tim-gui/AGENTS.md
  - tim-gui/TimGUI/PromptViews.swift
  - tim-gui/TimGUI/SessionModels.swift
  - tim-gui/TimGUI/SessionState.swift
  - tim-gui/TimGUI/SessionsView.swift
  - tim-gui/TimGUI/TimGUIApp.swift
  - tim-gui/TimGUI.xcodeproj/project.pbxproj
  - tim-gui/TimGUITests/SessionModelTests.swift
  - tim-gui/TimGUITests/SessionStateTests.swift
tags: []
---

We want to support the 'prompt_request' and 'prompt_response' messages in the GUI, asking for actual input from the user and returning the result. Support all the different types of prompts,
including our custom "prefix prompt".

## Expected Behavior/Outcome

When a `prompt_request` structured message arrives over the WebSocket, the GUI should present an interactive UI for that prompt type (confirm, select, input, checkbox, or prefix_select). The user interacts with the prompt, and the GUI sends a `prompt_response` message back over the WebSocket with the selected value. The backend resolves the pending prompt and continues execution. Meanwhile, the terminal can still race to answer the same prompt — whichever source answers first wins.

### States

- **No active prompt**: The session detail view shows the normal message list and message input bar.
- **Active prompt**: A prompt UI panel appears above the message input bar, showing the prompt question and type-specific controls (buttons, radio list, text field, checkboxes, or prefix selector). The message input bar remains visible for free-form messages.
- **Prompt answered**: When a `prompt_answered` structured message arrives (regardless of source), the prompt UI is dismissed and the answer is logged in the message list.
- **Prompt timeout**: The backend handles timeouts and sends a `prompt_answered` message when one expires, which clears the GUI prompt automatically. No GUI-side countdown timer is needed.
- **Session disconnected**: Any active prompt is cleared when the session disconnects.

## Key Findings

### Product & User Story
As a tim-gui user monitoring an agent session, I want to respond to interactive prompts (confirm, select, input, checkbox, prefix_select) directly in the GUI, so that I don't need to switch to the terminal to provide input when the agent needs a decision.

### Design & UX Approach
- The prompt UI appears as a distinct panel in the session detail view, visually separated from the message list.
- Each prompt type gets a purpose-built UI component:
  - **confirm**: Two buttons (Yes/No), with the default highlighted.
  - **select**: A list of radio-button-style options, single selection with highlight-then-submit (separate submit button).
  - **input**: A text field with submit button, showing validation hints and default values.
  - **checkbox**: A list of toggleable checkboxes with submit button.
  - **prefix_select**: A segmented view of command words that can be toggled on/off from left to right, plus an "exact" option.
- Prompts are non-blocking — the user can still scroll through messages and the message input bar remains available.
- If a prompt is answered from the terminal (or times out), the GUI prompt disappears automatically.

### Technical Plan & Risks
- **Plumbing already exists**: The backend `HeadlessAdapter` already handles `prompt_response` messages (type `'prompt_response'`, fields `requestId`, `value`, optional `error`). The headless protocol is defined. The `raceWithWebSocket` function in `input.ts` handles the terminal-vs-GUI race.
- **Missing `command` field**: The `PromptConfigPayload` Swift model does not currently decode the `command` field used by `prefix_select` prompts. This needs to be added.
- **Missing `promptResponse` OutgoingMessage case**: The `OutgoingMessage` enum only has `.userInput`. A `.promptResponse(requestId:, value:)` case is needed.
- **Value serialization**: The prompt response `value` field is `unknown` on the backend. For `confirm`, it's a boolean; for `select`, it can be string/number/boolean; for `checkbox`, it's an array; for `prefix_select`, it's `{exact: boolean, command: string}`. The GUI needs to serialize these correctly as JSON.
- **Race condition**: The `prompt_answered` message may arrive before the GUI has had time to display the prompt (if the terminal answers instantly). The GUI should handle this gracefully by not showing a prompt that's already answered.

### Pragmatic Effort Estimate
This feature involves changes across the full GUI stack (models, state, views, server communication) and the backend model. The prefix_select prompt is the most complex UI component. Estimated 5-7 focused tasks.

## Acceptance Criteria
- [ ] When a `prompt_request` arrives, an interactive prompt UI appears for the session.
- [ ] The user can respond to all five prompt types (confirm, select, input, checkbox, prefix_select).
- [ ] The GUI sends a correctly-formatted `prompt_response` WebSocket message with the right value types.
- [ ] When `prompt_answered` arrives (from any source), the active prompt UI is dismissed.
- [ ] Prompt auto-clears when the backend sends `prompt_answered` due to timeout (no GUI-side timer needed).
- [ ] The message input bar remains usable while a prompt is active.
- [ ] The `PromptConfigPayload` decodes the `command` field for prefix_select prompts.
- [ ] All new code paths are covered by tests.

## Dependencies & Constraints
- **Dependencies**: Relies on the existing `HeadlessAdapter` prompt handling (`waitForPromptResponse`, `handleServerMessage`) in the TypeScript backend. Relies on existing `PromptRequestPayload` and `PromptAnsweredPayload` Swift models.
- **Technical Constraints**: The `value` in `prompt_response` must match the types the backend expects (boolean for confirm, string/number/boolean for select, array for checkbox, `{exact, command}` for prefix_select). The GUI must not break the existing terminal-vs-WebSocket race pattern.

## Implementation Notes

### Recommended Approach
1. Start with the data model changes (add `command` to `PromptConfigPayload`, add `promptResponse` to `OutgoingMessage`, add pending prompt tracking to `SessionState`).
2. Build the prompt UI components one at a time, starting with the simpler types (confirm, then input, then select, then checkbox, then prefix_select).
3. Wire up the state management to show/dismiss prompts based on incoming structured messages.
4. Add `sendPromptResponse` to `SessionState` and wire it through the message handler.

### Potential Gotchas
- **Value types**: The backend expects specific types for each prompt. Booleans must be JSON `true`/`false`, not strings. Arrays must be JSON arrays. The `prefix_select` value must be `{"exact": bool, "command": "string"}`.
- **Race with terminal**: If the terminal answers before the GUI renders the prompt, the `prompt_answered` message may arrive before the prompt is stored in state. Use the `requestId` to match answers to requests.
- **Prompt answered from another source**: When `prompt_answered` arrives with `source: "terminal"`, the GUI should dismiss its prompt UI without sending a response.
- **Multiple rapid prompts**: The backend sends prompts one at a time (each prompt blocks until answered), so only one prompt can be active per session at a time.
- **Timeout handling**: The backend handles timeouts and sends `prompt_answered` when one expires. The GUI just needs to clear the prompt on that message — no client-side timer needed.
- **Replay safety**: During message replay (after reconnect), `prompt_request` and `prompt_answered` messages are historical — do not call `setActivePrompt` or `clearActivePrompt` during replay. Only set active prompts for live (non-replay) messages.

## Research

### Architecture Overview

The tim-gui system uses a native SwiftUI application (not web-based) that communicates with the backend via a local WebSocket server on `localhost:8123`. The communication follows a well-defined protocol:

- **Backend → GUI**: `HeadlessMessage` types sent as JSON over WebSocket, including `session_info`, `output` (wrapping `TunnelMessage`), `replay_start`, `replay_end`.
- **GUI → Backend**: `HeadlessServerMessage` types, currently `user_input` and `prompt_response`.

### Prompt System Architecture (Backend)

The prompt system is defined in `src/common/input.ts` with five wrapper functions:
- `promptConfirm()` → boolean
- `promptSelect()` → string | number | boolean
- `promptInput()` → string
- `promptCheckbox()` → array of string | number | boolean
- `promptPrefixSelect()` → `{ exact: boolean, command: string }`

Each function follows the same pattern:
1. Build a `PromptRequestMessage` with a unique `requestId` (UUID).
2. If in tunnel context, forward to orchestrator via `TunnelAdapter.sendPromptRequest()`.
3. Otherwise, send `prompt_request` structured message, then:
   - If headless adapter exists, race terminal inquirer against WebSocket response via `raceWithWebSocket()`.
   - Otherwise, run terminal-only inquirer with optional timeout.
4. After resolution, send `prompt_answered` structured message.

### Message Protocol (Backend)

**prompt_request** (backend → GUI via structured message):
```typescript
{
  type: 'prompt_request',
  timestamp: string,
  requestId: string,           // UUID
  promptType: 'input' | 'confirm' | 'select' | 'checkbox' | 'prefix_select',
  promptConfig: {
    message: string,
    default?: string | number | boolean,
    choices?: Array<{ name, value, description?, checked? }>,
    command?: string,          // Only for prefix_select
    pageSize?: number,
    validationHint?: string,   // Only for input
  },
  timeoutMs?: number,
}
```

**prompt_response** (GUI → backend via WebSocket):
```json
{
  "type": "prompt_response",
  "requestId": "matching-uuid",
  "value": <depends on prompt type>
}
```

The `HeadlessAdapter.handleServerMessage()` at `src/logging/headless_adapter.ts:191` receives this, looks up the pending promise by `requestId`, and resolves it.

**prompt_answered** (backend → GUI via structured message, after resolution):
```typescript
{
  type: 'prompt_answered',
  timestamp: string,
  requestId: string,
  promptType: string,
  value: unknown,
  source: 'terminal' | 'websocket',
}
```

### GUI Current State

**Models** (`tim-gui/TimGUI/SessionModels.swift`):
- `PromptRequestPayload` (line 572): Already decodes `requestId`, `promptType`, `promptConfig`, `timeoutMs`.
- `PromptConfigPayload` (line 520): Decodes `message`, `defaultValue`, `choices`, `pageSize`, `validationHint`. **Missing**: `command` field needed for `prefix_select`.
- `PromptChoiceConfigPayload` (line 485): Decodes `name`, `value`, `description`, `checked` with value coercion.
- `PromptAnsweredPayload` (line 580): Decodes `requestId`, `promptType`, `source`, `value`.
- `OutgoingMessage` (line 20): Only has `.userInput(content:)`. **Needs** `.promptResponse(requestId:, value:)`.

**Message Formatting** (`SessionModels.swift:1254`):
- `prompt_request` currently formats as a text-only progress message: `"Prompt (type): message"`.
- `prompt_answered` currently formats as a text-only log message.

**State Management** (`tim-gui/TimGUI/SessionState.swift`):
- `SessionItem` (line 138): Has `messages`, `isActive`, `connectionId`, etc. **No field for pending prompts**.
- `SessionState.sendUserInput()` (line 231): Sends `.userInput` OutgoingMessage. A similar `sendPromptResponse()` method is needed.
- `sendMessageHandler` closure (line 24): Takes `(UUID, OutgoingMessage)`. This already supports extensibility.

**Views** (`tim-gui/TimGUI/SessionsView.swift`):
- `SessionDetailView` (line ~240): Shows message list + `MessageInputBar` when session is active.
- `MessageInputBar` (line 375): Text input for free-form messages. This remains as-is; prompt UI is separate.
- `SessionMessageView` (line 462): Renders messages by category/body type.

**App Wiring** (`tim-gui/TimGUI/TimGUIApp.swift`):
- WebSocket handler (line 35) dispatches events to `SessionState`.
- The `.output` case at line 39 processes structured messages and calls `appendMessage`.
- This is where `prompt_request` events would need to additionally trigger `setActivePrompt` on the session.

### Key Files to Modify

1. **`tim-gui/TimGUI/SessionModels.swift`**: Add `command` to `PromptConfigPayload`, add `promptResponse` to `OutgoingMessage`, add a `PromptResponseValue` type for encoding heterogeneous values.
2. **`tim-gui/TimGUI/SessionState.swift`**: Add `pendingPrompt` tracking to `SessionItem`, add `setActivePrompt()`, `clearActivePrompt()`, `sendPromptResponse()` methods.
3. **`tim-gui/TimGUI/PromptViews.swift`** (new): Prompt UI components for each type and the container view.
4. **`tim-gui/TimGUI/SessionsView.swift`**: Integrate `PromptContainerView` into `SessionDetailView`.
5. **`tim-gui/TimGUI/TimGUIApp.swift`**: Update the wsHandler to detect `prompt_request` and `prompt_answered` structured messages and route them to `SessionState`.
6. **`tim-gui/TimGUITests/`**: Tests for encoding, state management, and prompt lifecycle.

### Existing Utilities and Patterns

- **`RawJSONString`** (SessionModels.swift:619): Decodes any JSON value to string. Useful pattern for the value coercion approach.
- **`AnyJSON`** (SessionModels.swift:591): Decodes any JSON value to `Any`. May be useful for encoding prompt response values.
- **`MessageFormatter.format()`** (SessionModels.swift:1100+): Static method that converts `TunnelMessage` to `SessionMessage`. The `prompt_request` case here should still create a message for the log, but the app wiring should also set the active prompt.
- **`OutgoingMessage.encode()`**: Uses manual `CodingKeys` encoding. The new `.promptResponse` case needs to serialize `value` as the correct JSON type.

## Implementation Guide

### Step 1: Add `command` Field to `PromptConfigPayload`

**File**: `tim-gui/TimGUI/SessionModels.swift`

Add a `command: String?` property to `PromptConfigPayload`. Add it to `CodingKeys`, the memberwise `init`, and the custom `init(from decoder:)`. This field is used by `prefix_select` prompts to pass the bash command that the user can choose a prefix of.

**Why**: Without this, the `prefix_select` prompt type cannot function — the command text is essential data.

### Step 2: Add `promptResponse` Case to `OutgoingMessage` and Value Encoding

**File**: `tim-gui/TimGUI/SessionModels.swift`

Add a new case to `OutgoingMessage`:
```swift
case promptResponse(requestId: String, value: PromptResponseValue)
```

Create a `PromptResponseValue` enum that can represent the different value types:
- `.bool(Bool)` — for confirm prompts
- `.string(String)` — for input and select prompts
- `.number(Double)` or `.int(Int)` — for select prompts with numeric values
- `.array([PromptResponseValue])` — for checkbox prompts
- `.object([String: PromptResponseValue])` — for prefix_select `{exact, command}`

The `encode(to:)` method must serialize this as:
```json
{ "type": "prompt_response", "requestId": "...", "value": <json value> }
```

The `value` field must be encoded with the correct JSON type — not as a stringified version. The backend does `pending.resolve(message.value)` directly, so the value must match what the prompt function expects.

**Alternative simpler approach**: Since Swift's `JSONSerialization` handles `Any`, you could use a simpler encoding approach where you build the JSON dictionary manually and serialize it, rather than using `Codable`.

**Why**: The backend's `HeadlessAdapter.handleServerMessage()` resolves the pending promise with `message.value` directly. Type correctness is critical.

### Step 3: Add Prompt State Tracking to `SessionState`

**File**: `tim-gui/TimGUI/SessionState.swift` and `tim-gui/TimGUI/SessionModels.swift`

Add a `pendingPrompt: PromptRequestPayload?` property to `SessionItem`.

Add methods to `SessionState`:
- `setActivePrompt(connectionId: UUID, prompt: PromptRequestPayload)` — sets the pending prompt on the matching session.
- `clearActivePrompt(connectionId: UUID, requestId: String)` — clears the prompt if requestId matches (prevents stale clears).
- `sendPromptResponse(sessionId: UUID, requestId: String, value: PromptResponseValue) async throws` — sends the `prompt_response` message and clears the active prompt.

Also handle `markDisconnected` to clear any pending prompt.

**Why**: The session needs to track which prompt (if any) is currently waiting for a response, so the UI can render the correct prompt component.

### Step 4: Wire Prompt Events in App Handler

**File**: `tim-gui/TimGUI/TimGUIApp.swift`

In the `wsHandler` `.output` case, after calling `MessageFormatter.format()` and `appendMessage()`, check if the tunnel message is a `prompt_request` or `prompt_answered` structured message. **Only do this for live (non-replay) messages** — during replay, messages are historical and should only appear in the message list, not trigger interactive prompts.

The replay state is already tracked per-connection via `replayingConnections` in `SessionState`. The wiring in `TimGUIApp` should check this before calling prompt state methods. The simplest approach: add a method like `isReplaying(connectionId:)` on `SessionState`, or pass replay state as context. Alternatively, have `setActivePrompt` and `clearActivePrompt` internally check replay state and no-op during replay.

- For `.structured(message: .promptRequest(payload))`: Call `sessionState.setActivePrompt(connectionId:, prompt:)` (skipped during replay).
- For `.structured(message: .promptAnswered(payload))`: Call `sessionState.clearActivePrompt(connectionId:, requestId:)` (skipped during replay).

**Why**: This connects the incoming structured messages to the state management, allowing the UI to react. Skipping during replay prevents stale prompts from appearing after reconnect.

### Step 5: Build Prompt UI Components

**File**: `tim-gui/TimGUI/PromptViews.swift` (new file)

Create SwiftUI views for each prompt type:

1. **`ConfirmPromptView`**: Shows the message text and two buttons (Yes/No). The default option is visually highlighted. Tapping a button calls the response handler with `true` or `false`.

2. **`InputPromptView`**: Shows the message text, an optional validation hint, a text field pre-filled with the default value, and a submit button. Enter key submits.

3. **`SelectPromptView`**: Shows the message text and a list of options as radio-button-style rows. Tapping an option highlights it (does not submit). A separate submit button sends the selected value. The default is pre-selected.

4. **`CheckboxPromptView`**: Shows the message text and a list of toggleable checkbox rows. Pre-checked items come from `checked: true` in the choices. A submit button sends the array of selected values.

5. **`PrefixSelectPromptView`**: Shows the message text and the command as a row of clickable word segments. Clicking a word selects everything up to and including that word (prefix behavior). An "Exact" toggle/button selects the entire command literally. A submit button sends `{exact: Bool, command: String}`.

Create a **`PromptContainerView`** that switches on `promptType` and renders the appropriate component. This container appears above the `MessageInputBar` in `SessionDetailView` when `session.pendingPrompt != nil`.

**Why**: Each prompt type has distinct interaction patterns that warrant separate components, while the container provides a unified integration point.

### Step 6: Integrate Prompt UI into Session Detail View

**File**: `tim-gui/TimGUI/SessionsView.swift`

In `SessionDetailView`, add the `PromptContainerView` between the message scroll view and the `MessageInputBar`. Only show it when `session.pendingPrompt != nil`. The prompt container passes a response callback that calls `sessionState.sendPromptResponse()`.

When the prompt is answered (from any source), the `pendingPrompt` is cleared and the UI returns to showing just the message list and input bar.

**Why**: This places the prompt in a natural position — close to where the user is already looking at messages — without replacing the message input functionality.

### Step 7: Add Tests

**Files**: `tim-gui/TimGUITests/SessionModelTests.swift`, `tim-gui/TimGUITests/SessionStateTests.swift`, `tim-gui/TimGUITests/MessageFormatterTests.swift`

Tests to add:

**Model tests** (SessionModelTests.swift):
- `PromptConfigPayload` decodes the `command` field for prefix_select.
- `OutgoingMessage.promptResponse` encodes correctly for each value type (bool, string, number, array, object).
- Verify JSON output matches backend expectations exactly.

**State tests** (SessionStateTests.swift):
- `setActivePrompt` sets the prompt on the correct session.
- `clearActivePrompt` clears the prompt only when requestId matches.
- `sendPromptResponse` sends the correct OutgoingMessage and clears the prompt.
- Prompt is cleared on session disconnect.
- `prompt_answered` from terminal source clears the prompt without sending a response.

**Formatter tests** (MessageFormatterTests.swift):
- Verify prompt_request still generates a log message (visual record in the message list).

### Manual Testing Steps

1. Run `tim agent` with headless mode enabled and the GUI connected.
2. Trigger each prompt type (permissions flow triggers confirm/prefix_select; other commands trigger select/input).
3. Verify the prompt appears in the GUI with correct message and choices.
4. Respond via the GUI and confirm the agent continues.
5. Respond via the terminal instead and confirm the GUI prompt disappears.
6. Test rapid succession: answer one prompt, verify the next one appears correctly.
7. Test session disconnect while a prompt is active — prompt should clear.

## Current Progress
### Current State
- All 11 tasks are complete. The plan is fully implemented.
### Completed (So Far)
- Task 1: Added `command: String?` to `PromptConfigPayload`, created `PromptResponseValue` enum with `.bool`, `.string`, `.int`, `.double`, `.array`, `.object` cases implementing `Encodable`, added `.promptResponse` case to `OutgoingMessage`.
- Task 2: Added `pendingPrompt: PromptRequestPayload?` to `SessionItem`. Added `setActivePrompt`, `clearActivePrompt`, `sendPromptResponse` methods to `SessionState` with replay safety guards. Updated `markDisconnected` to clear pending prompts.
- Task 3: Wired `.promptRequest` and `.promptAnswered` structured message handling in `TimGUIApp.swift` wsHandler, delegating to SessionState methods which handle replay safety internally.
- Task 4: Created `PromptViews.swift` with `ConfirmPromptView`, `InputPromptView`, `SelectPromptView`, `CheckboxPromptView`, and `PromptContainerView`. Each view handles its prompt type with appropriate controls and sends the correct `PromptResponseValue` type.
- Task 5: Added `PrefixSelectPromptView` with word-chip UI using custom `FlowLayout` for wrapping. Prefix selection highlights all words up to clicked word. Exact toggle selects full command. Sends `.object(["exact": .bool, "command": .string])`. Handles nil command edge case with error message.
- Task 6: Integrated `PromptContainerView` into `SessionDetailView` between message scroll and `MessageInputBar`. Shows only when `pendingPrompt != nil` and session is active. Uses `.ultraThinMaterial` background with divider separator.
- Task 7: Replaced `String?` with `PromptResponseValue?` in `PromptChoiceConfigPayload.value` and `PromptConfigPayload.defaultValue`. Custom decoders now preserve original JSON types (Bool first, then Int, Double, String). Removed `choiceValueToResponseValue` heuristic helper. `PromptResponseValue` now conforms to `Equatable`.
- Task 8: Guarded `sendPromptResponse` clearing by requestId match after await (`if session.pendingPrompt?.requestId == requestId`), preventing race where a new prompt arriving during network send gets wiped.
- Task 9: Fully addressed by Task 7 — boolean values now stored as `.bool(true/false)` from decode, no string coercion.
- Task 10: Replaced `try?` in SessionDetailView with proper async throwing callback. `PromptContainerView` now manages error state with `handleResponse()` method, inline error display, and auto-clear after 3 seconds (same pattern as `MessageInputBar`).
- Task 11: Added `isSending` state to `PromptContainerView` with guard in `handleResponse()`. All prompt sub-views now accept `isSending: Bool` parameter and disable their submit/action buttons during send.
- Tests: Full coverage in SessionModelTests, SessionStateTests (including replay safety, race condition regression), and MessageFormatterTests.
### Remaining
- None
### Next Iteration Guidance
- None — all tasks complete
### Decisions / Changes
- `PromptResponseValue` uses `singleValueContainer()` encoding to produce raw JSON types (not wrapped). This is critical for backend compatibility.
- Replay safety is handled inside `SessionState` methods (not at the call site in TimGUIApp), keeping the wiring clean.
- Choice values are now stored as typed `PromptResponseValue` from decode time, eliminating the lossy string coercion + heuristic reversal pattern.
- `FlowLayout` (custom SwiftUI Layout) used for prefix_select word chips to handle wrapping within available width.
- `sendPromptResponse` only clears pendingPrompt if the requestId still matches, preventing the async race condition.
- Error handling and double-submission protection centralized in `PromptContainerView.handleResponse()` rather than in each sub-view. Sub-views receive `isSending: Bool` to disable their controls.
### Lessons Learned
- When decoding heterogeneous JSON values in Swift, always try Bool before numeric types — Swift's `Decoder` will happily decode JSON `true`/`false` as `1`/`0` integers.
- Store typed values at the boundary rather than coercing to strings and trying to reverse-engineer the original type later. The round-trip is inherently lossy.
- Centralizing async lifecycle (isSending, error handling) in a container view and passing down a simple `isSending: Bool` to sub-views is cleaner than having each sub-view manage its own async state.
### Risks / Blockers
- The `rsv2BitRejection` WebSocket test is flaky (passes alone, fails in suite). Pre-existing, unrelated to this work.
