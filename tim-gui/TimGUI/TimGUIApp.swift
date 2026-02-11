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
    @State private var server: LocalHTTPServer?
    @State private var startError: String?

    var body: some Scene {
        WindowGroup {
            ContentView(appState: self.appState, startError: self.startError)
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
        let newServer = LocalHTTPServer(
            port: 8123,
            handler: { [weak appState] payload in
                appState?.ingest(payload)
            },
            wsHandler: { _ in
                // WebSocket events will be wired up when SessionState is added
            }
        )
        self.server = newServer
        do {
            try await newServer.start()
        } catch {
            self.startError = "Failed to start server: \(error.localizedDescription)"
        }
    }
}
