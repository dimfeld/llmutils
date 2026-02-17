import SwiftUI

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
                SessionDetailView(session: session)
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

// MARK: - SessionListView

struct SessionListView: View {
    @Bindable var sessionState: SessionState

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
            List(self.sessionState.sessions, selection: self.$sessionState.selectedSessionId) { session in
                SessionRowView(
                    session: session,
                    isSelected: session.id == self.sessionState.selectedSessionId,
                    onTap: { self.sessionState.handleSessionListItemTap(sessionId: session.id) },
                    onTerminalTap: { self.sessionState.handleTerminalIconTap(sessionId: session.id) },
                    onDismiss: { self.sessionState.dismissSession(id: session.id) })
            }
            .listStyle(.sidebar)
            .toolbar {
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
                        self.session.isActive ? "Active" : "Offline",
                        systemImage: self.session.isActive ? "dot.radiowaves.left.and.right" : "pause.circle")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(self.session.isActive ? .green : .secondary)

                    Text(self.session.connectedAt, style: .time)
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
                        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                .help("Activate terminal pane")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(self.rowBackgroundStyle))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(self.rowBorderStyle, lineWidth: 1))
        .padding(.vertical, 3)
        .contentShape(Rectangle())
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

// MARK: - SessionDetailView

struct SessionDetailView: View {
    let session: SessionItem
    /// Whether the bottom anchor is currently visible in the scroll view.
    @State private var isNearBottom = true
    /// Sticky auto-scroll intent, separate from isNearBottom.
    /// Only disabled when the user scrolls the bottom anchor out of view
    /// while content is stable (i.e. not due to new messages arriving).
    @State private var autoScrollEnabled = true
    /// Message count when the bottom anchor was last visible.
    /// Used to distinguish "content grew" from "user scrolled away".
    @State private var messageCountAtBottom = 0
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
                if !self.isNearBottom {
                    Button {
                        self.autoScrollEnabled = true
                        withAnimation {
                            proxy.scrollTo(SessionDetailView.bottomAnchorID, anchor: .bottom)
                        }
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
                }
            }
            .animation(.easeInOut(duration: 0.2), value: self.isNearBottom)
            .focusable()
            .focused(self.$isFocused)
            .onAppear {
                proxy.scrollTo(SessionDetailView.bottomAnchorID, anchor: .bottom)
                self.isFocused = true
            }
            .onChange(of: self.session.messages.count) {
                if self.autoScrollEnabled {
                    proxy.scrollTo(SessionDetailView.bottomAnchorID, anchor: .bottom)
                }
            }
            .onChange(of: self.session.forceScrollToBottomVersion) {
                proxy.scrollTo(SessionDetailView.bottomAnchorID, anchor: .bottom)
                self.isNearBottom = true
                self.autoScrollEnabled = true
            }
            .onKeyPress(.home) {
                if let firstId = session.messages.first?.id {
                    proxy.scrollTo(firstId, anchor: .top)
                }
                return .handled
            }
            .onKeyPress(.end) {
                self.autoScrollEnabled = true
                proxy.scrollTo(SessionDetailView.bottomAnchorID, anchor: .bottom)
                return .handled
            }
        }
    }

    static let bottomAnchorID = "session-bottom-anchor"
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
        .textSelection(.enabled)
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
            state.addSession(
                connectionId: UUID(),
                info: SessionInfoPayload(
                    command: "agent",
                    planId: 169,
                    planTitle: "Add WebSocket support",
                    workspacePath: "/Users/dev/projects/myapp",
                    gitRemote: nil,
                    terminal: nil))
            if let connId = state.sessions.first?.connectionId {
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
