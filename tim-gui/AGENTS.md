## Build and Test

- `./scripts/restart.sh` (rebuild signed Debug + restart)
- `./scripts/build.sh` (plain build without running)
- `./scripts/test.sh` (run unit tests via xcodebuild)
- `./scripts/lint.sh` (SwiftFormat + SwiftLint)

## Documentation

Look in the `docs` directory for guidance on writing Swift and using SwiftUI.

## Message Sending Architecture

- **OutgoingMessage enum** (in `SessionModels.swift`): Encodable enum for GUI→backend messages. Currently has `.userInput(content:)`. Extensible for future structured prompt responses (select, confirm, etc.).
- **SessionState.sendMessageHandler**: Closure wired in `TimGUIApp.swift` that serializes `OutgoingMessage` to JSON and sends via `LocalHTTPServer.sendMessage(to:text:)`. Throws `SendError.noHandler` if not set.
- **MessageInputBar** (in `SessionsView.swift`): Auto-growing text field (1–5 lines) with Enter-to-send, Shift+Enter for newlines. Only visible when session is active. Reports its height via `InputBarHeightKey` preference so the scroll-to-bottom button stays above it.
- **Backend handling**: `HeadlessAdapter.setUserInputHandler()` receives `user_input` messages and forwards to Claude Code subprocess stdin via `sendFollowUpMessage()`. See `docs/executor-stdin-conventions.md` for details.

## SwiftUI Conventions

- **Use `.opacity()` instead of conditional rendering for fixed-size elements**: When toggling visibility of small fixed-size elements (e.g., indicator dots), use `.opacity(condition ? 1 : 0)` rather than `if condition { Circle() }`. Conditional rendering causes layout shifts as SwiftUI adds/removes the element from the view hierarchy, while opacity reserves the space and avoids jank.
- **Unread-dot behavior**: Clear `hasUnreadNotification` when the user either clicks the session row or clicks the WezTerm terminal icon in that row.
