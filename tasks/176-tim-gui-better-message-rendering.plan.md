---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "tim-gui: better message rendering"
goal: "Replace flat text message rendering with structured GUI components: bold
  headers, proportional prose font, SF Symbol todo checklists, styled file
  change lists, and key-value pair formatting"
id: 176
uuid: 5cfb64ed-3cd8-46a3-8c04-c7cb795cfe61
generatedBy: agent
status: in_progress
priority: medium
planGeneratedAt: 2026-02-13T00:32:16.920Z
promptsGeneratedAt: 2026-02-13T00:32:16.920Z
createdAt: 2026-02-13T00:20:32.866Z
updatedAt: 2026-02-13T00:39:04.691Z
tasks:
  - title: Define MessageContentBody structured model and supporting types
    done: false
    description: "In SessionModels.swift, add the MessageContentBody enum (text,
      monospaced, todoList, fileChanges, keyValuePairs), TodoDisplayItem struct
      with TodoStatus enum, and FileChangeDisplayItem struct with FileChangeKind
      enum. Update SessionMessage to replace the flat `text: String` field with
      `title: String?` and `body: MessageContentBody?` fields. Keep `id`, `seq`,
      `timestamp`, and `category` fields. Ensure all new types conform to
      Sendable."
  - title: Update MessageFormatter to produce structured SessionMessage values
    done: false
    description: "Refactor MessageFormatter.formatStructured() to return
      SessionMessage directly with the new structured fields instead of a
      (String, MessageCategory) tuple. Headers become the `title` field (plain
      text, no ### prefix). Todo items become TodoDisplayItem arrays in
      .todoList body. File changes become FileChangeDisplayItem arrays in
      .fileChanges body. Session start/end and execution summary use
      .keyValuePairs body with (key, value) tuples. LLM thinking/response use
      .text body. Tool results, command output, and diffs use .monospaced body.
      Workflow progress uses title: nil with .text body. Parse ISO8601 timestamp
      strings into Date? on SessionMessage (move timestamp parsing from the
      header() helper into the formatter). Remove the header() helper function.
      Update the format() method to construct SessionMessage with the new
      fields."
  - title: Rewrite SessionMessageView for rich GUI rendering
    done: false
    description: "Replace the single Text(message.text) in SessionMessageView with a
      VStack-based layout. Add a headerView that renders the title in bold
      .headline proportional font with category color, and a right-aligned
      timestamp in .caption .secondary style using HStack + Spacer. Add a
      bodyView that switches on MessageContentBody: .text renders proportional
      body font, .monospaced renders monospaced body font, .todoList renders a
      VStack of HStack rows with SF Symbol icons (checkmark.circle.fill green
      for completed, play.circle.fill blue for inProgress, circle gray for
      pending, exclamationmark.circle.fill orange for blocked,
      questionmark.circle gray for unknown) and label text, .fileChanges renders
      VStack of HStack rows with colored +/~/- indicators and monospaced path
      text, .keyValuePairs renders VStack of Text views using Text concatenation
      with secondary-colored key and primary-colored value. Preserve
      .textSelection(.enabled) on the outer container and .frame(maxWidth:
      .infinity, alignment: .leading). Keep the existing colorForCategory helper
      for category-based colors."
  - title: Update MessageFormatterTests for structured content model
    done: false
    description: "Rewrite all tests in MessageFormatterTests.swift to test the new
      structured SessionMessage fields. Replace text.contains assertions with
      direct field checks: msg.title == expected title, msg.body pattern
      matching for correct body type and contents. Test todoUpdate produces
      .todoList with correct TodoDisplayItem statuses. Test fileChangeSummary
      produces .fileChanges with correct FileChangeKind values. Test session
      start/end produces .keyValuePairs. Test LLM response/thinking produces
      .text body. Test tool use/result produces .monospaced body. Verify
      category assignments remain correct. Test timestamp parsing produces
      correct Date? values. Run tests with ./scripts/test.sh."
  - title: Update SwiftUI preview with rich message examples
    done: false
    description: "Update the #Preview in SessionsView.swift to showcase the new
      rendering. Add preview messages for: todoUpdate with mixed statuses,
      fileChangeSummary with added/updated/removed files, llmResponse with
      multi-line prose text, commandResult with monospaced output,
      agentSessionStart with key-value details. This provides a quick way to
      visually verify the rendering without connecting a live session."
tags: []
---

Currently, we render everything looking like markdown. We should render items in a more GUI-like fashion, using an actual bold header and some text, and to-do items should render something that looks like a checklist.

## Research

### Problem Statement

The tim-gui macOS app currently renders all session messages as plain monospaced text. The `MessageFormatter` enum converts structured message payloads into flat `String` values with markdown-like syntax (e.g., `### Header`, `[x] Task`), and `SessionMessageView` renders them with a single `Text` view using `.system(.body, design: .monospaced)`. This means headers appear as literal `### text`, todo items appear as literal `[x] text`, and there is no visual hierarchy beyond color and bold/regular weight per category.

### Current Architecture

**Data Flow:**
1. Structured messages arrive via WebSocket as JSON (`TunnelMessage` → `StructuredMessagePayload`)
2. `MessageFormatter.format()` converts each payload into a `SessionMessage` with a flat `text: String` and a `category: MessageCategory`
3. `SessionDetailView` iterates over `session.messages` in a `LazyVStack` and renders each via `SessionMessageView`
4. `SessionMessageView` renders `Text(message.text)` with monospaced font, category-based color, and category-based weight

**Key Files:**
- `tim-gui/TimGUI/SessionModels.swift` (1076 lines): Contains `SessionMessage`, `MessageCategory`, all structured payload types, and `MessageFormatter`
- `tim-gui/TimGUI/SessionsView.swift` (283 lines): Contains `SessionDetailView`, `SessionMessageView`, scroll logic, previews
- `tim-gui/TimGUITests/MessageFormatterTests.swift` (679 lines): Tests for all message formatting

**Current `SessionMessage` struct:**
```swift
struct SessionMessage: Identifiable, Sendable {
    let id: UUID
    let seq: Int
    let text: String
    let category: MessageCategory
    let timestamp: Date?
}
```

**Current `SessionMessageView`:**
```swift
struct SessionMessageView: View {
    let message: SessionMessage
    var body: some View {
        Text(message.text)
            .font(.system(.body, design: .monospaced))
            .foregroundStyle(colorForCategory(message.category))
            .fontWeight(weightForCategory(message.category))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
```

**Current `MessageFormatter`:**
- Produces strings with `### Title [HH:mm:ss]` headers using a `header()` helper
- Todo items use `[x]`, `[>]`, `[ ]`, `[!]` text indicators
- File changes use `+`, `~`, `-` text indicators
- All structured content is joined with newlines into a single string

### Key Findings

1. **The formatter is the right place to change**: `MessageFormatter` already produces structured text. We need to change it to produce structured _data_ instead of flat strings, and update the view to render that structured data with proper SwiftUI components.

2. **`SessionMessage` needs a richer content model**: Instead of `text: String`, messages should carry structured content like a title, body text, and optional list items. This enables `SessionMessageView` to render each part with appropriate styling.

3. **SwiftUI `Text` supports inline formatting**: SwiftUI's `Text` view supports `Text("bold").bold() + Text(" normal")` concatenation for inline rich text. However, for headers + body + lists, composing `VStack` with separate `Text` views will be cleaner.

4. **Existing tests are comprehensive**: All 30+ message types have tests in `MessageFormatterTests.swift`. The tests currently assert against the flat `text` string. They'll need to be updated to test the new structured content model.

5. **Category-based coloring remains valuable**: The existing color scheme per `MessageCategory` should be preserved. The change is about _within-message_ structure, not across-message differentiation.

6. **LazyVStack + ForEach pattern is efficient**: The current `LazyVStack` in `SessionDetailView` will continue to work well since each message is still a single identifiable view — just with richer internal layout.

7. **Auto-scroll and text selection must be preserved**: The recent scroll-to-bottom feature (task 174) and `.textSelection(.enabled)` must continue to work.

### Message Types and Their Rendering Needs

| Message Type | Current Format | Desired GUI Format |
|---|---|---|
| Session start/end | `### Starting\nExecutor: claude` | Bold header + key-value details |
| Iteration start | `### Iteration 3\nTask title` | Bold header + subtitle |
| Step start/end | `### Step Start: phase\nmessage` | Bold header with status icon + body |
| LLM thinking/response | `### Thinking\ntext content` | Bold header + proportional body text |
| Tool use/result | `### Invoke Tool: Read\nsummary` | Bold header + monospaced body |
| Todo update | `### Todo Update\n[x] Done\n[ ] Pending` | Bold header + visual checklist |
| File changes | `### File Changes\n+ file.ts` | Bold header + styled file list |
| Command exec/result | `### Exec Begin\ncommand` | Bold header + monospaced command/output |
| Workflow progress | `[phase] message` | Inline phase badge + message |
| Error/failure | `FAILED: summary` | Red-tinted header + body |
| Token usage | `### Usage\ninput=1000 output=200` | Compact inline stats |

### Design Decisions

1. **Structured content model**: Introduce a `MessageContent` type that `MessageFormatter` produces instead of flat strings. This separates data from presentation cleanly.

2. **Proportional font for prose, monospaced for code**: LLM responses and thinking should use proportional font for readability. Tool results, command output, and diffs should remain monospaced.

3. **Visual checkboxes for todos**: Use SF Symbols (`checkmark.circle.fill`, `circle`, `arrow.right.circle`, `exclamationmark.circle`) to render todo status rather than text brackets. Icons are visual-only (non-interactive).

4. **Keep header + body pattern**: Most messages have a header line and body content. The view should render the header as a bold `.headline` or `.subheadline` with a proportional font, and the body with appropriate styling per message type.

5. **Timestamps**: Rendered as right-aligned secondary text in the header row, not inline with the title.

6. **Message spacing**: Keep the current 4pt spacing between messages — the bold headers provide sufficient visual separation.

## Implementation Guide

### Step 1: Define the `MessageContent` Structured Model

In `SessionModels.swift`, add a new enum or struct that represents the visual structure of a message:

```swift
enum MessageContentBody: Sendable {
    case text(String)
    case monospaced(String)
    case todoList([TodoDisplayItem])
    case fileChanges([FileChangeDisplayItem])
    case keyValuePairs([(key: String, value: String)])
}

struct TodoDisplayItem: Sendable {
    let label: String
    let status: TodoStatus
}

enum TodoStatus: Sendable {
    case completed, inProgress, pending, blocked, unknown
}

struct FileChangeDisplayItem: Sendable {
    let path: String
    let kind: FileChangeKind
}

enum FileChangeKind: Sendable {
    case added, updated, removed, unknown
}
```

Update `SessionMessage` to carry structured content alongside or instead of the flat text:

```swift
struct SessionMessage: Identifiable, Sendable {
    let id: UUID
    let seq: Int
    let title: String?
    let timestamp: Date?
    let body: MessageContentBody?
    let category: MessageCategory
}
```

**Rationale**: Separating title from body and using typed body variants lets the view render each message type with the optimal UI treatment. The title is always rendered as a bold header, while the body variant determines the specific rendering (checklist, file list, key-value, plain text, or monospaced).

### Step 2: Update `MessageFormatter` to Produce Structured Content

Modify `MessageFormatter.formatStructured()` to return `SessionMessage` directly with the new structured fields instead of a `(String, MessageCategory)` tuple.

Key changes per message type:
- **Headers** become the `title` field (without the `###` prefix, just the text like "Starting", "Thinking", "Invoke Tool: Read")
- **Todo items** become `TodoDisplayItem` arrays in a `.todoList` body
- **File changes** become `FileChangeDisplayItem` arrays in a `.fileChanges` body
- **Session start/end, execution summary** use `.keyValuePairs` body
- **LLM thinking/response** use `.text` body (proportional)
- **Tool results, command output, diffs** use `.monospaced` body
- **Workflow progress** (no header, just inline text) can use `title: nil` with a `.text` body

The `header()` helper and timestamp formatting should be reworked: the timestamp should be stored on `SessionMessage` as a `Date?` and formatted only at render time. The title becomes a plain string.

### Step 3: Rewrite `SessionMessageView` for Rich Rendering

Replace the single `Text(message.text)` with a structured `VStack`:

```swift
struct SessionMessageView: View {
    let message: SessionMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let title = message.title {
                headerView(title)
            }
            if let body = message.body {
                bodyView(body)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
```

**Header rendering**: Bold, proportional font (`.headline` or `.subheadline`), category color. Timestamp rendered right-aligned in `.caption` size with `.secondary` foreground style using a `Spacer()` in the header `HStack`.

**Body rendering per type**:
- `.text(String)`: Proportional font, `.body` size, category color
- `.monospaced(String)`: Monospaced font, `.body` size, category color
- `.todoList`: VStack of HStack rows, each with an SF Symbol circle + label text
- `.fileChanges`: VStack of HStack rows with colored indicators (`+`/`~`/`-` or SF Symbols) + monospaced path
- `.keyValuePairs`: VStack of HStack rows with dim key label + value text

**Todo status icons** (SF Symbols):
- completed: `checkmark.circle.fill` (green)
- inProgress: `play.circle.fill` (blue) or `arrow.right.circle` (blue)
- pending: `circle` (gray/secondary)
- blocked: `exclamationmark.circle.fill` (orange/yellow)
- unknown: `questionmark.circle` (gray)

### Step 4: Update Tests

Update `MessageFormatterTests.swift` to test the new structured content:
- Instead of `#expect(msg.text.contains("### Starting"))`, test `#expect(msg.title == "Starting")`
- Instead of `#expect(msg.text.contains("[x] Done task"))`, test that `msg.body` is a `.todoList` with the correct items and statuses
- Test that category assignments remain correct
- Test that timestamps are parsed correctly into `Date?`
- Add tests for the new display item types

### Step 5: Update Preview

Update the `#Preview` in `SessionsView.swift` to include a richer set of messages showcasing the new rendering — todo updates, file changes, LLM responses, command results, etc.

### Manual Testing

1. Build and run with `./scripts/restart.sh`
2. Connect a tim agent session and verify:
   - Headers appear bold with proportional font, timestamps in secondary style
   - LLM response text appears in proportional font
   - Todo items render as visual checklists with SF Symbol icons
   - File change lists show colored indicators and monospaced paths
   - Command output and diffs remain monospaced
   - Auto-scroll continues to work
   - Text selection works across all message parts
   - Colors still differentiate message categories
3. Test with Xcode previews for quick iteration

### Constraints and Considerations

- **Text selection**: SwiftUI's `.textSelection(.enabled)` on a `VStack` propagates to child `Text` views. However, it does not allow selecting across multiple `Text` views in a single drag. This is a known SwiftUI limitation. The current behavior (selecting within a single `Text`) already has this limitation since each message is a separate view. The new approach maintains the same behavior.
- **Performance**: `LazyVStack` ensures only visible messages are rendered. The slightly richer per-message layout (VStack with 2-3 children instead of 1 Text) should have negligible performance impact.
- **Backwards compatibility**: Messages with `title: nil` and `.text` body cover cases like `workflowProgress` that don't have a header pattern.
