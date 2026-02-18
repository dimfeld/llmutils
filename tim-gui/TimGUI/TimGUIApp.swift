import SwiftUI
import UserNotifications

@main
struct TimGUIApp: App {
    @State private var sessionState = SessionState()
    @State private var server: LocalHTTPServer?
    @State private var isStartingServer = false
    @State private var startError: String?

    var body: some Scene {
        WindowGroup {
            ContentView(
                sessionState: self.sessionState,
                startError: self.startError)
                .task {
                    UNUserNotificationCenter.current().requestAuthorization(
                        options: [.alert, .sound]) { _, _ in }
                    await self.startServerIfNeeded()
                }
        }
    }

    @MainActor
    private func startServerIfNeeded() async {
        guard self.server == nil, !self.isStartingServer else { return }
        self.isStartingServer = true
        defer { self.isStartingServer = false }
        let sessionState = self.sessionState
        let newServer = LocalHTTPServer(
            port: 8123,
            handler: { payload in
                sessionState.ingestNotification(payload: payload)
            },
            wsHandler: { event in
                switch event {
                case let .sessionInfo(connId, info):
                    sessionState.addSession(connectionId: connId, info: info)
                case let .output(connId, seq, tunnelMessage):
                    sessionState.ingestNotification(connectionId: connId, tunnelMessage: tunnelMessage)
                    sessionState.ingestSessionMetadata(connectionId: connId, tunnelMessage: tunnelMessage)
                    // Suppress only GUI-originated user_terminal_input echo because
                    // sendUserInput() already appends a local "You" message.
                    if case .structured(message: .userTerminalInput(_, .gui?, _)) = tunnelMessage {
                        break
                    }
                    let message = MessageFormatter.format(
                        tunnelMessage: tunnelMessage, seq: seq)
                    sessionState.appendMessage(connectionId: connId, message: message)

                    // Track active prompts for interactive prompt UI.
                    // Replay safety is handled inside the SessionState methods.
                    if case let .structured(message: structuredMsg) = tunnelMessage {
                        switch structuredMsg {
                        case let .promptRequest(payload):
                            sessionState.setActivePrompt(connectionId: connId, prompt: payload)
                        case let .promptAnswered(payload):
                            sessionState.clearActivePrompt(connectionId: connId, requestId: payload.requestId)
                        default:
                            break
                        }
                    }
                case let .replayStart(connId):
                    sessionState.startReplay(connectionId: connId)
                case let .replayEnd(connId):
                    sessionState.endReplay(connectionId: connId)
                case let .disconnected(connId):
                    sessionState.markDisconnected(connectionId: connId)
                }
            })
        do {
            try await newServer.start()
            self.startError = nil
            self.server = newServer
            sessionState.sendMessageHandler = { [weak newServer] connectionId, message in
                guard let server = newServer else { throw SendError.noServer }
                let data = try JSONEncoder().encode(message)
                let text = String(data: data, encoding: .utf8)!
                try await server.sendMessage(to: connectionId, text: text)
            }
        } catch {
            self.startError = "Failed to start server: \(error.localizedDescription)"
        }
    }
}
