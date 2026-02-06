import SwiftUI
import Observation

@MainActor
@Observable
final class AppState {
    var items: [MessageItem] = []

    func ingest(_ payload: MessagePayload) {
        items.removeAll { $0.workspacePath == payload.workspacePath }
        let item = MessageItem(
            message: payload.message,
            workspacePath: payload.workspacePath,
            terminal: payload.terminal,
            receivedAt: Date()
        )
        items.insert(item, at: 0)
    }
}

@main
struct TimGUIApp: App {
    @State private var appState = AppState()
    @State private var server: LocalHTTPServer?
    @State private var startError: String?

    var body: some Scene {
        WindowGroup {
            ContentView(appState: appState, startError: startError)
                .task {
                    await startServerIfNeeded()
                }
        }
    }

    @MainActor
    private func startServerIfNeeded() async {
        guard server == nil else { return }
        let newServer = LocalHTTPServer(port: 8123) { [weak appState] payload in
            appState?.ingest(payload)
        }
        server = newServer
        do {
            try await newServer.start()
        } catch {
            startError = "Failed to start server: \(error.localizedDescription)"
        }
    }
}
