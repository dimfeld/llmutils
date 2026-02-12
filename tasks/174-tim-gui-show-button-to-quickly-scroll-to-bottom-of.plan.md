---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "tim-gui: show button to quickly scroll to bottom of session messages
  when not at bottom"
goal: Add a floating scroll-to-bottom button in SessionDetailView that appears
  when the user scrolls away from the bottom of the message list, allowing them
  to quickly return to the latest messages.
id: 174
uuid: 450efd91-1cc9-4513-b43f-147d6a0d58d7
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-02-12T21:13:25.230Z
promptsGeneratedAt: 2026-02-12T21:13:25.230Z
createdAt: 2026-02-12T18:59:34.588Z
updatedAt: 2026-02-12T21:47:16.377Z
tasks:
  - title: Add scroll-to-bottom button overlay to SessionDetailView
    done: true
    description: 'In tim-gui/TimGUI/SessionsView.swift, add an .overlay modifier to
      the ScrollView (inside the ScrollViewReader closure) containing a Button
      that: (1) is conditionally shown when !isNearBottom using an if statement,
      (2) calls withAnimation { proxy.scrollTo(lastId, anchor: .bottom) } on
      tap, (3) is positioned at bottom-trailing with padding, (4) uses
      chevron.down.circle.fill SF Symbol, (5) uses .buttonStyle(.plain) and
      .ultraThinMaterial background with .clipShape(.circle), (6) has
      .transition(.opacity) and .animation(.easeInOut(duration: 0.2), value:
      isNearBottom), (7) includes .help("Scroll to bottom") tooltip. Size should
      be around 32-36pt with ~16pt padding from edges.'
changedFiles:
  - tim-gui/TimGUI/SessionsView.swift
tags: []
---

## Research

### Overview

The tim-gui is a native macOS application built with **SwiftUI** that displays real-time output from running tim agents via WebSocket connections. Session messages stream in continuously during agent runs, and the message list can grow quite long. Users need a way to quickly return to the bottom of the message stream after scrolling up to review earlier output.

### Critical Discoveries

1. **`isNearBottom` state already exists**: `SessionDetailView` (in `tim-gui/TimGUI/SessionsView.swift`, lines 94-163) already tracks whether the user is near the bottom of the scroll view via a `@State private var isNearBottom = true` property. This is the exact signal needed to show/hide the scroll-to-bottom button.

2. **`ScrollViewReader` proxy is already available**: The view already wraps its content in a `ScrollViewReader { proxy in ... }`, and uses `proxy.scrollTo(lastId, anchor: .bottom)` for auto-scrolling. The same proxy can be reused for the button's scroll action.

3. **Auto-scroll threshold is 50px**: The `shouldAutoScroll` static method uses a 50px threshold to determine "near bottom" status. When the user scrolls more than 50px above the bottom, `isNearBottom` becomes `false` — this is when the button should appear.

4. **Message IDs are UUIDs**: Each `SessionMessage` has a `UUID` `id` field, and messages in the `ForEach` are tagged with `.id(message.id)`. Scrolling to the last message uses `session.messages.last?.id`.

### Key Files

| File | Purpose |
|------|---------|
| `tim-gui/TimGUI/SessionsView.swift` | Contains `SessionDetailView` (message list + scroll logic), `SessionMessageView`, scroll offset preference key |
| `tim-gui/TimGUITests/AutoScrollTests.swift` | Tests for `shouldAutoScroll` logic — will be extended with button-related tests if testable logic is extracted |

### Existing Scroll Architecture

The scroll system works as follows:
- A `GeometryReader` inside the `ScrollView` measures content position relative to a named coordinate space `"sessionScroll"`
- A `ScrollOffsetPreferenceKey` propagates the content frame upward
- `onPreferenceChange` updates `isNearBottom` via `shouldAutoScroll()`
- `onChange(of: session.messages.count)` triggers auto-scroll only when `isNearBottom == true`

### Architectural Considerations

- **Overlay approach**: The button should be overlaid on top of the `ScrollView` using a `.overlay` modifier, positioned at the bottom. This keeps it visually anchored regardless of scroll position.
- **Animation**: The button should animate in/out smoothly using SwiftUI's built-in `.transition()` and `.animation()` modifiers.
- **Scrolling action**: When tapped, the button should call `proxy.scrollTo(lastId, anchor: .bottom)` with animation, and `isNearBottom` will naturally become `true` as the scroll position updates, causing the button to hide.
- **Z-ordering**: The overlay naturally renders above the scroll content, so no special z-ordering is needed.

### Dependencies & Constraints

- **Dependencies**: Only depends on existing SwiftUI framework APIs. No external libraries needed.
- **Technical Constraints**: The `ScrollViewReader` proxy is only available within its closure scope, so the button must be placed inside that scope (as part of the overlay on the ScrollView or as a sibling in a ZStack).
- **Platform**: macOS 15+ (already the app's minimum target).

## Implementation Guide

### Expected Behavior

- When the user scrolls up more than 50px from the bottom of the session messages, a floating "scroll to bottom" button appears near the bottom-right corner of the message area.
- Tapping the button smoothly scrolls to the most recent message and the button fades away.
- The button does not appear when the user is already at or near the bottom.
- The button appears/disappears with a smooth fade animation.
- When new messages arrive while the button is visible, the button remains visible (since `isNearBottom` is `false`, auto-scroll does not engage).

### Acceptance Criteria

- [ ] A scroll-to-bottom button appears when the user scrolls away from the bottom of the message list
- [ ] The button disappears when the user is at or near the bottom
- [ ] Clicking the button scrolls to the most recent message
- [ ] The button appears/disappears with a smooth animation
- [ ] The button does not interfere with text selection or message interaction
- [ ] The button uses a standard SF Symbol icon (e.g., `chevron.down.circle.fill`)
- [ ] Existing auto-scroll behavior continues to work correctly

### Step-by-Step Implementation

#### Step 1: Add the scroll-to-bottom button overlay to `SessionDetailView`

In `tim-gui/TimGUI/SessionsView.swift`, modify `SessionDetailView.body` to add an `.overlay` on the `ScrollView` (inside the `ScrollViewReader` closure so the proxy is accessible).

The overlay should contain a `Button` that:
- Is only visible when `!isNearBottom`
- Uses `withAnimation { proxy.scrollTo(lastId, anchor: .bottom) }` as its action
- Is positioned at the bottom-trailing corner using `.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)` with padding
- Uses an SF Symbol icon like `chevron.down.circle.fill`
- Has a smooth fade transition using `.transition(.opacity)` wrapped in an `if !isNearBottom` conditional with `.animation(.easeInOut(duration: 0.2), value: isNearBottom)` on the overlay

The button styling should:
- Use `.buttonStyle(.plain)` to avoid default macOS button chrome
- Use a semi-transparent background (e.g., `.background(.ultraThinMaterial)` or a filled circle style)
- Have reasonable size (around 32-36pt) and padding from the edges
- Include a `.help("Scroll to bottom")` tooltip

#### Step 2: Update tests

Since the button visibility is driven entirely by the existing `isNearBottom` state (which is already tested via `shouldAutoScroll`), the main new testable behavior is the scroll action itself. However, SwiftUI scroll actions are not easily unit-testable.

The existing `AutoScrollTests` already cover the `shouldAutoScroll` logic thoroughly. No new unit tests are strictly needed since we're not adding new testable logic — just wiring existing state to a UI element.

If desired, a SwiftUI preview can be added to visually verify the button behavior.

#### Step 3: Manual Testing

1. Run the app and connect a session
2. Let messages accumulate
3. Scroll up — verify the button appears
4. Click the button — verify smooth scroll to bottom and button disappears
5. Stay at bottom as new messages arrive — verify button stays hidden
6. Scroll up and let new messages arrive — verify button stays visible (auto-scroll should NOT engage)
7. Verify text selection still works with the button present

### Rationale

- **Overlay approach vs ZStack**: Using `.overlay` is preferred over wrapping in a ZStack because it keeps the button scoped to the ScrollView's bounds and doesn't change the layout hierarchy.
- **Reusing `isNearBottom`**: This state already perfectly represents whether the button should be visible. No new state tracking is needed.
- **Reusing `proxy.scrollTo`**: The same scrolling mechanism used by auto-scroll ensures consistent behavior.
- **Simple fade animation**: A fade is the most common and least distracting transition for floating action buttons. It avoids complex slide animations that might feel out of place in a utility app.

## Current Progress
### Current State
- All tasks complete. Implementation is done and builds successfully.
### Completed (So Far)
- Added scroll-to-bottom button overlay to SessionDetailView in SessionsView.swift
- Button uses `.overlay(alignment: .bottomTrailing)` on the ScrollView, inside the ScrollViewReader closure
- Conditionally shown when `!isNearBottom`, uses `chevron.down.circle.fill` SF Symbol at 32pt
- Styled with `.buttonStyle(.plain)`, `.ultraThinMaterial` background, `.clipShape(.circle)`
- Smooth fade animation via `.transition(.opacity)` and `.animation(.easeInOut(duration: 0.2), value: isNearBottom)`
- Fixed review-identified bug: unwrap optional UUID before passing to `proxy.scrollTo` to ensure proper AnyHashable matching
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Used `if let lastId = session.messages.last?.id` unwrapping in the button action to avoid passing `UUID?` to `scrollTo` (which matches by `AnyHashable` and wouldn't match `UUID` view IDs)
### Risks / Blockers
- None
