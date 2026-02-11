import Foundation
import Observation

@MainActor
@Observable
final class SessionState {
    var sessions: [SessionItem] = []
    var selectedSessionId: UUID?

    var selectedSession: SessionItem? {
        guard let id = selectedSessionId else { return nil }
        return sessions.first { $0.id == id }
    }

    func addSession(connectionId: UUID, info: SessionInfoPayload) {
        let session = SessionItem(
            id: UUID(),
            connectionId: connectionId,
            command: info.command,
            planId: info.planId,
            planTitle: info.planTitle,
            workspacePath: info.workspacePath,
            connectedAt: Date(),
            isActive: true,
            messages: []
        )
        sessions.insert(session, at: 0)
        if selectedSessionId == nil {
            selectedSessionId = session.id
        }
    }

    func appendMessage(connectionId: UUID, message: SessionMessage) {
        guard let index = sessions.firstIndex(where: { $0.connectionId == connectionId }) else {
            return
        }
        sessions[index].messages.append(message)
    }

    func markDisconnected(connectionId: UUID) {
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
