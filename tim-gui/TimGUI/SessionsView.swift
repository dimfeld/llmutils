import SwiftUI

// MARK: - SessionsView

struct SessionsView: View {
    @Bindable var sessionState: SessionState

    var body: some View {
        NavigationSplitView {
            SessionListView(sessionState: sessionState)
                .navigationSplitViewColumnWidth(min: 200, ideal: 280, max: 400)
        } detail: {
            if let session = sessionState.selectedSession {
                SessionDetailView(session: session)
                    .id(session.id)
            } else {
                ContentUnavailableView(
                    "No Session Selected",
                    systemImage: "rectangle.split.2x1",
                    description: Text("Select a session from the sidebar to view its output.")
                )
            }
        }
    }
}

// MARK: - SessionListView

struct SessionListView: View {
    @Bindable var sessionState: SessionState

    var body: some View {
        if sessionState.sessions.isEmpty {
            ContentUnavailableView(
                "No Sessions",
                systemImage: "antenna.radiowaves.left.and.right",
                description: Text("Sessions will appear here when tim processes connect.")
            )
        } else {
            List(sessionState.sessions, selection: $sessionState.selectedSessionId) { session in
                SessionRowView(
                    session: session,
                    onDismiss: { sessionState.dismissSession(id: session.id) }
                )
            }
        }
    }
}

// MARK: - SessionRowView

struct SessionRowView: View {
    let session: SessionItem
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(session.isActive ? .green : .gray)
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(session.workspacePath ?? "Unknown workspace")
                    .font(.headline)
                    .lineLimit(1)

                Text(session.planTitle ?? session.command)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                Text(session.connectedAt, style: .time)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if !session.isActive {
                Button(action: onDismiss) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Dismiss session")
            }
        }
        .padding(.vertical, 2)
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

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(session.messages) { message in
                        SessionMessageView(message: message)
                            .id(message.id)
                    }

                    Color.clear
                        .frame(height: 1)
                        .id(SessionDetailView.bottomAnchorID)
                        .onAppear {
                            isNearBottom = true
                            autoScrollEnabled = true
                            messageCountAtBottom = session.messages.count
                        }
                        .onDisappear {
                            isNearBottom = false
                            // Only disable auto-scroll if content hasn't changed,
                            // meaning the user scrolled away rather than new
                            // messages pushing the bottom out of view.
                            if session.messages.count == messageCountAtBottom {
                                autoScrollEnabled = false
                            }
                        }
                }
                .padding(12)
                .padding(.bottom, 20)
            }
            .overlay(alignment: .bottomTrailing) {
                if !isNearBottom {
                    Button {
                        autoScrollEnabled = true
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
            .animation(.easeInOut(duration: 0.2), value: isNearBottom)
            .onAppear {
                proxy.scrollTo(SessionDetailView.bottomAnchorID, anchor: .bottom)
            }
            .onChange(of: session.messages.count) {
                if autoScrollEnabled {
                    proxy.scrollTo(SessionDetailView.bottomAnchorID, anchor: .bottom)
                }
            }
            .onChange(of: session.forceScrollToBottomVersion) {
                proxy.scrollTo(SessionDetailView.bottomAnchorID, anchor: .bottom)
                isNearBottom = true
                autoScrollEnabled = true
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
                headerView(title)
            }
            if let body = message.body {
                bodyView(body)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func headerView(_ title: String) -> some View {
        HStack {
            Text(title)
                .font(.headline)
                .foregroundStyle(colorForCategory(message.category))
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
        case .text(let text):
            Text(text)
                .font(.body)
                .foregroundStyle(colorForCategory(message.category))

        case .monospaced(let text):
            Text(text)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(colorForCategory(message.category))

        case .todoList(let items):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(spacing: 6) {
                        Image(systemName: iconForTodoStatus(item.status))
                            .foregroundStyle(colorForTodoStatus(item.status))
                            .font(.body)
                        Text(item.label)
                            .font(.body)
                            .foregroundStyle(colorForCategory(message.category))
                    }
                }
            }

        case .fileChanges(let items):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(spacing: 6) {
                        Text(indicatorForFileChange(item.kind))
                            .font(.system(.body, design: .monospaced))
                            .foregroundStyle(colorForFileChange(item.kind))
                            .frame(width: 14, alignment: .center)
                        Text(item.path)
                            .font(.system(.body, design: .monospaced))
                            .foregroundStyle(colorForCategory(message.category))
                    }
                }
            }

        case .keyValuePairs(let pairs):
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
                    gitRemote: nil
                )
            )
            if let connId = state.sessions.first?.connectionId {
                let ts = "2026-02-13T00:30:00.000Z"
                var seq = 0
                func nextSeq() -> Int { seq += 1; return seq }

                state.appendMessage(
                    connectionId: connId,
                    message: MessageFormatter.format(
                        tunnelMessage: .structured(
                            message: .agentSessionStart(AgentSessionStartPayload(
                                executor: "claude", mode: "agent", planId: 169,
                                sessionId: nil, threadId: nil, tools: nil,
                                mcpServers: nil, timestamp: ts
                            ))
                        ),
                        seq: nextSeq()
                    )
                )
                state.appendMessage(
                    connectionId: connId,
                    message: MessageFormatter.format(
                        tunnelMessage: .structured(
                            message: .llmResponse(
                                text: "I'll start by reading the project structure to understand how the WebSocket module should integrate with the existing codebase.",
                                isUserRequest: false, timestamp: ts
                            )
                        ),
                        seq: nextSeq()
                    )
                )
                state.appendMessage(
                    connectionId: connId,
                    message: MessageFormatter.format(
                        tunnelMessage: .structured(
                            message: .llmToolUse(LlmToolUsePayload(
                                toolName: "Read", inputSummary: "src/main.ts",
                                input: nil, timestamp: ts
                            ))
                        ),
                        seq: nextSeq()
                    )
                )
                state.appendMessage(
                    connectionId: connId,
                    message: MessageFormatter.format(
                        tunnelMessage: .structured(
                            message: .commandResult(CommandResultPayload(
                                command: "npm test", cwd: "/Users/dev/projects/myapp",
                                exitCode: 0, stdout: "All 42 tests passed\nTest Suites: 8 passed",
                                stderr: nil, timestamp: ts
                            ))
                        ),
                        seq: nextSeq()
                    )
                )
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
                            ], timestamp: ts)
                        ),
                        seq: nextSeq()
                    )
                )
                state.appendMessage(
                    connectionId: connId,
                    message: MessageFormatter.format(
                        tunnelMessage: .structured(
                            message: .fileChangeSummary(changes: [
                                FileChangeItem(path: "src/websocket/server.ts", kind: "added"),
                                FileChangeItem(path: "src/websocket/handlers.ts", kind: "added"),
                                FileChangeItem(path: "src/main.ts", kind: "updated"),
                                FileChangeItem(path: "src/old-polling.ts", kind: "removed"),
                            ], timestamp: ts)
                        ),
                        seq: nextSeq()
                    )
                )
            }
            return state
        }()
    )
}
