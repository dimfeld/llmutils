## Build and Test

- `./scripts/restart.sh` (rebuild signed Debug + restart)
- `./scripts/build.sh` (plain build without running)
- `./scripts/test.sh` (run unit tests via xcodebuild)
- `./scripts/lint.sh` (SwiftFormat + SwiftLint)

## Documentation

Look in the `docs` directory for guidance on writing Swift and using SwiftUI.

## Message Sending Architecture

- **OutgoingMessage enum** (in `SessionModels.swift`): Encodable enum for GUI→backend messages. Cases:
  - `.userInput(content:)` — free-form text input to agent stdin
  - `.promptResponse(requestId:, value:)` — structured response to an interactive prompt (confirm, select, input, checkbox, prefix_select)
- **PromptResponseValue** (in `SessionModels.swift`): Encodable/Equatable enum representing typed prompt response values (`.bool`, `.string`, `.int`, `.double`, `.array`, `.object`). Uses `singleValueContainer()` encoding to produce raw JSON types for backend compatibility. Also used as the storage type for choice values and defaults in `PromptChoiceConfigPayload.value` and `PromptConfigPayload.defaultValue` — values are decoded into their original JSON types (Bool before Int/Double before String) at parse time, avoiding lossy string coercion and heuristic type reversal.
- **Prompt state tracking**: `SessionItem` has a `pendingPrompt: PromptRequestPayload?` field. `SessionState` provides `setActivePrompt`, `clearActivePrompt`, and `sendPromptResponse` methods. These no-op during replay (checked via `replayingConnections`) to prevent stale prompts from appearing after reconnect. `markDisconnected` clears any pending prompt. `sendPromptResponse` only clears `pendingPrompt` if the requestId still matches after the async send, preventing a race where a new prompt arriving during the network send gets wiped.
- **Prompt UI error handling and double-submission protection**: `PromptContainerView` centralizes async lifecycle for all prompt sub-views. It manages `isSending` state (passed down as `Bool` to disable submit/action buttons in sub-views) and `sendError` state (shown as an inline error message that auto-clears after 3 seconds). The `handleResponse()` method guards against double submission, wraps the async send in do/catch, and re-enables buttons after completion. This follows the same pattern as `MessageInputBar`.
- **Prompt event wiring**: `TimGUIApp.swift` wsHandler matches `.structured(message: .promptRequest(...))` and `.structured(message: .promptAnswered(...))` tunnel messages, delegating to SessionState methods which handle replay safety internally.
- **SessionState.sendMessageHandler**: Closure wired in `TimGUIApp.swift` that serializes `OutgoingMessage` to JSON and sends via `LocalHTTPServer.sendMessage(to:text:)`. Throws `SendError.noHandler` if not set.
- **MessageInputBar** (in `SessionsView.swift`): Auto-growing text field (1–5 lines) with Enter-to-send, Shift+Enter for newlines. Only visible when session is active. Reports its height via `InputBarHeightKey` preference so the scroll-to-bottom button stays above it.
- **Backend handling**: `HeadlessAdapter.setUserInputHandler()` receives `user_input` messages and `handleServerMessage()` receives `prompt_response` messages. See `docs/executor-stdin-conventions.md` for details.

## SwiftUI Conventions

- **Use `.opacity()` instead of conditional rendering for fixed-size elements**: When toggling visibility of small fixed-size elements (e.g., indicator dots), use `.opacity(condition ? 1 : 0)` rather than `if condition { Circle() }`. Conditional rendering causes layout shifts as SwiftUI adds/removes the element from the view hierarchy, while opacity reserves the space and avoids jank.
- **Unread-dot behavior**: Clear `hasUnreadNotification` when the user either clicks the session row or clicks the WezTerm terminal icon in that row.
