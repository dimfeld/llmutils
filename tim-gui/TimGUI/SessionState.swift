import Foundation
import Observation
import UserNotifications

enum SendError: Error, LocalizedError {
    case noHandler
    case noServer

    var errorDescription: String? {
        switch self {
        case .noHandler:
            "No message handler available"
        case .noServer:
            "Server is not available"
        }
    }
}

@MainActor
@Observable
final class SessionState {
    var sessions: [SessionItem] = []
    var selectedSessionId: UUID?
    var sendMessageHandler: ((UUID, OutgoingMessage) async throws -> Void)?
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

    private func findWorkspaceSessionWithoutPaneId(workspacePath: String) -> SessionItem? {
        self.sessions.first { session in
            session.workspacePath == workspacePath && session.terminal?.paneId == nil
        }
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

        let extractedTitle: String? = switch message {
        case let .planDiscovery(_, title, _):
            title
        case let .executionSummary(payload):
            payload.planTitle
        default:
            nil
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

    func setActivePrompt(connectionId: UUID, prompt: PromptRequestPayload) {
        guard !self.replayingConnections.contains(connectionId) else { return }
        guard let session = sessions.first(where: { $0.connectionId == connectionId }) else { return }
        session.pendingPrompt = prompt
    }

    func clearActivePrompt(connectionId: UUID, requestId: String) {
        guard !self.replayingConnections.contains(connectionId) else { return }
        guard let session = sessions.first(where: { $0.connectionId == connectionId }) else { return }
        guard session.pendingPrompt?.requestId == requestId else { return }
        session.pendingPrompt = nil
    }

    func sendPromptResponse(sessionId: UUID, requestId: String, value: PromptResponseValue) async throws {
        guard let session = sessions.first(where: { $0.id == sessionId }) else { return }
        guard session.isActive else { return }
        guard let handler = self.sendMessageHandler else {
            throw SendError.noHandler
        }
        try await handler(session.connectionId, .promptResponse(requestId: requestId, value: value))
        if session.pendingPrompt?.requestId == requestId {
            session.pendingPrompt = nil
        }
    }

    func markDisconnected(connectionId: UUID) {
        // Clean up any pending messages for this connection
        self.pendingMessages.removeValue(forKey: connectionId)
        self.replayingConnections.remove(connectionId)
        self.replayMessages.removeValue(forKey: connectionId)
        guard let index = sessions.firstIndex(where: { $0.connectionId == connectionId }) else {
            return
        }
        let session = self.sessions[index]
        session.isActive = false
        session.pendingPrompt = nil

        let notificationText = "Agent session disconnected"
        session.notificationMessage = notificationText
        session.hasUnreadNotification = true

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

    func sendUserInput(sessionId: UUID, content: String) async throws {
        guard let session = sessions.first(where: { $0.id == sessionId }) else { return }
        guard session.isActive else { return }
        guard let handler = self.sendMessageHandler else {
            throw SendError.noHandler
        }
        try await handler(session.connectionId, .userInput(content: content))
        let message = SessionMessage(
            seq: session.messages.count + 1,
            title: "You",
            body: .text(content),
            category: .userInput,
            timestamp: Date())
        session.messages.append(message)
    }

    func ingestNotification(payload: MessagePayload) {
        // If the notification has a pane ID, only match sessions for that same pane.
        // Otherwise (no pane ID), match by workspace path.
        var matchedSession: SessionItem?
        if let notificationPaneId = payload.terminal?.paneId {
            matchedSession = self.sessions.first { session in
                session.terminal?.paneId == notificationPaneId
            }
        } else if !payload.workspacePath.isEmpty {
            matchedSession = self.sessions.first { session in
                session.workspacePath == payload.workspacePath
            }
        }

        if let session = matchedSession {
            session.notificationMessage = payload.message
            session.hasUnreadNotification = true
        } else {
            let workspaceTemplate = payload.workspacePath.isEmpty
                ? nil
                : self.findWorkspaceSessionWithoutPaneId(workspacePath: payload.workspacePath)

            // Create a notification-only session
            let session = SessionItem(
                id: UUID(),
                connectionId: UUID(),
                command: "",
                planId: workspaceTemplate?.planId,
                planTitle: workspaceTemplate?.planTitle,
                workspacePath: payload.workspacePath,
                gitRemote: workspaceTemplate?.gitRemote,
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
        session.hasUnreadNotification = true

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

    func handleSessionListItemTap(sessionId: UUID) {
        guard let session = sessions.first(where: { $0.id == sessionId }) else { return }

        if self.selectedSessionId == sessionId {
            if session.hasUnreadNotification {
                self.markNotificationRead(sessionId: sessionId)
            }
            return
        }

        self.selectedSessionId = sessionId
        if session.hasUnreadNotification {
            self.markNotificationRead(sessionId: sessionId)
        }
    }

    func handleTerminalIconTap(sessionId: UUID) {
        guard let session = sessions.first(where: { $0.id == sessionId }) else { return }
        if session.hasUnreadNotification {
            self.markNotificationRead(sessionId: sessionId)
        }
    }

    private func notificationText(for tunnelMessage: TunnelMessage) -> String? {
        guard case let .structured(message) = tunnelMessage else { return nil }

        switch message {
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
