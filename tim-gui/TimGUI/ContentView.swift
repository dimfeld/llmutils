import AppKit
import SwiftUI
import Observation

struct ContentView: View {
    @Bindable var appState: AppState
    let startError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: "Listening on http://127.0.0.1:8123/messages")
                .font(.callout)
                .foregroundStyle(.secondary)
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
        let weztermPath = "/opt/homebrew/bin/wezterm"

        let paneId = terminal.paneId
        Task.detached {
            print("[workspace-switch] Looking up pane \(paneId)")

            let listProcess = Process()
            let listPipe = Pipe()
            listProcess.executableURL = URL(fileURLWithPath: weztermPath)
            listProcess.arguments = ["cli", "list", "--format", "json"]
            listProcess.standardOutput = listPipe
            try? listProcess.run()
            listProcess.waitUntilExit()

            let data = listPipe.fileHandleForReading.readDataToEndOfFile()
            guard let panes = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                print("[workspace-switch] Failed to parse JSON from wezterm cli list")
                return
            }

            guard let paneIdNum = Int(paneId) else {
                print("[workspace-switch] Invalid pane ID: \(paneId)")
                return
            }

            guard let pane = panes.first(where: { ($0["pane_id"] as? Int) == paneIdNum }) else {
                print("[workspace-switch] Pane \(paneId) not found in \(panes.count) panes")
                return
            }

            guard let workspaceName = pane["workspace"] as? String, !workspaceName.isEmpty else {
                print("[workspace-switch] No workspace for pane \(paneId): \(pane["workspace"] ?? "nil")")
                return
            }

            let args = "{\"workspace\":\"\(workspaceName)\"}"
            let encodedArgs = Data(args.utf8).base64EncodedString()
            print("[workspace-switch] workspace=\(workspaceName) encodedArgs=\(encodedArgs)")

            let sendProcess = Process()
            sendProcess.executableURL = URL(fileURLWithPath: weztermPath)
            sendProcess.arguments = [
                "cli", "spawn", 
                // The sleep gives time for wezterm to process the escape sequence. Otherwise it doesn't take effect.
                "--", "/bin/sh", "-c", "printf '\\033]1337;SetUserVar=switch-workspace=\(encodedArgs)\\007' && sleep 0.1"
            ]
            print("[workspace-switch] Running: \(sendProcess.arguments!.joined(separator: " "))")
            try? sendProcess.run()
            sendProcess.waitUntilExit()
            print("[workspace-switch] Exit code: \(sendProcess.terminationStatus)")

            let activateProcess = Process()
            activateProcess.executableURL = URL(fileURLWithPath: weztermPath)
            activateProcess.arguments = ["cli", "activate-pane", "--pane-id", terminal.paneId]
            try? activateProcess.run()
        }

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
