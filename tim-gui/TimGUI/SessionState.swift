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
        }

        // Fall back to workspace path match (first match wins, sessions are newest-first)
        if matchedSession == nil {
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
        session.notificationMessage = nil
    }
}
