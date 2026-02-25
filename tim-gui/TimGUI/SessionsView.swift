import SwiftUI

private enum LoopDiagnostics {
    // Mitigations are enabled by default. Set to "0"/"false"/"no"/"off" to opt out.
    static let disableContainerAnimation = envFlag("TIM_GUI_DISABLE_CONTAINER_ANIMATION", defaultValue: true)
    static let disableInputBarHeightFeedback = envFlag(
        "TIM_GUI_DISABLE_INPUTBAR_HEIGHT_FEEDBACK",
        defaultValue: true)
    static let disableMessageTextSelection = envFlag(
        "TIM_GUI_DISABLE_MESSAGE_TEXT_SELECTION",
        defaultValue: true)

    private static func envFlag(_ key: String, defaultValue: Bool) -> Bool {
        guard let value = ProcessInfo.processInfo.environment[key]?.lowercased() else {
            return defaultValue
        }
        if value == "1" || value == "true" || value == "yes" || value == "on" {
            return true
        }
        if value == "0" || value == "false" || value == "no" || value == "off" {
            return false
        }
        return defaultValue
    }
}

extension View {
    @ViewBuilder
    fileprivate func applyIf(_ condition: Bool, transform: (Self) -> some View) -> some View {
        if condition {
            transform(self)
        } else {
            self
        }
    }
}

// MARK: - SessionsView

struct SessionsView: View {
    @Bindable var sessionState: SessionState

    var body: some View {
        NavigationSplitView {
            SessionListView(sessionState: self.sessionState)
                .navigationSplitViewColumnWidth(min: 200, ideal: 280, max: 400)
                .background(.ultraThinMaterial)
        } detail: {
            if let session = sessionState.selectedSession {
                SessionDetailView(session: session, sessionState: self.sessionState)
                    .id(session.id)
                    .background(.thinMaterial)
            } else {
                EmptyStateView(
                    title: "No Session Selected",
                    subtitle: "Select a session from the sidebar to view its output.",
                    icon: "rectangle.split.2x1")
                    .background(.thinMaterial)
            }
        }
    }
}

// MARK: - SessionGroupHeaderView

private struct SessionGroupHeaderView: View {
    let group: SessionGroup
    let isCollapsed: Bool
    let onToggle: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .rotationEffect(.degrees(self.isCollapsed ? 0 : 90))
                .animation(.easeInOut(duration: 0.2), value: self.isCollapsed)

            Text(self.group.displayName)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)

            Spacer()

            // Notification dot - always present, opacity-controlled (per AGENTS.md).
            // Visible only when the group is collapsed AND has an unread notification.
            Circle()
                .fill(.blue)
                .frame(width: 8, height: 8)
                .opacity(self.isCollapsed && self.group.hasNotification ? 1 : 0)

            Text("\(self.group.sessionCount)")
                .font(.caption2)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.quaternary, in: Capsule())
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .onTapGesture(perform: self.onToggle)
    }
}

// MARK: - SessionListView

struct SessionListView: View {
    @Bindable var sessionState: SessionState
    @State private var collapsedGroups: Set<String> = []

    private var hasDisconnectedSessions: Bool {
        self.sessionState.sessions.contains { !$0.isActive }
    }

    var body: some View {
        if self.sessionState.sessions.isEmpty {
            EmptyStateView(
                title: "No Sessions",
                subtitle: "Sessions will appear here when tim processes connect.",
                icon: "antenna.radiowaves.left.and.right")
                .padding(.horizontal, 12)
        } else {
            List(selection: self.$sessionState.selectedSessionId) {
                // Each ForEach iteration produces a single Section so that .onMove
                // operates on one view per group. This avoids unpredictable drag behaviour
                // that can occur when a ForEach iteration emits multiple sibling views.
                ForEach(self.sessionState.groupedSessions) { group in
                    let isCollapsed = self.collapsedGroups.contains(group.id)

                    Section {
                        if !isCollapsed {
                            ForEach(group.sessions) { session in
                                SessionRowView(
                                    session: session,
                                    isSelected: session.id == self.sessionState.selectedSessionId,
                                    onTap: { self.sessionState.handleSessionListItemTap(sessionId: session.id) },
                                    onTerminalTap: { self.sessionState.handleTerminalIconTap(sessionId: session.id) },
                                    onDismiss: { self.sessionState.dismissSession(id: session.id) })
                                    .tag(session.id)
                            }
                        }
                    } header: {
                        SessionGroupHeaderView(
                            group: group,
                            isCollapsed: isCollapsed)
                        {
                            if isCollapsed {
                                self.collapsedGroups.remove(group.id)
                            } else {
                                self.collapsedGroups.insert(group.id)
                            }
                        }
                    }
                }
                .onMove { from, to in
                    self.sessionState.moveGroup(from: from, to: to)
                }
            }
            .listStyle(.sidebar)
            .toolbar {
                ToolbarItem(placement: .automatic) {
                    Button(action: {
                        guard let session = self.sessionState.firstSessionWithNotification else { return }
                        let groupKey = sessionGroupKey(
                            gitRemote: session.gitRemote,
                            workspacePath: session.workspacePath)
                        self.collapsedGroups.remove(groupKey)
                        self.sessionState.handleSessionListItemTap(sessionId: session.id)
                    }) {
                        Image(systemName: "bell.badge")
                    }
                    .disabled(self.sessionState.firstSessionWithNotification == nil)
                    .help("Jump to first notification")
                }
                ToolbarItem(placement: .automatic) {
                    if self.hasDisconnectedSessions {
                        Button(action: { self.sessionState.dismissAllDisconnected() }) {
                            Label("Clear Disconnected", systemImage: "xmark.circle")
                        }
                        .help("Remove all disconnected sessions")
                    }
                }
            }
        }
    }
}

// MARK: - EmptyStateView

private struct EmptyStateView: View {
    let title: String
    let subtitle: String
    let icon: String

    var body: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(.quaternary.opacity(0.25))
                    .frame(width: 56, height: 56)
                Image(systemName: self.icon)
                    .font(.system(size: 24, weight: .medium))
                    .foregroundStyle(.secondary)
            }

            VStack(spacing: 4) {
                Text(self.title)
                    .font(.title3.weight(.semibold))
                Text(self.subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(20)
    }
}

// MARK: - SessionRowView

struct SessionRowView: View {
    let session: SessionItem
    let isSelected: Bool
    let onTap: () -> Void
    let onTerminalTap: () -> Void
    let onDismiss: () -> Void

    private var isNotificationOnly: Bool {
        self.session.command.isEmpty
    }

    private var statusLabel: String {
        if self.isNotificationOnly {
            return "One-off"
        }
        return self.session.isActive ? "Active" : "Offline"
    }

    private var statusSystemImage: String {
        if self.isNotificationOnly {
            return "bell.badge"
        }
        return self.session.isActive ? "dot.radiowaves.left.and.right" : "pause.circle"
    }

    private var statusStyle: AnyShapeStyle {
        if self.isNotificationOnly {
            AnyShapeStyle(.secondary)
        } else if self.session.isActive {
            AnyShapeStyle(.green)
        } else {
            AnyShapeStyle(.secondary)
        }
    }

    private var rowBackgroundStyle: AnyShapeStyle {
        if self.isSelected {
            AnyShapeStyle(Color.accentColor.opacity(0.18))
        } else {
            AnyShapeStyle(.quaternary.opacity(0.08))
        }
    }

    private var rowBorderStyle: AnyShapeStyle {
        if self.isSelected {
            AnyShapeStyle(Color.accentColor.opacity(0.45))
        } else {
            AnyShapeStyle(Color.clear)
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                Text(SessionRowView.shortenedPath(self.session.workspacePath) ?? "Unknown workspace")
                    .font(.callout.weight(.semibold))
                    .lineLimit(1)

                if self.session.command.isEmpty, let msg = session.notificationMessage {
                    Text(msg)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else {
                    Text(self.session.displayTitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                HStack(spacing: 8) {
                    Label(
                        self.statusLabel,
                        systemImage: self.statusSystemImage)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(self.statusStyle)

                    Text(self.session.displayTimestamp, style: .time)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            if self.session.hasUnreadNotification {
                Circle()
                    .fill(.blue)
                    .frame(width: 8, height: 8)
            }

            if self.session.terminal?.type == "wezterm" {
                Button(action: {
                    self.onTerminalTap()
                    activateTerminalPane(self.session.terminal!)
                }) {
                    Image(systemName: "terminal")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(6)
                        .background(
                            .quaternary.opacity(0.35),
                            in: RoundedRectangle(cornerRadius: nestedRectangleCornerRadius))
                }
                .buttonStyle(.plain)
                .help("Activate terminal pane")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: nestedRectangleCornerRadius)
                .fill(self.rowBackgroundStyle))
        .overlay(
            RoundedRectangle(cornerRadius: nestedRectangleCornerRadius)
                .stroke(self.rowBorderStyle, lineWidth: 1))
        .padding(.vertical, 3)
        .contentShape(RoundedRectangle(cornerRadius: nestedRectangleCornerRadius))
        .onTapGesture(perform: self.onTap)
        .contextMenu(self.session.isActive ? nil : ContextMenu(menuItems: {
            Button("Dismiss", action: self.onDismiss)
        }))
    }

    static func shortenedPath(_ path: String?) -> String? {
        guard let path else { return nil }
        let components = path.split(separator: "/", omittingEmptySubsequences: true)
        if components.count <= 2 {
            return path
        }
        return components.suffix(2).joined(separator: "/")
    }
}

// MARK: - InputBarHeightKey

private struct InputBarHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

// MARK: - SessionDetailView

struct SessionDetailView: View {
    let session: SessionItem
    var sessionState: SessionState
    /// Whether the bottom anchor is currently visible in the scroll view.
    @State private var isNearBottom = true
    /// Sticky auto-scroll intent, separate from isNearBottom.
    /// Only disabled when the user scrolls the bottom anchor out of view
    /// while content is stable (i.e. not due to new messages arriving).
    @State private var autoScrollEnabled = true
    /// Message count when the bottom anchor was last visible.
    /// Used to distinguish "content grew" from "user scrolled away".
    @State private var messageCountAtBottom = 0
    @State private var inputText = ""
    @State private var inputBarHeight: CGFloat = 0
    @State private var isAdjustingBottomInset = false
    @FocusState private var isFocused: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(self.session.messages) { message in
                        SessionMessageView(message: message)
                            .id(message.id)
                    }

                    Color.clear
                        .frame(height: 1)
                        .id(SessionDetailView.bottomAnchorID)
                        .onAppear {
                            self.isNearBottom = true
                            self.autoScrollEnabled = true
                            self.messageCountAtBottom = self.session.messages.count
                        }
                        .onDisappear {
                            // Prompt show/hide changes the bottom inset and can make
                            // the anchor temporarily disappear without user scrolling.
                            guard !self.isAdjustingBottomInset else { return }
                            self.isNearBottom = false
                            // Only disable auto-scroll if content hasn't changed,
                            // meaning the user scrolled away rather than new
                            // messages pushing the bottom out of view.
                            if self.session.messages.count == self.messageCountAtBottom {
                                self.autoScrollEnabled = false
                            }
                        }
                }
                .padding(12)
                .padding(.bottom, 20)
            }
            .overlay(alignment: .bottomTrailing) {
                if !self.isNearBottom, !self.autoScrollEnabled {
                    Button {
                        self.autoScrollEnabled = true
                        self.jumpToBottom(proxy)
                    } label: {
                        Image(systemName: "chevron.down.circle.fill")
                            .font(.system(size: 32))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .background(.ultraThinMaterial)
                    .clipShape(.circle)
                    .help("Scroll to bottom")
                    .transition(.opacity)
                    .padding(16)
                    .padding(
                        .bottom,
                        LoopDiagnostics.disableInputBarHeightFeedback ? 0 : self.inputBarHeight)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if self.session.isActive {
                    VStack(spacing: 0) {
                        if let prompt = self.session.pendingPrompt {
                            PromptContainerView(prompt: prompt) { value in
                                try await self.sessionState.sendPromptResponse(
                                    sessionId: self.session.id,
                                    requestId: prompt.requestId,
                                    value: value)
                            }
                        }

                        MessageInputBar(inputText: self.$inputText) { text in
                            try await self.sessionState.sendUserInput(
                                sessionId: self.session.id, content: text)
                        }
                        .applyIf(!LoopDiagnostics.disableInputBarHeightFeedback) { view in
                            view.background(
                                GeometryReader { geo in
                                    Color.clear.preference(
                                        key: InputBarHeightKey.self,
                                        value: geo.size.height)
                                })
                        }
                    }
                }
            }
            .animation(
                LoopDiagnostics.disableContainerAnimation ? nil : .easeInOut(duration: 0.2),
                value: self.isNearBottom)
            .focusable()
            .focused(self.$isFocused)
            .onAppear {
                self.jumpToBottom(proxy)
                self.isFocused = true
            }
            .onChange(of: self.session.messages.count) {
                if self.autoScrollEnabled {
                    self.jumpToBottom(proxy)
                }
            }
            .onChange(of: self.session.forceScrollToBottomVersion) {
                self.jumpToBottom(proxy)
                self.isNearBottom = true
                self.autoScrollEnabled = true
            }
            .onChange(of: self.session.pendingPrompt?.requestId) {
                self.handlePromptInsetTransition(proxy)
            }
            .onKeyPress(.home) {
                if let firstId = session.messages.first?.id {
                    proxy.scrollTo(firstId, anchor: .top)
                }
                return .handled
            }
            .onKeyPress(.end) {
                self.autoScrollEnabled = true
                self.jumpToBottom(proxy)
                return .handled
            }
        }
        .onPreferenceChange(InputBarHeightKey.self) { height in
            if LoopDiagnostics.disableInputBarHeightFeedback {
                self.inputBarHeight = 0
                return
            }
            // Ignore sub-point jitter from layout recalculation to avoid
            // unnecessary view invalidation.
            if abs(self.inputBarHeight - height) > 0.5 {
                self.inputBarHeight = height
            }
        }
    }

    private func jumpToBottom(_ proxy: ScrollViewProxy) {
        var transaction = Transaction()
        transaction.animation = nil
        withTransaction(transaction) {
            proxy.scrollTo(SessionDetailView.bottomAnchorID, anchor: .bottom)
        }
    }

    private func handlePromptInsetTransition(_ proxy: ScrollViewProxy) {
        self.isAdjustingBottomInset = true

        if self.autoScrollEnabled {
            Task { @MainActor in
                // Wait for inset/layout to settle before forcing scroll.
                try? await Task.sleep(for: .milliseconds(50))
                self.jumpToBottom(proxy)
            }
        }

        Task { @MainActor in
            // Keep this guard briefly after prompt mount/unmount.
            try? await Task.sleep(for: .milliseconds(250))
            self.isAdjustingBottomInset = false
        }
    }

    static let bottomAnchorID = "session-bottom-anchor"
}

// MARK: - MessageInputBar

struct MessageInputBar: View {
    @Binding var inputText: String
    let onSend: (String) async throws -> Void
    @FocusState private var isFocused: Bool
    @State private var sendError: String?
    @State private var isSending = false
    @State private var errorVersion = 0

    private var trimmedText: String {
        self.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(spacing: 0) {
            if let sendError {
                Text(sendError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            HStack(alignment: .bottom, spacing: 8) {
                TextField("Send a message...", text: self.$inputText, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...5)
                    .focused(self.$isFocused)
                    .onKeyPress(.return, phases: .down) { keyPress in
                        if keyPress.modifiers.contains(.shift) {
                            return .ignored
                        }
                        self.sendMessage()
                        return .handled
                    }
                    .padding(.vertical, 8)
                    .padding(.horizontal, 12)

                Button(action: { self.sendMessage() }) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
                .disabled(self.trimmedText.isEmpty || self.isSending)
                .buttonStyle(.plain)
                .padding(.trailing, 8)
                .padding(.bottom, 8)
            }
        }
        .background(.ultraThinMaterial)
    }

    private func sendMessage() {
        let text = self.trimmedText
        guard !text.isEmpty, !self.isSending else { return }
        self.isSending = true
        self.sendError = nil
        Task {
            do {
                try await self.onSend(text)
                self.inputText = ""
            } catch {
                self.sendError = "Failed to send message"
                self.errorVersion += 1
                let capturedVersion = self.errorVersion
                Task {
                    try? await Task.sleep(for: .seconds(3))
                    if self.errorVersion == capturedVersion {
                        withAnimation {
                            self.sendError = nil
                        }
                    }
                }
            }
            self.isSending = false
        }
    }
}

// MARK: - SessionMessageView

@MainActor private let timestampFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "HH:mm:ss"
    return f
}()

struct SessionMessageView: View {
    let message: SessionMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let title = message.title {
                self.headerView(title)
            }
            if let body = message.body {
                self.bodyView(body)
            }
        }
        .applyIf(!LoopDiagnostics.disableMessageTextSelection) { view in
            view.textSelection(.enabled)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func headerView(_ title: String) -> some View {
        HStack {
            Text(title)
                .font(.headline)
                .foregroundStyle(self.colorForCategory(self.message.category))
            Spacer()
            if let ts = message.timestamp {
                Text(timestampFormatter.string(from: ts))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func bodyView(_ body: MessageContentBody) -> some View {
        switch body {
        case let .text(text):
            Text(text)
                .font(.body)
                .foregroundStyle(self.colorForCategory(self.message.category))

        case let .monospaced(text):
            Text(text)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(self.colorForCategory(self.message.category))

        case let .todoList(items):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(spacing: 6) {
                        Image(systemName: self.iconForTodoStatus(item.status))
                            .foregroundStyle(self.colorForTodoStatus(item.status))
                            .font(.body)
                        Text(item.label)
                            .font(.body)
                            .foregroundStyle(self.colorForCategory(self.message.category))
                    }
                }
            }

        case let .fileChanges(items):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(spacing: 6) {
                        Text(self.indicatorForFileChange(item.kind))
                            .font(.system(.body, design: .monospaced))
                            .foregroundStyle(self.colorForFileChange(item.kind))
                            .frame(width: 14, alignment: .center)
                        Text(item.path)
                            .font(.system(.body, design: .monospaced))
                            .foregroundStyle(self.colorForCategory(self.message.category))
                    }
                }
            }

        case let .keyValuePairs(pairs):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(pairs.enumerated()), id: \.offset) { _, pair in
                    Text("\(pair.key): ").foregroundStyle(.secondary)
                        + Text(pair.value).foregroundStyle(.primary)
                }
            }
        }
    }

    private func colorForCategory(_ category: MessageCategory) -> Color {
        switch category {
        case .lifecycle: .green
        case .llmOutput: .green
        case .toolUse: .cyan
        case .fileChange: .cyan
        case .command: .cyan
        case .progress: .blue
        case .error: .red
        case .log: .primary
        case .userInput: .orange
        }
    }

    private func iconForTodoStatus(_ status: TodoStatus) -> String {
        switch status {
        case .completed: "checkmark.circle.fill"
        case .inProgress: "play.circle.fill"
        case .pending: "circle"
        case .blocked: "exclamationmark.circle.fill"
        case .unknown: "questionmark.circle"
        }
    }

    private func colorForTodoStatus(_ status: TodoStatus) -> Color {
        switch status {
        case .completed: .green
        case .inProgress: .blue
        case .pending: .secondary
        case .blocked: .orange
        case .unknown: .secondary
        }
    }

    private func indicatorForFileChange(_ kind: FileChangeKind) -> String {
        switch kind {
        case .added: "+"
        case .updated: "~"
        case .removed: "-"
        case .unknown: "?"
        }
    }

    private func colorForFileChange(_ kind: FileChangeKind) -> Color {
        switch kind {
        case .added: .green
        case .updated: .yellow
        case .removed: .red
        case .unknown: .secondary
        }
    }
}

// MARK: - Previews

#Preview("Sessions View") {
    SessionsView(
        sessionState: {
            let state = SessionState()

            // Session 1 & 2 — same project (myapp), different tasks
            let connId1 = UUID()
            state.addSession(
                connectionId: connId1,
                info: SessionInfoPayload(
                    command: "agent",
                    planId: 169,
                    planTitle: "Add WebSocket support",
                    workspacePath: "/Users/dev/projects/myapp",
                    gitRemote: "git@github.com:dimfeld/myapp.git",
                    terminal: nil))
            state.addSession(
                connectionId: UUID(),
                info: SessionInfoPayload(
                    command: "agent",
                    planId: 170,
                    planTitle: "Fix auth bug",
                    workspacePath: "/Users/dev/projects/myapp",
                    gitRemote: "git@github.com:dimfeld/myapp.git",
                    terminal: nil))

            // Session 3 — different org/project
            state.addSession(
                connectionId: UUID(),
                info: SessionInfoPayload(
                    command: "agent",
                    planId: 201,
                    planTitle: "Refactor parser",
                    workspacePath: "/Users/dev/projects/lib",
                    gitRemote: "git@github.com:other-org/lib.git",
                    terminal: nil))

            // Session 4 — no gitRemote, falls back to workspacePath
            state.addSession(
                connectionId: UUID(),
                info: SessionInfoPayload(
                    command: "agent",
                    planId: 202,
                    planTitle: "Update docs",
                    workspacePath: "/Users/dev/projects/another",
                    gitRemote: nil,
                    terminal: nil))

            if let connId = state.sessions.first(where: { $0.connectionId == connId1 })?.connectionId {
                let ts = "2026-02-13T00:30:00.000Z"
                var seq = 0
                func nextSeq() -> Int {
                    seq += 1; return seq
                }

                state.appendMessage(
                    connectionId: connId,
                    message: MessageFormatter.format(
                        tunnelMessage: .structured(
                            message: .agentSessionStart(AgentSessionStartPayload(
                                executor: "claude", mode: "agent", planId: 169,
                                sessionId: nil, threadId: nil, tools: nil,
                                mcpServers: nil, timestamp: ts))),
                        seq: nextSeq()))
                state.appendMessage(
                    connectionId: connId,
                    message: MessageFormatter.format(
                        tunnelMessage: .structured(
                            message: .llmResponse(
                                text: "I'll start by reading the project structure to understand how the WebSocket module should integrate with the existing codebase.",
                                isUserRequest: false, timestamp: ts)),
                        seq: nextSeq()))
                state.appendMessage(
                    connectionId: connId,
                    message: MessageFormatter.format(
                        tunnelMessage: .structured(
                            message: .llmToolUse(LlmToolUsePayload(
                                toolName: "Read", inputSummary: "src/main.ts",
                                input: nil, timestamp: ts))),
                        seq: nextSeq()))
                state.appendMessage(
                    connectionId: connId,
                    message: MessageFormatter.format(
                        tunnelMessage: .structured(
                            message: .commandResult(CommandResultPayload(
                                command: "npm test", cwd: "/Users/dev/projects/myapp",
                                exitCode: 0, stdout: "All 42 tests passed\nTest Suites: 8 passed",
                                stderr: nil, timestamp: ts))),
                        seq: nextSeq()))
                state.appendMessage(
                    connectionId: connId,
                    message: MessageFormatter.format(
                        tunnelMessage: .structured(
                            message: .todoUpdate(items: [
                                TodoUpdateItem(label: "Set up WebSocket server", status: "completed"),
                                TodoUpdateItem(label: "Implement message handlers", status: "in_progress"),
                                TodoUpdateItem(label: "Add reconnection logic", status: "pending"),
                                TodoUpdateItem(label: "Write integration tests", status: "pending"),
                                TodoUpdateItem(label: "Deploy to staging", status: "blocked"),
                            ], timestamp: ts)),
                        seq: nextSeq()))
                state.appendMessage(
                    connectionId: connId,
                    message: MessageFormatter.format(
                        tunnelMessage: .structured(
                            message: .fileChangeSummary(changes: [
                                FileChangeItem(path: "src/websocket/server.ts", kind: "added"),
                                FileChangeItem(path: "src/websocket/handlers.ts", kind: "added"),
                                FileChangeItem(path: "src/main.ts", kind: "updated"),
                                FileChangeItem(path: "src/old-polling.ts", kind: "removed"),
                            ], timestamp: ts)),
                        seq: nextSeq()))
            }
            return state
        }())
}
