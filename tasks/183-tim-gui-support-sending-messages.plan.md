---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "tim-gui: support sending messages"
goal: ""
id: 183
uuid: 9c58c35e-6447-4ce3-af6b-3510719dc560
generatedBy: agent
status: pending
priority: medium
planGeneratedAt: 2026-02-18T08:42:05.561Z
promptsGeneratedAt: 2026-02-18T08:42:05.561Z
createdAt: 2026-02-13T06:50:44.946Z
updatedAt: 2026-02-18T08:42:05.562Z
tasks:
  - title: Extend headless protocol with user_input message type
    done: false
    description: Add HeadlessUserInputServerMessage type to
      src/logging/headless_protocol.ts. Add it to the HeadlessServerMessage
      union. Update isValidHeadlessServerMessage() in
      src/logging/headless_adapter.ts to validate user_input messages (type ===
      user_input, content is string).
  - title: Add user input handler to HeadlessAdapter
    done: false
    description: In src/logging/headless_adapter.ts, add a
      setUserInputHandler(handler?) method and private userInputHandler field,
      mirroring TunnelAdapter.setUserInputHandler(). Update
      handleServerMessage() to dispatch user_input messages to the handler. Add
      tests for the handler lifecycle (set, call, clear) and validation in
      src/logging/headless_adapter.test.ts.
  - title: Wire headless user input forwarding in executor
    done: false
    description: "In src/tim/executors/claude_code/terminal_input_lifecycle.ts
      executeWithTerminalInput(), add headless adapter user input wiring after
      the existing tunnel handler block. Check if loggerAdapter is
      HeadlessAdapter, call setUserInputHandler() with a handler that: checks
      stdinGuard.isClosed, calls sendFollowUpMessage() to forward to Claude Code
      stdin, calls tunnelServer?.sendUserInput() to broadcast, and sends a
      user_terminal_input structured message. Add cleanup to clear the handler.
      Add tests."
  - title: Add sendMessage method to LocalHTTPServer
    done: false
    description: "In tim-gui/TimGUI/LocalHTTPServer.swift, add a public
      sendMessage(to connectionId: UUID, text: String) async throws method that
      looks up the WebSocket connection by connectionId and calls sendText().
      Add a test that verifies the message is sent through the WebSocket
      connection."
  - title: Define OutgoingMessage enum and wire send closure in SessionState
    done: false
    description: "Create an OutgoingMessage enum (Encodable) with a
      .userInput(content: String) case that encodes to {type: user_input,
      content: ...}. Add a sendMessageHandler closure property to SessionState.
      Add sendUserInput(sessionId:content:) method that validates session is
      active, calls the closure, and adds a local SessionMessage to the messages
      array. Wire the closure in TimGUIApp.swift startServerIfNeeded() after
      server creation, using server.sendMessage(). Add a .userInput case to
      MessageCategory with a distinct display color."
  - title: Build message input UI in SessionDetailView
    done: false
    description: "In tim-gui/TimGUI/SessionsView.swift, modify SessionDetailView to
      add a multiline text input bar below the scroll view. Wrap the existing
      ScrollViewReader in a VStack. Add sessionState as a parameter. The input
      bar: contains a TextEditor with placeholder, a send button
      (arrow.up.circle.fill), styled with .ultraThinMaterial. Only shown when
      session.isActive. Enter sends, Shift+Enter inserts newline (via
      .onKeyPress(.return) checking modifiers). Auto-grows up to ~5 lines.
      Adjust scroll-to-bottom button padding to sit above the input bar. Update
      SessionsView call site to pass sessionState."
  - title: Add Swift-side tests for send flow and UI state
    done: false
    description: "Add tests for: OutgoingMessage JSON encoding,
      SessionState.sendUserInput() creating correct local message and calling
      handler, text input visibility tied to session.isActive,
      LocalHTTPServer.sendMessage() integration. Update existing WebSocket tests
      if needed."
  - title: Add TypeScript tests for end-to-end user input flow
    done: false
    description: "Add tests for: isValidHeadlessServerMessage() accepting
      user_input, HeadlessAdapter dispatching to userInputHandler,
      executeWithTerminalInput() wiring for headless adapter. Verify that user
      input from headless adapter is forwarded to subprocess stdin and tunnel
      server."
tags: []
---

Support sending messages to a session from inside tim-gui via a text box at the bottom.

## Expected Behavior/Outcome

When viewing an active session in tim-gui, users can type messages in a text field at the bottom of the session detail view and send them to the running agent. The message is transmitted over the existing WebSocket connection back to the backend tim process, which forwards it to the Claude Code subprocess's stdin.

### States:
- **Active session**: Text input field is visible and enabled. User can type and send free-form messages (multiline via Shift+Enter, Enter to send) that get forwarded to the agent as follow-up input. Sent messages appear as local echo in the message list.
- **Inactive/disconnected session**: Text input field is hidden entirely (no disabled state).
- **No session selected**: No text field is shown.

## Key Findings

### Product & User Story
As a developer monitoring agent sessions in tim-gui, I want to send messages and respond to prompts directly from the GUI instead of switching to a terminal window, so I can interact with the agent without context-switching.

### Design & UX Approach
- A multiline text input field (TextEditor) pinned to the bottom of `SessionDetailView`, below the scroll view containing messages
- Enter to send, Shift+Enter for newlines
- The text field should be visually consistent with the existing material backgrounds used in the app (`.thinMaterial` or `.ultraThinMaterial`)
- The scroll-to-bottom overlay button should appear above the text input area, not behind it
- Text input field is completely hidden when the session is disconnected (no disabled state)
- Sent messages appear in the message list with a distinct "user input" visual style for local echo
- **Scope**: This plan covers free-form text input only. Structured prompt UI (select menus, confirm buttons, checkbox lists) will be a separate follow-up plan.

### Technical Plan & Risks
- **WebSocket is currently unidirectional** (server→GUI only). The primary work is extending the headless protocol to support GUI→server messages for both prompt responses and free-form user input.
- **HeadlessServerMessage** currently only supports `prompt_response`. We need to add a `user_input` message type so the GUI can send arbitrary text that gets forwarded to the subprocess's stdin.
- **The GUI's `WebSocketConnection`** already has a `sendText()` method, and `LocalHTTPServer` stores connections by connectionId. We need to expose a way to send messages back through the correct connection.
- **Risk**: Race condition between terminal input and GUI input. Both the terminal and GUI could try to send input simultaneously. The existing architecture already handles this for prompt responses (race pattern in `input.ts`), but for free-form messages, the backend must handle concurrent writes to subprocess stdin safely.

### Pragmatic Effort Estimate
This is a medium-sized feature touching both the Swift GUI and the TypeScript backend, with ~5-7 files modified on each side. The protocol extension is the most architecturally significant piece, but the existing `prompt_response` pattern provides a clear template to follow.

## Acceptance Criteria
- [ ] User can type a message in the multiline text input field at the bottom of SessionDetailView
- [ ] Enter sends the message; Shift+Enter inserts a newline
- [ ] The sent message appears in the session's message list as a user message with distinct styling
- [ ] Messages are only sendable when the session is active (connected)
- [ ] Text field is hidden entirely for disconnected sessions
- [ ] The headless WebSocket protocol supports `user_input` messages from GUI→server
- [ ] The backend correctly forwards GUI-originated messages to the Claude Code subprocess stdin
- [ ] The send mechanism uses a structured closure that can be extended for prompt responses in a future plan
- [ ] All new code paths are covered by tests

## Dependencies & Constraints
- **Dependencies**: Existing WebSocket infrastructure (`LocalHTTPServer`, `WebSocketConnection`, `HeadlessAdapter`), existing prompt handling system (`input.ts`, `headless_protocol.ts`)
- **Technical Constraints**: Messages must be properly serialized as stream-json format for Claude Code's stdin. The WebSocket protocol must remain backward-compatible (old GUI versions should not break against new backends).

## Implementation Notes

### Recommended Approach
Extend the existing headless protocol with a new `user_input` message type sent from GUI to backend, mirroring the existing `prompt_response` pattern. On the backend, the `HeadlessAdapter` processes incoming `user_input` messages and forwards them to the subprocess stdin via the existing `sendFollowUpMessage()` function.

### Potential Gotchas
- **stdin lifecycle**: The subprocess stdin may already be closed by the time a GUI message arrives. Must check `stdinGuard.isClosed` before attempting to write.
- **Message framing**: WebSocket messages from client→server are masked per RFC 6455. The existing `WebSocketConnection.readLoop()` already handles unmasking, so received messages are in cleartext. But we need to validate the JSON structure of incoming messages.
- **Prompt response race**: When a prompt is answered from the GUI, the terminal prompt (if one is also showing) must be cancelled. The existing `raceWithWebSocket` pattern in `input.ts` already handles this correctly - the GUI's `prompt_response` resolves the pending promise, which aborts the terminal inquirer prompt.
- **Focus management**: The text field and the scroll view both want keyboard focus. Need to coordinate so that the text field gets focus for typing while the scroll view still responds to Home/End keys.

## Research

### Architecture Overview

The tim-gui is a native macOS SwiftUI application that connects to tim processes via WebSocket on `ws://localhost:8123/tim-agent`. The communication is currently **unidirectional**: the backend pushes structured messages to the GUI, but the GUI cannot send messages back (except that the WebSocket connection from the backend side supports receiving `prompt_response` messages from the server).

The key insight is that the **direction of the WebSocket is flipped from typical usage**: the GUI app acts as a WebSocket **server** (via `LocalHTTPServer`), and the backend tim process acts as the WebSocket **client** (via `HeadlessAdapter`). So:
- Backend → GUI: `HeadlessAdapter.send()` → `WebSocket` → `LocalHTTPServer` → `SessionState`
- GUI → Backend: `LocalHTTPServer.sendText()` → `WebSocket` → `HeadlessAdapter.onmessage` → ?

### Critical Files and Their Roles

#### Swift/GUI Side

1. **`tim-gui/TimGUI/LocalHTTPServer.swift`**
   - Manages the HTTP/WebSocket server on port 8123
   - Stores WebSocket connections in `wsConnections: [UUID: WebSocketConnection]` (private)
   - `handleWebSocketMessage()` decodes incoming `HeadlessMessage` from backend
   - **Needs**: Public method to send messages back through a connection by connectionId

2. **`tim-gui/TimGUI/WebSocketConnection.swift`**
   - RFC 6455 WebSocket implementation
   - Already has `sendText(_ text: String)` for sending server→client frames (unmasked, as servers don't mask)
   - `readLoop()` reads client→server frames (masked, per RFC)
   - **Already capable** of bidirectional communication at the transport level

3. **`tim-gui/TimGUI/SessionsView.swift`**
   - `SessionDetailView`: Main message display area with `ScrollView` + `LazyVStack`
   - Has scroll-to-bottom button as `.overlay(alignment: .bottomTrailing)`
   - Bottom padding of 20pt in LazyVStack
   - **Needs**: Text input field below the scroll view, send button

4. **`tim-gui/TimGUI/SessionModels.swift`**
   - `SessionItem`: Observable model with `connectionId`, `isActive`, `messages`
   - `SessionMessage`: Identifiable message with category enum
   - `MessageFormatter`: Converts `TunnelMessage` to `SessionMessage`
   - **Needs**: A way to create user-sent messages for display

5. **`tim-gui/TimGUI/SessionState.swift`**
   - Manages all sessions, selected session, message buffering
   - Has access to sessions by `connectionId`
   - **Needs**: Method to send a message through a session's WebSocket connection

#### TypeScript/Backend Side

6. **`src/logging/headless_protocol.ts`**
   - Defines `HeadlessMessage` (backend→GUI) and `HeadlessServerMessage` (GUI→backend)
   - `HeadlessServerMessage` currently only has `prompt_response` type
   - **Needs**: New `user_input` message type in `HeadlessServerMessage`

7. **`src/logging/headless_adapter.ts`**
   - WebSocket client that connects to the GUI server
   - `handleServerMessage()` processes incoming `HeadlessServerMessage`
   - Currently only handles `prompt_response`
   - `isValidHeadlessServerMessage()` validates incoming messages
   - **Needs**: Handle new `user_input` message type, forward to subprocess stdin

8. **`src/tim/executors/claude_code/streaming_input.ts`**
   - `sendFollowUpMessage(stdin, content)`: Writes a user message to subprocess stdin
   - `buildSingleUserInputMessageLine(content)`: Formats content as stream-json
   - **Already provides** the function needed to forward GUI messages to Claude Code

9. **`src/tim/executors/claude_code/terminal_input_lifecycle.ts`**
   - `executeWithTerminalInput()`: Main function that wires up terminal input handling
   - `stdinGuard`: Shared guard preventing double-close of stdin
   - Tunnel handler pattern: `loggerAdapter.setUserInputHandler()` for forwarding tunnel input
   - **Needs**: Similar handler wiring for headless adapter user input

10. **`src/common/input.ts`**
    - `raceWithWebSocket()`: Pattern for racing terminal prompt against WebSocket response
    - `getHeadlessAdapter()`: Gets the HeadlessAdapter from logger context
    - Already handles `prompt_response` from GUI, which means prompt answering from GUI should work once the GUI can send those messages

### Existing Patterns to Follow

#### Prompt Response Flow (already working on backend)
The backend already supports receiving `prompt_response` from the GUI via `HeadlessAdapter`:
1. Backend sends `prompt_request` structured message to GUI
2. `input.ts:raceWithWebSocket()` starts waiting for both terminal input AND websocket response
3. `HeadlessAdapter.waitForPromptResponse(requestId)` creates a pending promise
4. When GUI sends back `{ type: 'prompt_response', requestId, value }`, the promise resolves
5. Terminal prompt is aborted (or vice versa if terminal answers first)

The `user_input` message handling should follow a similar pattern but simpler - no request/response correlation needed.

#### Tunnel User Input Flow (existing pattern)
The tunnel system already has a `user_input` message type (`TunnelUserInputMessage` in `tunnel_protocol.ts`):
```typescript
export interface TunnelUserInputMessage {
  type: 'user_input';
  content: string;
}
```
And `TunnelAdapter.setUserInputHandler()` for receiving forwarded input. This is the exact pattern to replicate for the headless WebSocket.

### Message Flow for Sending User Input

The complete flow for a user typing a message in the GUI:

1. **GUI**: User types in text field and presses Enter
2. **GUI**: `SessionDetailView` calls a send method on `SessionState` or `LocalHTTPServer`
3. **GUI**: `LocalHTTPServer.sendToConnection(connectionId, message)` sends JSON via WebSocket
4. **Backend**: `HeadlessAdapter.onmessage` receives the frame
5. **Backend**: `isValidHeadlessServerMessage()` validates it as `user_input` type
6. **Backend**: `handleServerMessage()` dispatches to a registered callback
7. **Backend**: Callback calls `sendFollowUpMessage(stdin, content)` to forward to Claude Code
8. **Backend**: Callback also calls `tunnelServer.sendUserInput(content)` to broadcast to tunnel clients
9. **Backend**: Callback also sends a `user_terminal_input` structured message for logging

### WebSocket Connection Direction Clarification

Important: In this architecture, the WebSocket roles are reversed from typical web apps:
- **Tim-GUI** is the WebSocket **server** (listens on port 8123)
- **Tim backend** (HeadlessAdapter) is the WebSocket **client** (connects to GUI)

When the GUI wants to send a message to the backend:
- The GUI calls `WebSocketConnection.sendText()` which sends an **unmasked** server→client frame
- The backend's `HeadlessAdapter` receives this via `socket.onmessage`
- This is already working for the existing message flow (though currently only backend→GUI output uses it)

When the backend receives messages from the GUI:
- `HeadlessAdapter.socket.onmessage` fires with the text data
- It parses JSON and validates via `isValidHeadlessServerMessage()`
- Currently only `prompt_response` is recognized

## Implementation Guide

### Step 1: Extend the Headless Protocol (TypeScript)

**File**: `src/logging/headless_protocol.ts`

Add a new `HeadlessUserInputServerMessage` type to the protocol:

```typescript
export interface HeadlessUserInputServerMessage {
  type: 'user_input';
  content: string;
}
```

Add it to the `HeadlessServerMessage` union type:

```typescript
export type HeadlessServerMessage =
  | HeadlessPromptResponseServerMessage
  | HeadlessUserInputServerMessage;
```

### Step 2: Handle User Input in HeadlessAdapter (TypeScript)

**File**: `src/logging/headless_adapter.ts`

1. Update `isValidHeadlessServerMessage()` to accept `user_input` messages:
   ```typescript
   case 'user_input':
     return typeof msg.content === 'string';
   ```

2. Add a user input callback mechanism to `HeadlessAdapter`, similar to `TunnelAdapter.setUserInputHandler()`:
   - Add a `private userInputHandler?: (content: string) => void` field
   - Add `setUserInputHandler(handler?: (content: string) => void)` method
   - In `handleServerMessage()`, add a case for `user_input` that calls the handler

3. Update `handleServerMessage()`:
   ```typescript
   case 'user_input': {
     const handler = this.userInputHandler;
     if (handler) {
       handler(message.content);
     }
     break;
   }
   ```

### Step 3: Wire Up User Input Forwarding in Executor (TypeScript)

**File**: `src/tim/executors/claude_code/terminal_input_lifecycle.ts`

In `executeWithTerminalInput()`, after the existing tunnel handler wiring, add similar wiring for the headless adapter:

1. Import `HeadlessAdapter` and `getLoggerAdapter`
2. Check if the logger adapter is a `HeadlessAdapter`
3. Call `headlessAdapter.setUserInputHandler()` with a handler that:
   - Checks `stdinGuard.isClosed` before writing
   - Calls `sendFollowUpMessage(streaming.stdin, content)` to forward to Claude Code
   - Calls `tunnelServer?.sendUserInput(content)` to broadcast to tunnel clients
   - Sends a `user_terminal_input` structured message for logging/display
4. Add cleanup to clear the handler

This follows the same pattern as the existing tunnel user input handler wiring already present in the function.

### Step 4: Add Send Method to LocalHTTPServer (Swift)

**File**: `tim-gui/TimGUI/LocalHTTPServer.swift`

Add a public method that sends a text message back through a specific WebSocket connection:

```swift
func sendMessage(to connectionId: UUID, text: String) async throws {
    self.connectionsLock.lock()
    let connection = self.wsConnections[connectionId]
    self.connectionsLock.unlock()
    guard let connection else { return }
    try await connection.sendText(text)
}
```

### Step 5: Add Send Capability to SessionState/App Layer (Swift)

Provide a way for the UI layer to send messages. This requires:

1. **Define a structured message enum** for messages the GUI can send to the backend. This should be extensible so that future plans can add `promptResponse`, `confirm`, `select`, etc. For now, only `userInput(content: String)` is needed. The enum should encode to the correct JSON format.

2. **Give `SessionState` a send closure** typed as `(UUID, OutgoingMessage) async throws -> Void` (where `OutgoingMessage` is the enum from above). This keeps `SessionState` decoupled from `LocalHTTPServer`.

3. Add a `sendUserInput(sessionId: UUID, content: String)` method to `SessionState` that:
   - Looks up the session by `sessionId` to get its `connectionId`
   - Validates the session is active
   - Calls the send closure with `OutgoingMessage.userInput(content: content)`
   - Adds a local `SessionMessage` to the session's messages array so the user sees their own sent message in the log

4. Wire the closure in `TimGUIApp.swift:startServerIfNeeded()`, right after `self.server = newServer`. The closure captures the server reference, serializes the `OutgoingMessage` to JSON, and calls `server.sendMessage(to:text:)`. Set the closure on `sessionState` (e.g., `sessionState.sendMessageHandler = { ... }`).

### Step 6: Build the Message Input UI (Swift)

**File**: `tim-gui/TimGUI/SessionsView.swift`

Modify `SessionDetailView` to add a text input field at the bottom. Only show the input bar when `session.isActive` is true — hide it entirely for disconnected sessions.

1. Restructure the layout from just a `ScrollViewReader` to a `VStack` containing:
   - The existing `ScrollViewReader` (taking available space)
   - A text input bar at the bottom (conditionally shown when `session.isActive`)

2. The input bar should contain:
   - A `TextEditor` for multiline input with placeholder text
   - A send button (arrow up icon, e.g. `"arrow.up.circle.fill"`)
   - Styled with `.ultraThinMaterial` background
   - The TextEditor should grow vertically with content up to a reasonable max height (e.g., 5 lines)

3. State management:
   - `@State private var inputText: String = ""`
   - Send action calls `sessionState.sendUserInput()`
   - Clear text field after sending
   - `SessionDetailView` needs `@Bindable var sessionState: SessionState` added as a parameter (currently only has `let session: SessionItem`). This requires updating the call site in `SessionsView` to pass it through.

4. Keyboard handling:
   - Enter to send the message
   - Shift+Enter to insert a newline
   - This requires intercepting the key event on the TextEditor (`.onKeyPress(.return)` modifier checking for shift)

5. The scroll-to-bottom button overlay should have its bottom padding adjusted to sit above the input bar.

6. Focus management: The text field should be focusable separately from the scroll view. Consider whether clicking in the scroll area should return focus to the text field.

### Step 7: Display Sent Messages in the Message List (Swift)

When the user sends a message via `SessionState.sendUserInput()`, add a `SessionMessage` to the session's `messages` array with a distinct visual style:

- Add a new `MessageCategory` case (e.g., `.userInput`) so sent messages are visually distinguishable from agent output
- The title should be something like "You" or "User input"
- The body is `.text(content)` with the sent text
- Color: consider a distinct color like `.orange` or `.purple` to stand out from the green/cyan/blue agent messages

### Step 8: Add Tests

**TypeScript tests:**
- Test `isValidHeadlessServerMessage()` accepts `user_input` messages
- Test `HeadlessAdapter.handleServerMessage()` calls the user input handler
- Test `HeadlessAdapter.setUserInputHandler()` lifecycle (set, call, clear)
- Test the integration of user input forwarding in `executeWithTerminalInput()`

**Swift tests:**
- Test `LocalHTTPServer.sendMessage()` sends text through WebSocket
- Test `SessionState.sendUserInput()` constructs correct JSON and adds local message
- Test that the text input field is hidden when session is not active

### Manual Testing Steps

1. Start tim-gui and a `tim agent` or `tim chat` session
2. Verify the text input appears at the bottom when viewing the active session
3. Type a message and press Enter
4. Verify the message appears in the session log with user styling
5. Verify the agent receives and responds to the message
6. Test Shift+Enter inserts a newline instead of sending
7. Disconnect the session and verify the text input field disappears
