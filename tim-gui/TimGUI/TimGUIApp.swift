import Observation
import SwiftUI

@MainActor
@Observable
final class AppState {
    var items: [MessageItem] = []

    func ingest(_ payload: MessagePayload) {
        self.items.removeAll { $0.workspacePath == payload.workspacePath }
        let item = MessageItem(
            message: payload.message,
            workspacePath: payload.workspacePath,
            terminal: payload.terminal,
            receivedAt: Date())
        self.items.insert(item, at: 0)
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
                    await self.startServerIfNeeded()
                }
        }
    }

    @MainActor
    private func startServerIfNeeded() async {
        guard self.server == nil else { return }
        let newServer = LocalHTTPServer(port: 8123) { [weak appState] payload in
            appState?.ingest(payload)
        }
        self.server = newServer
        do {
            try await newServer.start()
        } catch {
            self.startError = "Failed to start server: \(error.localizedDescription)"
        }
    }
}
