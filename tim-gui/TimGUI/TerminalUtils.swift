import AppKit
import Foundation

/// Activates the WezTerm pane associated with the given terminal payload.
/// Switches to the correct workspace, activates the pane, and brings WezTerm to the front.
@MainActor
func activateTerminalPane(_ terminal: TerminalPayload) {
    guard terminal.type == "wezterm" else { return }
    let weztermPath = "/opt/homebrew/bin/wezterm"

    let paneId = terminal.paneId
    Task {
        print("[workspace-switch] Looking up pane \(paneId)")

        let listProcess = Process()
        let listPipe = Pipe()
        listProcess.executableURL = URL(fileURLWithPath: weztermPath)
        listProcess.arguments = ["cli", "list", "--format", "json"]
        listProcess.standardOutput = listPipe

        do {
            try await waitForProcess(listProcess)
        } catch {
            print("[workspace-switch] Failed to launch wezterm list: \(error as Error)")
            // Close the write end so any reader won't block
            listPipe.fileHandleForWriting.closeFile()
            return
        }

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
            print(
                "[workspace-switch] No workspace for pane \(paneId): \(pane["workspace"] ?? "nil")"
            )
            return
        }

        let argsObj: [String: String] = ["workspace": workspaceName]
        guard let argsData = try? JSONSerialization.data(withJSONObject: argsObj),
              let args = String(data: argsData, encoding: .utf8) else {
            print("[workspace-switch] Failed to serialize workspace JSON")
            return
        }
        let encodedArgs = Data(args.utf8).base64EncodedString()
        print("[workspace-switch] workspace=\(workspaceName) encodedArgs=\(encodedArgs)")

        let sendProcess = Process()
        sendProcess.executableURL = URL(fileURLWithPath: weztermPath)
        sendProcess.arguments = [
            "cli", "spawn",
            "--", "/bin/sh", "-c",
            "printf '\\033]1337;SetUserVar=switch-workspace=\(encodedArgs)\\007' && sleep 0.1",
        ]
        print("[workspace-switch] Running: \(sendProcess.arguments!.joined(separator: " "))")
        try? await waitForProcess(sendProcess)
        print("[workspace-switch] Exit code: \(sendProcess.terminationStatus)")

        let activateProcess = Process()
        activateProcess.executableURL = URL(fileURLWithPath: weztermPath)
        activateProcess.arguments = ["cli", "activate-pane", "--pane-id", terminal.paneId]
        try? activateProcess.run()
    }

    if let app = NSRunningApplication.runningApplications(withBundleIdentifier:
        "com.github.wez.wezterm").first
    {
        app.activate()
    }
}

/// Runs a Process and waits for it to terminate without blocking a cooperative thread.
/// Sets the termination handler before calling run() to avoid a race condition.
/// Uses an atomic flag to prevent double-resume if the process terminates
/// before run() returns and run() also throws.
/// Throws if the process fails to launch.
func waitForProcess(_ process: Process) async throws {
    try await withCheckedThrowingContinuation { continuation in
        let guard_ = ThrowingResumeGuard(continuation: continuation)

        process.terminationHandler = { _ in
            guard_.resumeOnce()
        }
        do {
            try process.run()
        } catch {
            guard_.resumeOnce(throwing: error)
        }
    }
}

/// Thread-safe guard that ensures a CheckedContinuation is resumed exactly once.
/// Supports both success and failure resumption for process launch scenarios.
final class ThrowingResumeGuard: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false
    private let continuation: CheckedContinuation<Void, Error>

    init(continuation: CheckedContinuation<Void, Error>) {
        self.continuation = continuation
    }

    func resumeOnce() {
        lock.lock()
        let alreadyResumed = resumed
        resumed = true
        lock.unlock()
        if !alreadyResumed {
            continuation.resume()
        }
    }

    func resumeOnce(throwing error: Error) {
        lock.lock()
        let alreadyResumed = resumed
        resumed = true
        lock.unlock()
        if !alreadyResumed {
            continuation.resume(throwing: error)
        }
    }
}
