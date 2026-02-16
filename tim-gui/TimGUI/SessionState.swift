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
        return sessions.first { $0.id == id }
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

            if selectedSessionId == nil {
                selectedSessionId = notificationOnly.id
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
            terminal: info.terminal
        )

        // Flush any messages that arrived before session_info
        if let buffered = pendingMessages.removeValue(forKey: connectionId) {
            session.messages = buffered
        }

        sessions.insert(session, at: 0)
        if selectedSessionId == nil {
            selectedSessionId = session.id
        }
    }

    /// Find a notification-only session that matches the incoming session info.
    /// A notification-only session is identified by having an empty command (real WebSocket
    /// sessions always have a command from session_info).
    private func findNotificationOnlySession(info: SessionInfoPayload) -> SessionItem? {
        // Match by terminal pane ID first
        if let paneId = info.terminal?.paneId {
            if let match = sessions.first(where: {
                $0.command.isEmpty && $0.terminal?.paneId == paneId
            }) {
                return match
            }
        }

        // Fall back to workspace path match
        if let workspacePath = info.workspacePath, !workspacePath.isEmpty {
            return sessions.first { $0.command.isEmpty && $0.workspacePath == workspacePath }
        }

        return nil
    }

    func appendMessage(connectionId: UUID, message: SessionMessage) {
        if replayingConnections.contains(connectionId) {
            replayMessages[connectionId, default: []].append(message)
            return
        }

        guard let index = sessions.firstIndex(where: { $0.connectionId == connectionId }) else {
            // Buffer messages that arrive before session_info
            pendingMessages[connectionId, default: []].append(message)
            return
        }
        sessions[index].messages.append(message)
    }

    func startReplay(connectionId: UUID) {
        replayingConnections.insert(connectionId)
    }

    func endReplay(connectionId: UUID) {
        replayingConnections.remove(connectionId)

        guard let bufferedReplayMessages = replayMessages.removeValue(forKey: connectionId),
              !bufferedReplayMessages.isEmpty else {
            return
        }

        guard let index = sessions.firstIndex(where: { $0.connectionId == connectionId }) else {
            pendingMessages[connectionId, default: []].append(contentsOf: bufferedReplayMessages)
            return
        }

        sessions[index].messages.append(contentsOf: bufferedReplayMessages)
        sessions[index].forceScrollToBottomVersion += 1
    }

    func markDisconnected(connectionId: UUID) {
        // Clean up any pending messages for this connection
        pendingMessages.removeValue(forKey: connectionId)
        replayingConnections.remove(connectionId)
        replayMessages.removeValue(forKey: connectionId)
        guard let index = sessions.firstIndex(where: { $0.connectionId == connectionId }) else {
            return
        }
        sessions[index].isActive = false
    }

    func dismissSession(id: UUID) {
        guard let session = sessions.first(where: { $0.id == id }), !session.isActive else { return }
        sessions.removeAll { $0.id == id }
        if selectedSessionId == id {
            selectedSessionId = sessions.first?.id
        }
    }

    func dismissAllDisconnected() {
        let disconnectedIds = Set(sessions.filter { !$0.isActive }.map { $0.id })
        guard !disconnectedIds.isEmpty else { return }
        sessions.removeAll { disconnectedIds.contains($0.id) }
        if let selectedId = selectedSessionId, disconnectedIds.contains(selectedId) {
            selectedSessionId = sessions.first?.id
        }
    }

    func ingestNotification(payload: MessagePayload) {
        // Try to match by terminal pane ID first
        var matchedSession: SessionItem?
        if let notificationPaneId = payload.terminal?.paneId {
            matchedSession = sessions.first { session in
                session.terminal?.paneId == notificationPaneId
            }
            // When the notification has a pane ID but no existing session matches it,
            // skip workspace fallback and create a notification-only session. This avoids
            // incorrectly attaching to an older session for the same workspace path.
            // The notification-only session will be reconciled later when the real
            // session_info arrives with the matching pane ID via addSession().
        } else if !payload.workspacePath.isEmpty {
            // Only fall back to workspace path match when there is NO pane ID
            matchedSession = sessions.first { session in
                session.workspacePath == payload.workspacePath
            }
        }

        if let session = matchedSession {
            session.hasUnreadNotification = true
            session.notificationMessage = payload.message
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
                notificationMessage: payload.message
            )
            sessions.insert(session, at: 0)
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

    func markNotificationRead(sessionId: UUID) {
        guard let session = sessions.first(where: { $0.id == sessionId }) else { return }
        session.hasUnreadNotification = false
    }
}
