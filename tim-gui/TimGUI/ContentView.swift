import AppKit
import SwiftUI
import Observation

struct ContentView: View {
    @Bindable var appState: AppState
    let startError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("tim-gui")
                    .font(.title2)
                Text("Listening on http://127.0.0.1:8123/messages")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .padding(16)

            if let startError {
                Text(startError)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 16)
            }

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(appState.items) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.message)
                                .font(.headline)
                            Text(item.workspacePath)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            Text(item.receivedAt, style: .time)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            if let terminal = item.terminal {
                                activateTerminalPane(terminal)
                            }
                        }
                        Divider()
                    }
                }
            }
        }
        .frame(minWidth: 520, minHeight: 360)
    }

    private func activateTerminalPane(_ terminal: TerminalPayload) {
        guard terminal.type == "wezterm" else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/wezterm")
        process.arguments = ["cli", "activate-pane", "--pane-id", terminal.paneId]
        try? process.run()

        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.github.wez.wezterm").first {
            app.activate()
        }
    }
}

#Preview {
    ContentView(
        appState: {
            let state = AppState()
            state.ingest(.init(
                message: "Example message",
                workspacePath: "/tmp/example",
                terminal: TerminalPayload(type: "wezterm", paneId: "42")
            ))
            return state
        }(),
        startError: nil
    )
}
