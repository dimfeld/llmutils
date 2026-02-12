---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "tim-gui: list sessions as they become known"
goal: Add WebSocket server support to tim-gui so it can receive and display
  real-time session output from tim headless processes, with a two-pane session
  list and detail view alongside the existing notifications view.
id: 169
uuid: 85aa17d2-7d55-4d91-afbb-09821893a59a
generatedBy: agent
status: in_progress
priority: medium
parent: 160
references:
  "160": 514cedb9-6431-400a-a997-12d139376146
planGeneratedAt: 2026-02-10T08:16:34.734Z
promptsGeneratedAt: 2026-02-10T08:16:34.734Z
createdAt: 2026-02-10T03:29:43.262Z
updatedAt: 2026-02-12T01:08:23.910Z
tasks:
  - title: Define session data models and headless protocol types
    done: true
    description: >-
      Create tim-gui/TimGUI/SessionModels.swift with Swift Codable types
      matching the TypeScript headless protocol:


      1. HeadlessMessage: discriminated union (session_info, output,
      replay_start, replay_end) matching src/logging/headless_protocol.ts

      2. TunnelMessage: discriminated union (log/error/warn/debug with args,
      stdout/stderr with data, structured with StructuredMessage) matching
      src/logging/tunnel_protocol.ts

      3. StructuredMessage: all ~30 types from
      src/logging/structured_messages.ts (agent_session_start/end,
      agent_iteration_start, agent_step_start/end, llm_thinking, llm_response,
      llm_tool_use, llm_tool_result, llm_status, todo_update, file_write,
      file_edit, file_change_summary, command_exec, command_result,
      review_start, review_result, review_verdict, workflow_progress,
      failure_report, task_completion, execution_summary, token_usage,
      input_required, plan_discovery, workspace_info)

      4. SessionItem: Identifiable struct with id, connectionId, command,
      planId, planTitle, workspacePath, connectedAt, isActive, messages

      5. SessionMessage: Identifiable struct with id, seq, text, category
      (MessageCategory enum), timestamp

      6. MessageCategory: enum (lifecycle, llmOutput, toolUse, fileChange,
      command, progress, error, log)


      Use custom init(from:) decoders for the discriminated unions that read the
      'type' field first. All types should be Sendable.
  - title: Implement WebSocket frame parsing and upgrade handshake
    done: true
    description: >-
      Add WebSocket server support to the existing NWListener-based TCP server.
      Create a WebSocketConnection class (can be in a new file like
      tim-gui/TimGUI/WebSocketConnection.swift) that handles:


      1. WebSocket upgrade detection: After parsing HTTP request headers, check
      for GET method, /tim-agent path, Upgrade: websocket header, and
      Sec-WebSocket-Key header

      2. Handshake response: Compute accept key using CryptoKit (SHA-1 of key +
      RFC 6455 GUID '258EAFA5-E914-47DA-95CA-5AB5F7FC6835', base64 encoded).
      Send 101 Switching Protocols response with proper headers.

      3. Frame reading: Parse WebSocket frames from the NWConnection - read
      opcode, mask bit, payload length (7-bit, 16-bit, or 64-bit extended),
      4-byte masking key, and payload. Unmask client frames by XOR with mask[i %
      4].

      4. Frame sending: Send unmasked server frames (text, pong, close) with
      proper framing.

      5. Handle opcodes: text (0x1) for messages, close (0x8) with close frame
      response, ping (0x9) with pong response, pong (0xA) ignore.

      6. Frame fragmentation: Buffer continuation frames (FIN=0) until a FIN=1
      frame completes the message.

      7. Connection lifecycle: Track connection state, fire disconnect callback
      when connection drops or close frame is received.


      The class should accept an NWConnection (already established after HTTP
      headers were read), a handler closure for received text messages, and a
      disconnect closure. Use async/await with the existing receiveChunk pattern
      from LocalHTTPServer.
  - title: Upgrade LocalHTTPServer to handle both HTTP and WebSocket
    done: true
    description: >-
      Refactor LocalHTTPServer (tim-gui/TimGUI/LocalHTTPServer.swift) to route
      between HTTP requests and WebSocket upgrades on the same port 8123:


      1. After parsing the HTTP request line and headers (existing code), add a
      routing check:
         - If it's a GET to /tim-agent with Upgrade: websocket header, hand off to WebSocketConnection for upgrade handshake and ongoing communication
         - If it's a POST to /messages, handle as before (existing HTTP notification handler)
         - Otherwise, return 404

      2. Add a new WebSocket handler callback to the server init: a closure that
      receives WebSocket events (sessionInfo, message, disconnected) with a
      connection UUID to identify the session.


      3. Maintain a dictionary of active WebSocket connections keyed by UUID for
      lifecycle management.


      4. When a WebSocket text message is received, decode it as HeadlessMessage
      (from SessionModels) and dispatch to the appropriate handler callback.


      5. Ensure all handler callbacks are @MainActor for thread safety.


      The server should remain a single NWListener on port 8123 that handles
      both protocols transparently.
  - title: Create SessionState manager and message formatter
    done: true
    description: >-
      Create the session state management and message formatting:


      1. SessionState class (in TimGUIApp.swift or a separate file):
         - @MainActor @Observable final class
         - var sessions: [SessionItem] sorted by connectedAt descending (newest first)
         - var selectedSessionId: UUID?
         - addSession(connectionId:, info:) - creates SessionItem from session_info, auto-selects if nothing selected
         - appendMessage(connectionId:, message:) - appends formatted SessionMessage to the matching session
         - markDisconnected(connectionId:) - sets isActive=false on the matching session
         - dismissSession(id:) - removes a closed session from the list
         - var selectedSession: SessionItem? computed property

      2. MessageFormatter (separate utility or extension):
         - Converts HeadlessOutputMessage -> SessionMessage with formatted text and MessageCategory
         - For TunnelMessage.args (log/error/warn/debug): join args, set appropriate category
         - For TunnelMessage.data (stdout/stderr): use data directly
         - For TunnelMessage.structured: format all ~30 StructuredMessage types with basic styled text, following the patterns in src/logging/console_formatter.ts
         - Each message gets a category for SwiftUI styling (colors, fonts)

      No macOS system notifications for sessions - sessions are GUI-only.
  - title: Build the SessionsView two-pane layout
    done: true
    description: >-
      Create tim-gui/TimGUI/SessionsView.swift with the two-pane session
      monitoring view:


      1. SessionsView: NavigationSplitView with sidebar (session list) and
      detail (session content)


      2. Left pane - SessionListView:
         - List bound to sessionState.sessions with selection binding to selectedSessionId
         - SessionRowView for each session showing:
           - Workspace path as primary label (headline font)
           - Plan title or command name as secondary text (subheadline, secondary color)
           - Connection timestamp (caption, secondary color)
           - Status indicator: green circle for active, gray circle for closed
           - Inline 'Dismiss' button (e.g., X button) visible only for closed sessions
         - Empty state: show placeholder when no sessions exist

      3. Right pane - SessionDetailView:
         - ScrollView with LazyVStack showing all session messages
         - SessionMessageView renders each message with styling based on MessageCategory:
           - lifecycle: green/blue bold headers
           - llmOutput: green text
           - toolUse: cyan text
           - fileChange: cyan text
           - command: cyan text
           - progress: blue text
           - error: red text
           - log: default text color
         - Auto-scroll to bottom when new messages arrive (using ScrollViewReader + onChange)
         - Empty state: ContentUnavailableView when no session is selected

         Out of scope: handling 'prompt_request' messages interactively (just show something static for now)

      4. Use monospaced font for message content to preserve formatting of
      diffs, code, etc.
  - title: Add view selector and wire everything together
    done: true
    description: >-
      Integrate all components into the app:


      1. Modify ContentView.swift:
         - Add AppViewMode enum (notifications, sessions) with @State property defaulting to .sessions
         - Add segmented Picker at the top to switch between Notifications and Sessions views
         - Show 'Listening on port 8123' status text in the top bar
         - Extract existing notification list into a NotificationsView subview
         - Accept both appState and sessionState as parameters
         - Show startError if present

      2. Modify TimGUIApp.swift:
         - Add @State private var sessionState = SessionState()
         - Update server creation to pass both httpHandler (for notifications) and wsHandler (for sessions)
         - Pass both state objects to ContentView
         - Wire WebSocket events to sessionState methods:
           - session_info -> addSession
           - output messages -> decode, format via MessageFormatter, appendMessage
           - disconnect -> markDisconnected

      3. Update the ContentView preview to include mock session state


      4. Ensure the window frame is large enough for the two-pane layout
      (increase minWidth if needed)
  - title: "Address Review Feedback: `review_result` and `review_verdict` events are
      intentionally formatted as empty strings and then filtered out in the
      session detail UI, so these protocol messages never appear in the Sessions
      pane."
    done: true
    description: >-
      `review_result` and `review_verdict` events are intentionally formatted as
      empty strings and then filtered out in the session detail UI, so these
      protocol messages never appear in the Sessions pane. That violates the
      plan requirement to show session content/messages as they arrive and to
      format review lifecycle output.


      Suggestion: Render non-empty summaries for
      `review_result`/`review_verdict` (at minimum verdict + issue counts), and
      stop dropping these messages in the detail view.


      Related file: tim-gui/TimGUI/SessionModels.swift:857
  - title: "Address Review Feedback: When readRequest reads the HTTP request from
      the connection, it may consume data beyond the \\r\\n\\r\\n header
      boundary if it arrives in the same TCP segment."
    done: true
    description: >-
      When readRequest reads the HTTP request from the connection, it may
      consume data beyond the \r\n\r\n header boundary if it arrives in the same
      TCP segment. For WebSocket upgrades, contentLength is 0, so the method
      breaks out of the loop and returns — but any extra bytes after the headers
      that were read into the local buffer are discarded. The
      WebSocketConnection then starts its own readLoop() which issues fresh
      receive() calls, potentially missing data that was already consumed. In
      practice this is unlikely because well-behaved WebSocket clients wait for
      the 101 response before sending frames, but it's still a protocol
      correctness gap.


      Suggestion: Pass any leftover bytes from the HTTP read buffer (after the
      \r\n\r\n) to the WebSocketConnection so it can prepend them to its read
      state before starting the readLoop.


      Related file: tim-gui/TimGUI/LocalHTTPServer.swift:113-123
  - title: "Address Review Feedback: `execution_summary` decoding throws away
      summary statistics by hardcoding `totalSteps` and `failedSteps` to `nil`."
    done: true
    description: >-
      `execution_summary` decoding throws away summary statistics by hardcoding
      `totalSteps` and `failedSteps` to `nil`. The formatter only prints these
      fields when non-nil, so required execution summary stats never show in the
      UI.


      Suggestion: Decode `summary.metadata.totalSteps` and
      `summary.metadata.failedSteps` into `ExecutionSummaryPayload` and render
      them in `MessageFormatter`.


      Related file: tim-gui/TimGUI/SessionModels.swift:615
  - title: "Address Review Feedback: The close() method calls onDisconnect()
      synchronously on the calling thread immediately after launching a
      fire-and-forget Task to send the close frame."
    done: true
    description: >-
      The close() method calls onDisconnect() synchronously on the calling
      thread immediately after launching a fire-and-forget Task to send the
      close frame. This means: (1) onDisconnect fires before the close frame is
      actually sent, (2) handleWebSocketDisconnect removes the connection from
      wsConnections immediately while the Task is still trying to send on the
      connection, and (3) if server.stop() is called concurrently, the
      connection may be cancelled mid-send. The onDisconnect callback fires to
      the session state before the graceful close completes.


      Suggestion: Move onDisconnect() inside the Task block, after the close
      frame send completes (or fails) and after connection.cancel(), so the
      disconnect notification happens in the correct order.


      Related file: tim-gui/TimGUI/WebSocketConnection.swift:203-211
  - title: "Address Review Feedback: The new WebSocket tests do not cover the
      highest-risk protocol paths that were explicitly implemented: fragmented
      messages, ping/pong handling, and oversize-frame rejection."
    done: true
    description: >-
      The new WebSocket tests do not cover the highest-risk protocol paths that
      were explicitly implemented: fragmented messages, ping/pong handling, and
      oversize-frame rejection. Current tests mainly validate handshake and
      simple text frames, leaving critical frame-parser behavior unverified.


      Suggestion: Add integration tests for fragmented text reassembly,
      ping->pong responses, close handshake behavior, and oversized
      frame/fragment rejection.


      Related file: tim-gui/TimGUITests/WebSocketTests.swift:142
  - title: "Address Review Feedback: The text 'Listening on port 8123' is
      hard-coded, but LocalHTTPServer supports dynamic port binding (port: 0 in
      tests)."
    done: true
    description: >-
      The text 'Listening on port 8123' is hard-coded, but LocalHTTPServer
      supports dynamic port binding (port: 0 in tests). If the server's port
      configuration were ever changed, this text would be wrong.


      Suggestion: Consider passing the actual bound port to ContentView or
      deriving it from the server state.


      Related file: tim-gui/TimGUI/ContentView.swift:30-31
  - title: "Address Review Feedback: After the listener successfully starts, the
      stateUpdateHandler is set to nil."
    done: true
    description: >-
      After the listener successfully starts, the stateUpdateHandler is set to
      nil. If the NWListener subsequently fails (e.g., the port becomes
      unavailable or the network interface changes), there's no way to detect or
      recover from this. The server will silently stop accepting connections.


      Suggestion: Set a new stateUpdateHandler after startup that logs errors or
      updates the startError state instead of setting it to nil.


      Related file: tim-gui/TimGUI/LocalHTTPServer.swift:90
  - title: "Address Review Feedback: The three DateFormatter/ISO8601DateFormatter
      instances are declared as nonisolated(unsafe) global lets."
    done: true
    description: >-
      The three DateFormatter/ISO8601DateFormatter instances are declared as
      nonisolated(unsafe) global lets. DateFormatter is not thread-safe per
      Apple's documentation. MessageFormatter.format() is currently called from
      @MainActor context, but neither MessageFormatter nor formatTimestamp are
      explicitly @MainActor-isolated. The nonisolated(unsafe) annotation
      explicitly opts out of concurrency safety checks, so future callers could
      invoke these off the main actor and cause data races.


      Suggestion: Either restrict MessageFormatter to @MainActor, use a lock
      around formatter access, or replace DateFormatter with a manual parsing
      approach.


      Related file: tim-gui/TimGUI/SessionModels.swift:690-706
  - title: "Address Review Feedback: Pre-existing: activateTerminalPane uses
      Process.waitUntilExit() inside Task.detached which blocks a cooperative
      thread from the thread pool."
    done: true
    description: >-
      Pre-existing: activateTerminalPane uses Process.waitUntilExit() inside
      Task.detached which blocks a cooperative thread from the thread pool.


      Suggestion: Use Process termination handler or async wrapper instead of
      blocking waitUntilExit.


      Related file: tim-gui/TimGUI/ContentView.swift:112-113
  - title: "Address Review Feedback: `prompt_answered` events are still dropped from
      the Sessions UI, so not all session messages are shown."
    done: false
    description: >-
      `prompt_answered` events are still dropped from the Sessions UI, so not
      all session messages are shown. `MessageFormatter` emits empty text for
      `.promptAnswered`, and `SessionDetailView` explicitly filters empty
      messages. This violates the plan requirement to show session
      content/messages as they arrive.


      Suggestion: Render a non-empty line for `.promptAnswered` (for example
      request id/source), and remove the empty-text filter in the detail list so
      protocol events are not silently hidden.


      Related file: tim-gui/TimGUI/SessionModels.swift:957
  - title: "Address Review Feedback: Missing fields in LlmToolUsePayload and
      LlmToolResultPayload — the input and result fields from the TypeScript
      protocol are absent."
    done: false
    description: >-
      Missing fields in LlmToolUsePayload and LlmToolResultPayload — the input
      and result fields from the TypeScript protocol are absent. The CodingKeys
      enum at line 427 declares input and result keys, but they are never used
      in the decoder (lines 524-534). When inputSummary/resultSummary are nil,
      the Swift formatter will show nothing for these tool invocations, losing
      potentially important information. This suggests the implementer intended
      to handle them but forgot.


      Suggestion: Decode input and result as optional String (via JSON
      serialization of the unknown type) and use them as fallback when
      inputSummary/resultSummary are nil.


      Related file: tim-gui/TimGUI/SessionModels.swift:225-235
  - title: "Address Review Feedback: SessionItem is a struct with a messages:
      [SessionMessage] array, causing full array copy on every mutation through
      SwiftUI's observation system."
    done: false
    description: >-
      SessionItem is a struct with a messages: [SessionMessage] array, causing
      full array copy on every mutation through SwiftUI's observation system.
      SessionState.appendMessage() does
      sessions[index].messages.append(message). Since SessionItem is a struct
      and sessions is an @Observable array, every single message append triggers
      a copy of the entire SessionItem (including all accumulated messages) and
      notifies all observers. For high-throughput sessions producing hundreds or
      thousands of messages, this creates O(n) copy overhead per message and
      excessive SwiftUI re-evaluation.


      Suggestion: Refactor SessionItem to a class-based @Observable model, or
      store messages separately keyed by connection ID, so appending a message
      doesn't copy the entire session struct.


      Related file: tim-gui/TimGUI/SessionState.swift:37
  - title: "Address Review Feedback: WebSocket client-frame validation is
      incomplete: unmasked client frames are accepted, and continuation frames
      are processed even when no fragmented message is in progress."
    done: false
    description: >-
      WebSocket client-frame validation is incomplete: unmasked client frames
      are accepted, and continuation frames are processed even when no
      fragmented message is in progress. RFC 6455 requires masked client frames
      and strict fragmentation sequencing. Current behavior can mis-parse
      malformed streams instead of closing with a protocol error.


      Suggestion: Reject unmasked client data/control frames with close code
      1002, and reject continuation frames when `fragmentOpcode` is nil (also
      close 1002). Add validation for unexpected new data frames while
      fragmentation is active.


      Related file: tim-gui/TimGUI/WebSocketConnection.swift:136
  - title: "Address Review Feedback: Tests still do not cover malformed-frame
      rejection paths that are currently incorrect (unmasked frames, invalid
      continuation ordering)."
    done: false
    description: >-
      Tests still do not cover malformed-frame rejection paths that are
      currently incorrect (unmasked frames, invalid continuation ordering).
      Existing WebSocket tests mostly cover happy-path and size/ping/close
      behavior, so the protocol-validation gaps can regress unnoticed.


      Suggestion: Add explicit integration tests that send: (1) unmasked text
      frame, (2) continuation without prior fragment, (3) new text frame while a
      fragmented message is open; assert server returns close 1002 and
      disconnects.


      Related file: tim-gui/TimGUITests/WebSocketTests.swift:598
  - title: "Address Review Feedback: activateTerminalPane constructs a shell command
      with string interpolation of workspaceName without escaping."
    done: false
    description: >-
      activateTerminalPane constructs a shell command with string interpolation
      of workspaceName without escaping. If the workspace name contains a double
      quote or backslash, the JSON will be malformed. While workspace names are
      typically simple paths, this is a latent injection/formatting bug.


      Suggestion: Use JSONSerialization or JSONEncoder to properly construct the
      JSON string.


      Related file: tim-gui/TimGUI/ContentView.swift:138
  - title: "Address Review Feedback: waitForProcess has a potential double-resume if
      the process terminates synchronously before run() returns."
    done: false
    description: >-
      waitForProcess has a potential double-resume if the process terminates
      synchronously before run() returns. The termination handler is set before
      run(), which is correct for avoiding the race where the process terminates
      before the handler is set. However, if process.run() throws an error AND
      the termination handler has already fired (possible if the process starts
      and fails extremely quickly), the continuation could be resumed twice.


      Suggestion: Use a Bool flag or CheckedContinuation wrapper to ensure
      single resumption, or use withCheckedContinuation with an atomic guard.


      Related file: tim-gui/TimGUI/ContentView.swift:168-179
  - title: "Address Review Feedback: readRequest parses headers twice — once during
      the accumulation loop (lines 249-258) to extract Content-Length, then
      again after the loop (lines 298-305) to build the headers dictionary."
    done: false
    description: >-
      readRequest parses headers twice — once during the accumulation loop
      (lines 249-258) to extract Content-Length, then again after the loop
      (lines 298-305) to build the headers dictionary. The headerLines variable
      from the first parse is computed but only contentLength is used from it.


      Suggestion: Consolidate into a single header parse, or at minimum reuse
      headerLines from the first pass.


      Related file: tim-gui/TimGUI/LocalHTTPServer.swift:239-305
  - title: "Address Review Feedback: PromptAnsweredPayload is missing the value
      field from the TypeScript protocol."
    done: false
    description: >-
      PromptAnsweredPayload is missing the value field from the TypeScript
      protocol. The TypeScript PromptAnsweredMessage has a value?: unknown field
      that carries the actual response value. While the Swift formatter returns
      empty string for promptAnswered (matching the console formatter's silent
      behavior), the field data is lost. If future formatting wants to show what
      was answered, the data won't be available.


      Suggestion: Add an optional value field (decoded as String? via JSON
      coercion) to PromptAnsweredPayload.


      Related file: tim-gui/TimGUI/SessionModels.swift:395-400
changedFiles:
  - tim-gui/TimGUI/ContentView.swift
  - tim-gui/TimGUI/LocalHTTPServer.swift
  - tim-gui/TimGUI/SessionModels.swift
  - tim-gui/TimGUI/SessionState.swift
  - tim-gui/TimGUI/SessionsView.swift
  - tim-gui/TimGUI/TimGUIApp.swift
  - tim-gui/TimGUI/WebSocketConnection.swift
  - tim-gui/TimGUI.xcodeproj/project.pbxproj
  - tim-gui/TimGUITests/LocalHTTPServerTests.swift
  - tim-gui/TimGUITests/MessageFormatterTests.swift
  - tim-gui/TimGUITests/SessionModelTests.swift
  - tim-gui/TimGUITests/SessionStateTests.swift
  - tim-gui/TimGUITests/WebSocketTests.swift
tags:
  - tim-gui
---

Set up a WebSocket server on the default port and path of ws://localhost:8123/tim-agent.

We want to have a two-pane layout where the left side is the list of known sessions and the right side is the content received. When a connection is opened, and we get the session info, then add a new entry to the left pane. In the right pane, show all the content and messages for that session as they come in. Once the session is closed (eg the connection drops), keep the entry but add a button that allows disposing of it. 

The existing notifications view should that forms the GUI right now should continue for the moment. If we can have a
selector at the top that switches between the two views, that would be nice. In the future we'll consolidate them
better.

## Expected Behavior/Outcome

The tim-gui macOS app gains a WebSocket server endpoint at `ws://localhost:8123/tim-agent` alongside its existing HTTP POST endpoint at `/messages`. When a tim headless process connects via WebSocket, a new session entry appears in a left-side session list. Selecting a session shows its streaming content (log output, structured messages) in a right-side detail pane. Closed sessions remain visible with a "Dismiss" button. A top-level view selector allows switching between this new Sessions view and the existing Notifications view.

### States
- **No sessions**: Empty state with placeholder text in the left pane
- **Session connecting**: A new session appears in the list once `session_info` is received
- **Session active**: Session is receiving messages; content streams into the right pane when selected
- **Session replaying**: During `replay_start`/`replay_end`, buffered history is being received (treated same as active for display)
- **Session closed**: Connection dropped; session remains in list with a "Dismiss" button. Visual indicator (e.g. dimmed text or icon) distinguishes it from active sessions
- **Session disposed**: User clicked "Dismiss"; session is removed from the list entirely

## Key Findings

### Product & User Story
As a developer running multiple tim agent/review processes, I want to see all active sessions in a single GUI window so I can monitor their progress, see their output, and know when they finish or need attention. This replaces the need to run `tim-agent-listener.ts` in a terminal and improves on the existing notifications-only view by showing full session output.

### Design & UX Approach
- **Two-pane layout**: Left pane (~250pt wide) shows session list, right pane shows content for the selected session
- **Session list items**: Workspace path as the primary label, with plan title/command as secondary text, connection timestamp, and a status indicator (active/closed)
- **Content pane**: Scrolling text view showing all messages for the selected session, with basic SwiftUI text styling (colored headers, errors in red, tool names styled distinctly—not plain text but not full rich formatting either)
- **View selector**: Picker or segmented control at the top of the window to switch between "Notifications" and "Sessions" views
- **Auto-selection**: When a new session connects and nothing is currently selected, auto-select it. Don't interrupt if the user is viewing another session.
- **Session sorting**: Newest connections first (sorted by connectedAt descending)
- **Dismiss button**: Inline button visible in the session row when the session is closed
- **System notifications**: No macOS notification center alerts for sessions; the existing HTTP notification path handles that
- **Replay handling**: Messages received during replay_start/replay_end are treated identically to live messages (no special indicator)

### Technical Plan & Risks
- **Port sharing**: The current `LocalHTTPServer` uses raw TCP via `NWListener` on port 8123. Adding WebSocket support to the same port requires detecting and routing between HTTP POST requests and WebSocket upgrade requests at the TCP level. This is the main technical challenge.
- **WebSocket implementation**: Swift's `Network` framework provides `NWProtocolWebSocket` but it's designed for listener-level protocol configuration, not for mid-connection protocol switching. The approach is to replace the single `NWListener` with one that can differentiate between HTTP and WebSocket requests by inspecting the initial request line and headers.
- **Message volume**: Agent sessions can produce many messages (especially tool results, LLM responses). The right pane needs to handle large amounts of content efficiently using `LazyVStack`. No message limit per session—keep all messages.
- **Concurrency**: WebSocket connections run on background threads; all UI state mutations must happen on `@MainActor`. The existing pattern of `@MainActor` handler closures works well here.

### Pragmatic Effort Estimate
This is a medium-sized feature involving:
- Replacing the HTTP-only server with a dual HTTP/WebSocket server
- Building the session data model and state management
- Creating the two-pane sessions view
- Adding the view selector to the main content view
- ~800-1200 lines of new Swift code across 4-5 files (the bulk being the ~30 structured message type decoders and their formatters)

## Acceptance Criteria
- [ ] WebSocket server accepts connections at `ws://localhost:8123/tim-agent` and correctly handles the headless protocol (`session_info`, `output`, `replay_start`, `replay_end` messages)
- [ ] HTTP POST to `http://localhost:8123/messages` continues to work for existing notifications
- [ ] Sessions appear in the left pane when a WebSocket connection is established and `session_info` is received
- [ ] Selecting a session shows its accumulated messages in the right pane
- [ ] Messages stream into the right pane in real-time for the currently selected session
- [ ] Closed sessions (WebSocket disconnect) remain in the list with a visual closed indicator and a "Dismiss" button
- [ ] Clicking "Dismiss" removes a closed session from the list
- [ ] A top-level selector allows switching between Notifications and Sessions views
- [ ] Multiple simultaneous WebSocket connections are handled correctly as separate sessions

## Dependencies & Constraints
- **Dependencies**: Relies on the existing headless protocol defined in `src/logging/headless_protocol.ts` and the `HeadlessAdapter` client that sends messages from tim processes
- **Technical Constraints**: Must coexist with the existing HTTP endpoint on port 8123. The Swift `Network` framework must be used (no external dependencies). Must handle WebSocket frame parsing including client-masked frames per RFC 6455.

## Research

### Current Architecture

The tim-gui app is a SwiftUI macOS application with three main source files:

1. **`tim-gui/TimGUI/TimGUIApp.swift`** - App entry point. Contains `AppState` (an `@Observable` class managing notification items) and the `TimGUIApp` struct that starts the HTTP server on port 8123.

2. **`tim-gui/TimGUI/ContentView.swift`** - The main view showing a list of notification messages. Each message shows a read/unread indicator, message text, workspace path, and timestamp. Tapping a message marks it read and optionally activates a wezterm terminal pane.

3. **`tim-gui/TimGUI/LocalHTTPServer.swift`** - A raw TCP server using `NWListener` from the `Network` framework. Listens on port 8123 (loopback only), manually parses HTTP requests, and handles `POST /messages` with JSON body. Defines `MessagePayload`, `MessageItem`, and `TerminalPayload` data models.

### Headless Protocol (TypeScript side)

The tim process uses `HeadlessAdapter` (`src/logging/headless_adapter.ts`) to connect to the WebSocket server. The protocol is defined in `src/logging/headless_protocol.ts`:

```typescript
type HeadlessMessage =
  | HeadlessSessionInfoMessage   // type: 'session_info', command, planId?, planTitle?, workspacePath?, gitRemote?
  | HeadlessOutputMessage        // type: 'output', seq: number, message: TunnelMessage
  | HeadlessReplayStartMessage   // type: 'replay_start'
  | HeadlessReplayEndMessage;    // type: 'replay_end'
```

The `TunnelMessage` within output messages can be:
- `log/error/warn/debug` with `args: string[]`
- `stdout/stderr` with `data: string`
- `structured` with a `StructuredMessage` (~30 types including agent lifecycle, LLM interaction, file operations, review, workflow progress, etc.)

**Connection lifecycle**:
1. Client connects via WebSocket to `ws://localhost:8123/tim-agent`
2. Client sends `session_info` message identifying the session
3. Client sends `replay_start`, then replays all buffered history, then `replay_end`
4. Client continues sending `output` messages in real-time
5. When the tim process ends, the WebSocket connection closes

### Existing Reference Implementation

`scripts/tim-agent-listener.ts` is a simple Bun-based WebSocket server that accepts connections at `/tim-agent` on port 8123 and logs messages to stdout. It uses `Bun.serve()` with WebSocket upgrade handling. This serves as the reference for what the Swift GUI needs to replace.

### Console Formatter

`src/logging/console_formatter.ts` shows how structured messages are rendered for terminal output. The Swift GUI should produce similar formatting but using SwiftUI text styling instead of ANSI chalk colors. Key rendering patterns:
- Session start/end: Show executor, mode, plan ID, duration, cost, success status
- Iteration/step start/end: Show phase, step number, status
- LLM thinking/response: Show text content
- Tool use/result: Show tool name, input/output summary (truncated to 40 lines)
- File changes: Show path with add/modify/delete indicators
- Command exec/result: Show command, exit code, stdout/stderr
- Workflow progress: Show phase and message
- Failure report: Show summary, requirements, problems, solutions

### Swift Docs Available

The `tim-gui/docs/` directory contains guides for:
- `swift-concurrency.md` - Comprehensive Swift 6 concurrency patterns (`@MainActor`, actors, `Sendable`, `async/await`)
- `modern-swift.md` - SwiftUI architecture guidelines (`@Observable`, `@State`, view composition)
- `liquid-glass/` - Liquid Glass UI patterns (future design direction)

Key patterns from these docs that apply:
- Use `@Observable` (not `ObservableObject`) for state management
- Use `@MainActor` for UI-bound state classes
- Use `async/await` and `.task` modifier for async operations
- Build small, focused views with composition

### WebSocket in Swift's Network Framework

`NWProtocolWebSocket` is available in the `Network` framework since macOS 10.15. For a WebSocket server:

```swift
let wsOptions = NWProtocolWebSocket.Options()
let params = NWParameters.tcp
params.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)
let listener = try NWListener(using: params, on: port)
```

However, this configures the listener to treat ALL incoming connections as WebSocket, which conflicts with also serving HTTP. Two approaches to handle both:

**Approach A**: Use a single raw TCP listener and manually handle both protocols. Inspect the request line—if it's a `GET /tim-agent` with `Upgrade: websocket`, perform the WebSocket handshake and switch to WebSocket framing. If it's `POST /messages`, handle as HTTP. This requires implementing WebSocket frame parsing (~150 lines).

**Approach B**: Use two separate `NWListener` instances on different ports. Keep HTTP on 8123, add WebSocket on another port (e.g., 8124). Simpler but requires updating the default WebSocket URL in the headless adapter config.

**Approach C**: Use a single raw TCP listener and after detecting a WebSocket upgrade request, create a new `NWConnection` wrapper with `NWProtocolWebSocket` configured. This leverages Apple's WebSocket frame handling while still allowing HTTP on the same port.

Approach A is the most self-contained and matches the plan's port requirement exactly.

## Implementation Guide

### Step 1: Define Session Data Models

Create `tim-gui/TimGUI/SessionModels.swift` with data models for the WebSocket session tracking:

- **`HeadlessMessage`**: A Swift `Codable` enum matching the TypeScript `HeadlessMessage` union type. Use a discriminated union pattern with a `type` field for decoding:
  - `SessionInfoMessage` with command, planId, planTitle, workspacePath, gitRemote (all optional except command)
  - `OutputMessage` with seq (Int) and message (TunnelMessage)
  - `ReplayStartMessage` and `ReplayEndMessage` (no additional fields)

- **`TunnelMessage`**: A Swift `Codable` enum matching the TypeScript `TunnelMessage`:
  - `ArgsMessage` (type: log/error/warn/debug, args: [String])
  - `DataMessage` (type: stdout/stderr, data: String)
  - `StructuredMessage` (type: structured, message: StructuredMessagePayload)

- **`StructuredMessagePayload`**: Decode all ~30 structured message types individually to match the TypeScript `StructuredMessage` union (`src/logging/structured_messages.ts`). Use a custom `init(from:)` decoder that reads the `type` field first then decodes the appropriate payload. All types should have dedicated Swift structs/enums:
  - Agent lifecycle: `agent_session_start`, `agent_session_end`, `agent_iteration_start`, `agent_step_start`, `agent_step_end`
  - LLM interaction: `llm_thinking`, `llm_response`, `llm_tool_use`, `llm_tool_result`, `llm_status`
  - Todo: `todo_update`
  - File operations: `file_write`, `file_edit`, `file_change_summary`
  - Command execution: `command_exec`, `command_result`
  - Review: `review_start`, `review_result`, `review_verdict`
  - Workflow: `workflow_progress`, `failure_report`, `task_completion`, `execution_summary`
  - Other: `token_usage`, `input_required`, `plan_discovery`, `workspace_info`

- **`SessionItem`**: An `Identifiable` struct representing a session in the list:
  - `id: UUID`
  - `connectionId: UUID` (to match with the WebSocket connection)
  - `command: String`
  - `planId: Int?`
  - `planTitle: String?`
  - `workspacePath: String?`
  - `connectedAt: Date`
  - `isActive: Bool` (true while WebSocket is connected)
  - `messages: [SessionMessage]`

- **`SessionMessage`**: An `Identifiable` struct for individual messages in the content pane:
  - `id: UUID`
  - `seq: Int`
  - `text: String` (formatted text for display)
  - `category: MessageCategory` (enum: lifecycle, llmOutput, toolUse, fileChange, command, progress, error, log)
  - `timestamp: Date?`

### Step 2: Upgrade the Server to Handle Both HTTP and WebSocket

Refactor `LocalHTTPServer` into a unified `AppServer` (or rename in place) that handles both protocols on port 8123.

The server already does manual HTTP request parsing. Extend it to:

1. After parsing the HTTP request line and headers, check if the request is a WebSocket upgrade:
   - Method is `GET`
   - Path is `/tim-agent`
   - Has `Upgrade: websocket` header (case-insensitive)
   - Has `Sec-WebSocket-Key` header

2. If it's a WebSocket upgrade:
   - Compute the accept key: SHA-1 hash of `Sec-WebSocket-Key + "258EAFA5-E914-47DA-95CA-5AB5F7FC6835"`, then base64 encode
   - Send the `101 Switching Protocols` response with `Upgrade: websocket`, `Connection: Upgrade`, and `Sec-WebSocket-Accept` headers
   - Transition the connection to WebSocket mode: start a read loop that parses WebSocket frames

3. If it's a regular HTTP request, handle as before (POST /messages → notification)

**WebSocket frame parsing** (server-side, receiving client frames):
- Read 2 bytes: FIN bit, opcode (4 bits), MASK bit (always 1 from client), payload length (7 bits)
- If length == 126, read 2 more bytes for 16-bit length
- If length == 127, read 8 more bytes for 64-bit length
- Read 4-byte masking key
- Read payload bytes, XOR each with mask[i % 4]
- Handle opcodes: 0x1 (text), 0x8 (close), 0x9 (ping → respond with pong), 0xA (pong → ignore)

**WebSocket frame sending** (server-side, unmasked):
- Write 2 bytes: FIN=1, opcode, MASK=0, payload length
- Write extended length if needed
- Write payload bytes (no mask from server)

For the SHA-1 computation needed for the WebSocket accept key, use `CommonCrypto` or `CryptoKit` (available since macOS 10.15):
```swift
import CryptoKit
let hash = Insecure.SHA1.hash(data: Data(acceptString.utf8))
let acceptKey = Data(hash).base64EncodedString()
```

Create this as a separate `WebSocketConnection` class that owns the `NWConnection` after the upgrade handshake, manages the read loop, and forwards parsed messages to a handler closure.

### Step 3: Create the Session State Manager

Extend `AppState` (in `TimGUIApp.swift`) or create a companion `SessionState` class:

```swift
@MainActor
@Observable
final class SessionState {
    var sessions: [SessionItem] = []
    var selectedSessionId: UUID?

    func addSession(connectionId: UUID, info: SessionInfoMessage) { ... }
    func appendMessage(connectionId: UUID, message: SessionMessage) { ... }
    func markDisconnected(connectionId: UUID) { ... }
    func dismissSession(id: UUID) { ... }

    var selectedSession: SessionItem? { ... }
}
```

Wire this up in `TimGUIApp.swift`:
- Create `@State private var sessionState = SessionState()`
- Pass the session state's handler to the server for WebSocket connections
- When a WebSocket connection receives `session_info`, call `sessionState.addSession(...)`
- When an `output` message is received, decode it, format the text, and call `sessionState.appendMessage(...)`
- When a WebSocket connection closes, call `sessionState.markDisconnected(...)`

### Step 4: Build the Sessions View

Create `tim-gui/TimGUI/SessionsView.swift` with a two-pane layout:

**Left pane** (session list):
```swift
struct SessionListView: View {
    @Bindable var sessionState: SessionState

    var body: some View {
        List(sessionState.sessions, selection: $sessionState.selectedSessionId) { session in
            SessionRowView(session: session)
                .swipeActions { if !session.isActive { Button("Dismiss") { ... } } }
        }
    }
}
```

Each row shows:
- Workspace path as the primary label (headline font)
- Plan title or command name as secondary text (subheadline, secondary)
- Connection time (caption, secondary)
- Status indicator: green circle for active, gray for closed
- Inline "Dismiss" button visible for closed sessions

**Right pane** (session detail):
```swift
struct SessionDetailView: View {
    let session: SessionItem

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(session.messages) { message in
                        SessionMessageView(message: message)
                            .id(message.id)
                    }
                }
            }
            .onChange(of: session.messages.count) { proxy.scrollTo(session.messages.last?.id) }
        }
    }
}
```

Use `NavigationSplitView` for the two-pane layout on macOS:
```swift
struct SessionsView: View {
    @Bindable var sessionState: SessionState

    var body: some View {
        NavigationSplitView {
            SessionListView(sessionState: sessionState)
        } detail: {
            if let session = sessionState.selectedSession {
                SessionDetailView(session: session)
            } else {
                ContentUnavailableView("No Session Selected", systemImage: "rectangle.split.2x1")
            }
        }
    }
}
```

### Step 5: Message Formatting for Display

Create a `MessageFormatter` utility that converts `TunnelMessage` types into `SessionMessage` with formatted text and a `MessageCategory` for styling. This mirrors the logic in `console_formatter.ts` but uses basic SwiftUI text styling (colored headers, errors in red, tool names styled distinctly). The `SessionMessageView` should use the category to apply appropriate `.foregroundStyle` and `.font` modifiers.

- For `log/error/warn/debug`: Join args with spaces. Use error category for error/warn (red styling), log category for others.
- For `stdout/stderr`: Use the data string directly. Mark stderr as error category.
- For all `structured` message types (decode all ~30 types per the data model), format based on type. Reference `src/logging/console_formatter.ts` for the formatting logic of each type:
  - `agent_session_start`: "Starting — Executor: X, Mode: Y, Plan: Z" (lifecycle category, green bold header)
  - `agent_session_end`: "Done — Success: yes/no, Duration: Xs, Cost: $Y" (lifecycle, green bold)
  - `agent_iteration_start`: "Iteration N — Task Title" (lifecycle, blue bold)
  - `agent_step_start/end`: "Step Start/End: phase" with success indicator (lifecycle)
  - `llm_thinking`: "Thinking: [text]" (llmOutput category, blue)
  - `llm_response`: "[text]" (llmOutput, green bold)
  - `llm_tool_use`: "Tool: toolName — inputSummary" (toolUse category, cyan)
  - `llm_tool_result`: "Tool Result: toolName — resultSummary" (toolUse, truncate long results to 40 lines)
  - `llm_status`: "Status: [status]" (log category, gray)
  - `todo_update`: Formatted list of items with status indicators (progress category)
  - `file_write`: "Write: path (N lines)" (fileChange category, cyan)
  - `file_edit`: "Edit: path" with diff text (fileChange, cyan)
  - `file_change_summary`: List of changes with +/~/- indicators (fileChange)
  - `command_exec`: "Exec Begin: command" (command category, cyan)
  - `command_result`: "Exec Finished: command" with exit code, stdout, stderr (command)
  - `review_start/result/verdict`: Format review info (lifecycle)
  - `workflow_progress`: "[phase] message" (progress category, blue)
  - `failure_report`: "FAILED: summary" with details (error category, red)
  - `task_completion`: "Task complete: taskTitle" (lifecycle, green)
  - `execution_summary`: Summary statistics (lifecycle)
  - `token_usage`: "Usage: input=X output=Y total=Z" (log, gray)
  - `input_required`: "Input required: prompt" (progress, yellow)
  - `plan_discovery`: "Found ready plan: ID - title" (lifecycle, green)
  - `workspace_info`: "Workspace: path" (log, cyan)

### Step 6: Add View Selector to ContentView

Modify `ContentView.swift` to add a top-level view selector:

```swift
enum AppViewMode: String, CaseIterable {
    case notifications = "Notifications"
    case sessions = "Sessions"
}

struct ContentView: View {
    @Bindable var appState: AppState
    @Bindable var sessionState: SessionState
    let startError: String?
    @State private var viewMode: AppViewMode = .sessions

    var body: some View {
        VStack(spacing: 0) {
            // Top bar with view selector and status
            HStack {
                Picker("View", selection: $viewMode) {
                    ForEach(AppViewMode.allCases, id: \.self) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 300)
                Spacer()
                Text("Listening on port 8123")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(12)

            if let startError { ... }

            switch viewMode {
            case .notifications:
                NotificationsView(appState: appState)  // Extracted from current ContentView
            case .sessions:
                SessionsView(sessionState: sessionState)
            }
        }
    }
}
```

Extract the existing notification list from `ContentView` into a `NotificationsView` subview so it can be swapped with the `SessionsView`.

### Step 7: Wire Everything Together

In `TimGUIApp.swift`:
1. Create both `AppState` and `SessionState` as `@State` properties
2. Create the server with handlers for both HTTP (notifications) and WebSocket (sessions)
3. Pass both state objects to `ContentView`

The server creation would look like:
```swift
let newServer = AppServer(port: 8123,
    httpHandler: { payload in appState?.ingest(payload) },
    wsHandler: { event in
        switch event {
        case .sessionInfo(let connId, let info):
            sessionState?.addSession(connectionId: connId, info: info)
        case .message(let connId, let msg):
            sessionState?.appendMessage(connectionId: connId, message: msg)
        case .disconnected(let connId):
            sessionState?.markDisconnected(connectionId: connId)
        }
    }
)
```

### Manual Testing Steps

1. Build and run the tim-gui app
2. Run a tim agent process with headless mode enabled (the default URL should point to `ws://localhost:8123/tim-agent`)
3. Verify the session appears in the Sessions view left pane
4. Verify messages stream into the right pane when the session is selected
5. Verify that after the agent process completes, the session shows as closed with a Dismiss button
6. Verify the existing Notifications view still works by sending a POST to `http://localhost:8123/messages`
7. Test switching between Notifications and Sessions views
8. Test running multiple agents simultaneously to verify multiple sessions
9. Test the Dismiss button removes closed sessions
10. Test reconnection: kill and restart the GUI while an agent is running; the agent should reconnect and replay history

## Implementation Notes

### Recommended Approach
Use the unified TCP server approach (Approach A from research) where a single `NWListener` on port 8123 handles both HTTP and WebSocket. This avoids external dependencies, matches the plan's port requirement, and leverages the existing HTTP parsing code. The WebSocket frame parser is ~150-200 lines of well-specified protocol code.

### Potential Gotchas
1. **WebSocket close handshake**: When the server detects a close frame from the client, it should send a close frame back before closing the connection. When the client disconnects without a close frame (e.g., process crash), the NWConnection will fire its state change handler.
2. **Message ordering**: WebSocket messages arrive on background threads; all state mutations must be dispatched to `@MainActor`. Use the existing pattern from `LocalHTTPServer.handler`.
3. **Memory management**: Long-running sessions can accumulate many messages. No artificial limit is imposed—`LazyVStack` handles rendering efficiently. If memory becomes an issue in practice, a cap can be added later.
4. **JSON decoding**: The headless protocol uses a discriminated union pattern on the `type` field. Swift's `Codable` can handle this with a custom `init(from:)` that reads the type first, then decodes the appropriate payload.
5. **Frame fragmentation**: WebSocket messages can be split across multiple frames (FIN=0 for continuation frames). The implementation should buffer continuation frames until a FIN=1 frame is received. In practice, the headless adapter sends complete JSON messages as single frames, but the implementation should handle fragmentation for robustness.
6. **Port 8123 already in use**: If the existing `tim-agent-listener.ts` script is also running on port 8123, the GUI won't be able to bind. This is expected—only one should run at a time.

## Current Progress
### Current State
- All 15 tasks complete (6 core + 9 review feedback)
- 142 tests passing
### Completed (So Far)
- SessionModels.swift: All Decodable types for HeadlessMessage, TunnelMessage, StructuredMessagePayload (~28 types), SessionItem, SessionMessage, MessageCategory, plus MessageFormatter
- WebSocketConnection.swift: Full RFC 6455 frame parsing/sending, upgrade handshake, fragmentation, close/ping/pong, NSLock-protected close state, 16MB frame limit, fragment buffer size limit
- LocalHTTPServer.swift: Routes GET /tim-agent with Upgrade: websocket to WebSocket handler, POST /messages continues as HTTP, WebSocketEvent dispatch with os.Logger, leftover buffer forwarding to WebSocket, post-startup listener monitoring
- SessionState.swift: @MainActor @Observable class with addSession, appendMessage, markDisconnected, dismissSession (guards against active sessions), auto-selection, selectedSession computed property
- SessionsView.swift: NavigationSplitView two-pane layout — SessionListView with selection/status/dismiss, SessionDetailView with auto-scroll and monospaced message rendering, SessionMessageView with category-based coloring
- ContentView.swift: Refactored with AppViewMode picker (Sessions/Notifications), NotificationsView extracted, accepts both appState and sessionState, dynamic port display, non-blocking Process execution
- TimGUIApp.swift: Wires WebSocket events to SessionState methods — sessionInfo→addSession, output→MessageFormatter.format→appendMessage, disconnected→markDisconnected; passes bound port to ContentView
- All unknown message types handled gracefully with .unknown fallback cases
- agent_step_end shows success/failure indicator (✓/✗) and uses .error category for failures
- review_result renders issue/recommendation/action-item counts and details; review_verdict renders verdict string and fix instructions
- execution_summary properly decodes totalSteps/failedSteps from summary.metadata
- ContentView port text is dynamic via serverPort parameter from LocalHTTPServer.boundPort
- MessageFormatter and date formatters are @MainActor-isolated for thread safety
- Task 8: HTTPRequest includes leftoverData, WebSocketConnection has readBuffer for pre-read bytes
- Task 10: onDisconnect fires after close frame send and connection.cancel() inside Task block
- Task 11: WebSocket protocol tests for fragmentation, ping/pong, close handshake, oversize frame/fragment rejection, upgrade+immediate-frame
- Task 13: stateUpdateHandler logs post-startup listener failures instead of being set to nil
- Task 15: waitForProcess async helper with terminationHandler replaces blocking waitUntilExit
### Remaining
- None
### Next Iteration Guidance
- Performance: SessionItem is a struct with growing messages array. For high-throughput sessions, consider refactoring to class-based @Observable SessionItem or separate message storage to reduce SwiftUI re-evaluation
- Auto-scroll uses both onAppear and onChange with .id(session.id) on SessionDetailView for stable view identity
- Lifecycle messages all render green; the plan mentioned green/blue but current implementation is acceptable for v1
- Review noted that promptAnswered messages still create empty SessionMessage objects that accumulate in memory without rendering (info-level, pre-existing design)
- Post-startup listener failures are logged but not surfaced to UI; consider adding a callback to update startError state
- Headers are parsed twice in readRequest (once for Content-Length, once for dictionary); could consolidate for performance
### Decisions / Changes
- Used Approach A (unified TCP server) with manual WebSocket frame parsing rather than NWProtocolWebSocket
- Types are Decodable only (not full Codable) since we only receive, never encode protocol messages
- All discriminated unions use .unknown fallback for forward compatibility
- WebSocketConnection uses NSLock for thread safety (not actor, since it needs to interact with NWConnection synchronously)
- 16MB max frame size limit for security (applies to both individual frames and accumulated fragment buffers)
- dismissSession guards against active sessions — only closed sessions can be dismissed
- Window minWidth increased to 800 to accommodate two-pane layout
- MessageFormatter is @MainActor-isolated (chosen over locking or manual date parsing)
- waitForProcess sets terminationHandler before run() to avoid race condition
### Risks / Blockers
- None
