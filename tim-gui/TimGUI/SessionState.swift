import Foundation
import Observation

@MainActor
@Observable
final class SessionState {
    var sessions: [SessionItem] = []
    var selectedSessionId: UUID?
    private var pendingMessages: [UUID: [SessionMessage]] = [:]

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
            messages: []
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
        guard let index = sessions.firstIndex(where: { $0.connectionId == connectionId }) else {
            // Buffer messages that arrive before session_info
            pendingMessages[connectionId, default: []].append(message)
            return
        }
        sessions[index].messages.append(message)
    }

    func markDisconnected(connectionId: UUID) {
        // Clean up any pending messages for this connection
        pendingMessages.removeValue(forKey: connectionId)
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
}
