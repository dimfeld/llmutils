import SwiftUI

struct ContentView: View {
    @Bindable var sessionState: SessionState
    let startError: String?

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color.black.opacity(0.08), Color.black.opacity(0.02)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                if let startError {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                        Text(startError)
                            .lineLimit(2)
                    }
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                    .padding(12)
                }

                SessionsView(sessionState: self.sessionState)
            }
        }
        .frame(minWidth: 800, minHeight: 400)
    }
}

#Preview {
    ContentView(
        sessionState: {
            let state = SessionState()
            state.addSession(connectionId: UUID(), info: SessionInfoPayload(
                command: "agent",
                planId: 42,
                planTitle: "Example plan",
                workspacePath: "/tmp/workspace",
                gitRemote: nil,
                terminal: nil))
            if let connId = state.sessions.first?.connectionId {
                state.appendMessage(connectionId: connId, message: MessageFormatter.format(
                    tunnelMessage: .structured(message: .agentSessionStart(AgentSessionStartPayload(
                        executor: "claude-code", mode: nil, planId: nil,
                        sessionId: nil, threadId: nil, tools: nil,
                        mcpServers: nil, timestamp: nil))),
                    seq: 1))
                state.appendMessage(connectionId: connId, message: SessionMessage(
                    seq: 2, text: "Working on task...", category: .progress))
            }
            return state
        }(),
        startError: nil)
}
