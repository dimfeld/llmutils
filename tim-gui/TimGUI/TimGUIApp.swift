import SwiftUI
import UserNotifications

@main
struct TimGUIApp: App {
    @State private var sessionState = SessionState()
    @State private var server: LocalHTTPServer?
    @State private var isStartingServer = false
    @State private var startError: String?
    @State private var serverPort: UInt16?

    var body: some Scene {
        WindowGroup {
            ContentView(
                sessionState: self.sessionState,
                startError: self.startError,
                serverPort: self.serverPort)
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
                    let message = MessageFormatter.format(
                        tunnelMessage: tunnelMessage, seq: seq)
                    sessionState.appendMessage(connectionId: connId, message: message)
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
            self.serverPort = newServer.boundPort
        } catch {
            self.startError = "Failed to start server: \(error.localizedDescription)"
        }
    }
}
