import Foundation
import Observation
import UserNotifications

@MainActor
@Observable
final class SessionState {
    var sessions: [SessionItem] = []
    var selectedSessionId: UUID?
    private var pendingMessages: [UUID: [SessionMessage]] = [:]
    private var replayingConnections: Set<UUID> = []
    private var replayMessages: [UUID: [SessionMessage]] = [:]

    var selectedSession: SessionItem? {
        guard let id = selectedSessionId else { return nil }
        return self.sessions.first { $0.id == id }
    }

    func addSession(connectionId: UUID, info: SessionInfoPayload) {
        // If a session already exists for this connectionId, update its metadata
        if let existing = sessions.first(where: { $0.connectionId == connectionId }) {
            existing.command = info.command
            existing.planId = info.planId
            existing.planTitle = info.planTitle
            existing.workspacePath = info.workspacePath
            existing.gitRemote = info.gitRemote
            existing.terminal = info.terminal
            return
        }

        // Try to reconcile with a notification-only session (one created by ingestNotification
        // before the WebSocket session_info arrived). Notification-only sessions have an empty
        // command since real WebSocket sessions always provide one.
        if let notificationOnly = findNotificationOnlySession(info: info) {
            notificationOnly.connectionId = connectionId
            notificationOnly.command = info.command
            notificationOnly.planId = info.planId
            notificationOnly.planTitle = info.planTitle
            notificationOnly.workspacePath = info.workspacePath
            notificationOnly.gitRemote = info.gitRemote
            notificationOnly.terminal = info.terminal
            notificationOnly.isActive = true

            // Flush any messages that arrived before session_info
            if let buffered = pendingMessages.removeValue(forKey: connectionId) {
                notificationOnly.messages = buffered
            }

            if self.selectedSessionId == nil {
                self.selectedSessionId = notificationOnly.id
            }
            return
        }

        let session = SessionItem(
            id: UUID(),
            connectionId: connectionId,
            command: info.command,
            planId: info.planId,
            planTitle: info.planTitle,
            workspacePath: info.workspacePath,
            gitRemote: info.gitRemote,
            connectedAt: Date(),
            isActive: true,
            messages: [],
            terminal: info.terminal)

        // Flush any messages that arrived before session_info
        if let buffered = pendingMessages.removeValue(forKey: connectionId) {
            session.messages = buffered
        }

        self.sessions.insert(session, at: 0)
        if self.selectedSessionId == nil {
            self.selectedSessionId = session.id
        }
    }

    /// Find a notification-only session that matches the incoming session info.
    /// A notification-only session is identified by having an empty command (real WebSocket
    /// sessions always have a command from session_info).
    private func findNotificationOnlySession(info: SessionInfoPayload) -> SessionItem? {
        // Match by terminal pane ID first
        if let paneId = info.terminal?.paneId {
            // If the incoming session has a pane ID, only match by pane ID.
            // Do NOT fall back to workspace matching — that could incorrectly
            // reconcile with a notification-only session from a different pane.
            return self.sessions.first {
                $0.command.isEmpty && $0.terminal?.paneId == paneId
            }
        }

        // Only fall back to workspace path match when the incoming session has NO pane ID
        if let workspacePath = info.workspacePath, !workspacePath.isEmpty {
            return self.sessions.first { $0.command.isEmpty && $0.workspacePath == workspacePath }
        }

        return nil
    }

    func appendMessage(connectionId: UUID, message: SessionMessage) {
        if self.replayingConnections.contains(connectionId) {
            self.replayMessages[connectionId, default: []].append(message)
            return
        }

        guard let index = sessions.firstIndex(where: { $0.connectionId == connectionId }) else {
            // Buffer messages that arrive before session_info
            self.pendingMessages[connectionId, default: []].append(message)
            return
        }
        self.sessions[index].messages.append(message)
    }

    func ingestSessionMetadata(connectionId: UUID, tunnelMessage: TunnelMessage) {
        guard let index = sessions.firstIndex(where: { $0.connectionId == connectionId }) else {
            return
        }

        guard case let .structured(message) = tunnelMessage else {
            return
        }

        let extractedTitle: String?
        switch message {
        case let .planDiscovery(_, title, _):
            extractedTitle = title
        case let .executionSummary(payload):
            extractedTitle = payload.planTitle
        default:
            extractedTitle = nil
        }

        guard let extractedTitle else {
            return
        }

        let trimmedTitle = extractedTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else {
            return
        }

        self.sessions[index].planTitle = trimmedTitle
    }

    func startReplay(connectionId: UUID) {
        self.replayingConnections.insert(connectionId)
    }

    func endReplay(connectionId: UUID) {
        self.replayingConnections.remove(connectionId)

        guard let bufferedReplayMessages = replayMessages.removeValue(forKey: connectionId),
              !bufferedReplayMessages.isEmpty
        else {
            return
        }

        guard let index = sessions.firstIndex(where: { $0.connectionId == connectionId }) else {
            self.pendingMessages[connectionId, default: []].append(contentsOf: bufferedReplayMessages)
            return
        }

        self.sessions[index].messages.append(contentsOf: bufferedReplayMessages)
        self.sessions[index].forceScrollToBottomVersion += 1
    }

    func markDisconnected(connectionId: UUID) {
        // Clean up any pending messages for this connection
        self.pendingMessages.removeValue(forKey: connectionId)
        self.replayingConnections.remove(connectionId)
        self.replayMessages.removeValue(forKey: connectionId)
        guard let index = sessions.firstIndex(where: { $0.connectionId == connectionId }) else {
            return
        }
        self.sessions[index].isActive = false
    }

    func dismissSession(id: UUID) {
        guard let session = sessions.first(where: { $0.id == id }), !session.isActive else { return }
        self.sessions.removeAll { $0.id == id }
        if self.selectedSessionId == id {
            self.selectedSessionId = self.sessions.first?.id
        }
    }

    func dismissAllDisconnected() {
        let disconnectedIds = Set(sessions.filter { !$0.isActive }.map(\.id))
        guard !disconnectedIds.isEmpty else { return }
        self.sessions.removeAll { disconnectedIds.contains($0.id) }
        if let selectedId = selectedSessionId, disconnectedIds.contains(selectedId) {
            self.selectedSessionId = self.sessions.first?.id
        }
    }

    func ingestNotification(payload: MessagePayload) {
        // Try to match by terminal pane ID first, then fall back to workspace.
        var matchedSession: SessionItem?
        if let notificationPaneId = payload.terminal?.paneId {
            matchedSession = self.sessions.first { session in
                session.terminal?.paneId == notificationPaneId
            }
        }

        if matchedSession == nil, !payload.workspacePath.isEmpty {
            // Fall back to workspace path when pane lookup does not find a match.
            matchedSession = self.sessions.first { session in
                session.workspacePath == payload.workspacePath
            }
        }

        if let session = matchedSession {
            session.notificationMessage = payload.message
            // If this session is already selected, don't show the unread dot
            if session.id == self.selectedSessionId {
                session.hasUnreadNotification = false
            } else {
                session.hasUnreadNotification = true
            }
        } else {
            // Create a notification-only session
            let session = SessionItem(
                id: UUID(),
                connectionId: UUID(),
                command: "",
                planId: nil,
                planTitle: nil,
                workspacePath: payload.workspacePath,
                gitRemote: nil,
                connectedAt: Date(),
                isActive: false,
                messages: [],
                terminal: payload.terminal,
                hasUnreadNotification: true,
                notificationMessage: payload.message)
            self.sessions.insert(session, at: 0)
        }

        // Trigger macOS system notification
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

    func ingestNotification(connectionId: UUID, tunnelMessage: TunnelMessage) {
        guard let notificationText = notificationText(for: tunnelMessage) else { return }
        guard let session = sessions.first(where: { $0.connectionId == connectionId }) else { return }

        session.notificationMessage = notificationText
        if session.id == self.selectedSessionId {
            session.hasUnreadNotification = false
        } else {
            session.hasUnreadNotification = true
        }

        let content = UNMutableNotificationContent()
        content.title = "Tim"
        content.body = notificationText
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    func markNotificationRead(sessionId: UUID) {
        guard let session = sessions.first(where: { $0.id == sessionId }) else { return }
        session.hasUnreadNotification = false
    }

    private func notificationText(for tunnelMessage: TunnelMessage) -> String? {
        guard case let .structured(message) = tunnelMessage else { return nil }

        switch message {
        case let .agentSessionEnd(payload):
            let base = payload.success ? "Agent session finished" : "Agent session failed"
            if let summary = payload.summary?.trimmingCharacters(in: .whitespacesAndNewlines),
               !summary.isEmpty
            {
                return "\(base): \(summary)"
            }
            return base
        case let .inputRequired(prompt, _):
            if let prompt = prompt?.trimmingCharacters(in: .whitespacesAndNewlines), !prompt.isEmpty {
                return "Input required: \(prompt)"
            }
            return "Input required"
        default:
            return nil
        }
    }
}
