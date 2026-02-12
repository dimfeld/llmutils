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
    @State private var isNearBottom = true

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(session.messages) { message in
                        SessionMessageView(message: message)
                            .id(message.id)
                    }
                }
                .padding(12)
                .background(
                    GeometryReader { contentGeometry in
                        Color.clear
                            .preference(
                                key: ScrollOffsetPreferenceKey.self,
                                value: contentGeometry.frame(in: .named("sessionScroll"))
                            )
                    }
                )
            }
            .coordinateSpace(name: "sessionScroll")
            .onPreferenceChange(ScrollOffsetPreferenceKey.self) { contentFrame in
                // Content bottom relative to scroll view origin.
                // When near the bottom, contentFrame.maxY is close to the visible height.
                // We use a threshold to account for minor offsets.
                let threshold: CGFloat = 50
                isNearBottom = contentFrame.maxY <= contentFrame.height + threshold
            }
            .onAppear {
                if let lastId = session.messages.last?.id {
                    proxy.scrollTo(lastId, anchor: .bottom)
                }
            }
            .onChange(of: session.messages.count) {
                if isNearBottom, let lastId = session.messages.last?.id {
                    proxy.scrollTo(lastId, anchor: .bottom)
                }
            }
        }
    }
}

private struct ScrollOffsetPreferenceKey: PreferenceKey {
    nonisolated(unsafe) static var defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        value = nextValue()
    }
}

// MARK: - SessionMessageView

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

    private func weightForCategory(_ category: MessageCategory) -> Font.Weight {
        switch category {
        case .lifecycle: .bold
        default: .regular
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
                state.appendMessage(
                    connectionId: connId,
                    message: MessageFormatter.format(
                        tunnelMessage: .structured(
                            message: .agentSessionStart(AgentSessionStartPayload(
                                executor: "claude", mode: "agent", planId: 169,
                                sessionId: nil, threadId: nil, tools: nil,
                                mcpServers: nil, timestamp: nil
                            ))
                        ),
                        seq: 1
                    )
                )
                state.appendMessage(
                    connectionId: connId,
                    message: MessageFormatter.format(
                        tunnelMessage: .args(type: "log", args: ["Starting agent run..."]),
                        seq: 2
                    )
                )
                state.appendMessage(
                    connectionId: connId,
                    message: MessageFormatter.format(
                        tunnelMessage: .structured(
                            message: .llmToolUse(LlmToolUsePayload(
                                toolName: "Read", inputSummary: "src/main.ts",
                                input: nil, timestamp: nil
                            ))
                        ),
                        seq: 3
                    )
                )
            }
            return state
        }()
    )
}
