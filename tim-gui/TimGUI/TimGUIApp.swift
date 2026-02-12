import Observation
import SwiftUI
import UserNotifications

@MainActor
@Observable
final class AppState {
    var items: [MessageItem] = []

    func markRead(_ id: UUID) {
        if let index = self.items.firstIndex(where: { $0.id == id }) {
            self.items[index].isRead = true
        }
    }

    func ingest(_ payload: MessagePayload) {
        self.items.removeAll { $0.workspacePath == payload.workspacePath }
        let item = MessageItem(
            message: payload.message,
            workspacePath: payload.workspacePath,
            terminal: payload.terminal,
            receivedAt: Date())
        self.items.insert(item, at: 0)

        let content = UNMutableNotificationContent()
        content.title = "Tim"
        content.body = payload.message
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}

@main
struct TimGUIApp: App {
    @State private var appState = AppState()
    @State private var sessionState = SessionState()
    @State private var server: LocalHTTPServer?
    @State private var startError: String?
    @State private var serverPort: UInt16?

    var body: some Scene {
        WindowGroup {
            ContentView(
                appState: self.appState,
                sessionState: self.sessionState,
                startError: self.startError,
                serverPort: self.serverPort
            )
            .task {
                UNUserNotificationCenter.current().requestAuthorization(
                    options: [.alert, .sound]) { _, _ in }
                await self.startServerIfNeeded()
            }
        }
    }

    @MainActor
    private func startServerIfNeeded() async {
        guard self.server == nil else { return }
        let appState = self.appState
        let sessionState = self.sessionState
        let newServer = LocalHTTPServer(
            port: 8123,
            handler: { payload in
                appState.ingest(payload)
            },
            wsHandler: { event in
                switch event {
                case .sessionInfo(let connId, let info):
                    sessionState.addSession(connectionId: connId, info: info)
                case .output(let connId, let seq, let tunnelMessage):
                    let message = MessageFormatter.format(
                        tunnelMessage: tunnelMessage, seq: seq)
                    sessionState.appendMessage(connectionId: connId, message: message)
                case .replayStart, .replayEnd:
                    break
                case .disconnected(let connId):
                    sessionState.markDisconnected(connectionId: connId)
                }
            }
        )
        do {
            try await newServer.start()
            self.server = newServer
            self.serverPort = newServer.boundPort
        } catch {
            self.startError = "Failed to start server: \(error.localizedDescription)"
        }
    }
}
