import SwiftUI

struct ContentView: View {
    @Bindable var sessionState: SessionState
    let startError: String?
    let serverPort: UInt16?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()

                if let port = serverPort, startError == nil {
                    Text("Listening on port \(String(port))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(12)

            if let startError {
                Text(startError)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 16)
            }

            SessionsView(sessionState: self.sessionState)
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
        startError: nil,
        serverPort: 8123)
}
