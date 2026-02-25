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
    var groupOrder: [String] = []
    private var pendingMessages: [UUID: [SessionMessage]] = [:]
    private var replayingConnections: Set<UUID> = []
    private var replayMessages: [UUID: [SessionMessage]] = [:]

    /// Groups sessions by project, ordered by `groupOrder`. Groups not in `groupOrder` are appended at the end.
    ///
    /// This is a computed property that iterates all sessions on every access. For typical session
    /// counts (<50), the recomputation cost is negligible. If session counts grow significantly,
    /// consider caching this as a stored property invalidated when `sessions` or `groupOrder` change.
    var groupedSessions: [SessionGroup] {
        var groups: [String: [SessionItem]] = [:]
        var seenOrder: [String] = []
        for session in self.sessions {
            let key = sessionGroupKey(gitRemote: session.gitRemote, workspacePath: session.workspacePath)
            if groups[key] == nil {
                seenOrder.append(key)
            }
            groups[key, default: []].append(session)
        }

        var result: [SessionGroup] = []
        var handled: Set<String> = []

        for key in self.groupOrder {
            guard let sessionList = groups[key], !sessionList.isEmpty else { continue }
            let displayName = parseProjectDisplayName(
                gitRemote: sessionList.first?.gitRemote,
                workspacePath: sessionList.first?.workspacePath)
            result.append(SessionGroup(id: key, displayName: displayName, sessions: sessionList))
            handled.insert(key)
        }

        // Append groups not in groupOrder, preserving their first-seen order
        for key in seenOrder where !handled.contains(key) {
            guard let sessionList = groups[key] else { continue }
            let displayName = parseProjectDisplayName(
                gitRemote: sessionList.first?.gitRemote,
                workspacePath: sessionList.first?.workspacePath)
            result.append(SessionGroup(id: key, displayName: displayName, sessions: sessionList))
        }

        return result
    }

    /// Returns the first session with an unread notification, in grouped display order.
    ///
    /// Iterates `groupedSessions` so that after a user reorders groups via drag, the bell
    /// button jumps to the topmost visible notification group rather than insertion order.
    var firstSessionWithNotification: SessionItem? {
        for group in self.groupedSessions {
            if let session = group.sessions.first(where: { $0.hasUnreadNotification }) {
                return session
            }
        }
        return nil
    }

    /// Reorders group display order by moving entries in `groupOrder`.
    ///
    /// Rebuilds the order from the current `groupedSessions` array before performing the move,
    /// so that indices provided by `.onMove` (which operate on `groupedSessions`) always align
    /// with the array being mutated — even when `groupedSessions` contains notification-only
    /// groups that are not yet tracked in `groupOrder`.
    func moveGroup(from: IndexSet, to: Int) {
        var order = self.groupedSessions.map(\.id)
        order.move(fromOffsets: from, toOffset: to)
        self.groupOrder = order
    }

    var selectedSession: SessionItem? {
        guard let id = selectedSessionId else { return nil }
        return self.sessions.first { $0.id == id }
    }

    func addSession(connectionId: UUID, info: SessionInfoPayload) {
        // If a session already exists for this connectionId, update its metadata
        if let existing = sessions.first(where: { $0.connectionId == connectionId }) {
            let oldKey = sessionGroupKey(gitRemote: existing.gitRemote, workspacePath: existing.workspacePath)
            existing.command = info.command
            existing.planId = info.planId
            existing.planTitle = info.planTitle
            existing.workspacePath = info.workspacePath
            existing.gitRemote = info.gitRemote
            existing.terminal = info.terminal
            let newKey = sessionGroupKey(gitRemote: info.gitRemote, workspacePath: info.workspacePath)
            if oldKey != newKey {
                // Remove old key if no other sessions still belong to it
                let oldKeyStillUsed = self.sessions.contains { s in
                    s.id != existing.id &&
                        sessionGroupKey(gitRemote: s.gitRemote, workspacePath: s.workspacePath) == oldKey
                }
                if !oldKeyStillUsed {
                    self.groupOrder.removeAll { $0 == oldKey }
                }
            }
            if !self.groupOrder.contains(newKey) { self.groupOrder.insert(newKey, at: 0) }
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
                if !buffered.isEmpty {
                    notificationOnly.lastMessageReceivedAt = Date()
                }
            }

            if self.selectedSessionId == nil {
                self.selectedSessionId = notificationOnly.id
            }
            let key = sessionGroupKey(gitRemote: info.gitRemote, workspacePath: info.workspacePath)
            if !self.groupOrder.contains(key) { self.groupOrder.insert(key, at: 0) }
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
            if !buffered.isEmpty {
                session.lastMessageReceivedAt = Date()
            }
        }

        self.sessions.insert(session, at: 0)
        if self.selectedSessionId == nil {
            self.selectedSessionId = session.id
        }
        let key = sessionGroupKey(gitRemote: info.gitRemote, workspacePath: info.workspacePath)
        if !self.groupOrder.contains(key) { self.groupOrder.insert(key, at: 0) }
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
        self.sessions[index].lastMessageReceivedAt = Date()
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
        self.sessions[index].lastMessageReceivedAt = Date()
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
        session.lastMessageReceivedAt = Date()

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
        let activeKeys = Set(sessions.map { sessionGroupKey(gitRemote: $0.gitRemote, workspacePath: $0.workspacePath) })
        self.groupOrder.removeAll { !activeKeys.contains($0) }
    }

    func dismissAllDisconnected() {
        let disconnectedIds = Set(sessions.filter { !$0.isActive }.map(\.id))
        guard !disconnectedIds.isEmpty else { return }
        self.sessions.removeAll { disconnectedIds.contains($0.id) }
        if let selectedId = selectedSessionId, disconnectedIds.contains(selectedId) {
            self.selectedSessionId = self.sessions.first?.id
        }
        let activeKeys = Set(sessions.map { sessionGroupKey(gitRemote: $0.gitRemote, workspacePath: $0.workspacePath) })
        self.groupOrder.removeAll { !activeKeys.contains($0) }
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
            session.lastMessageReceivedAt = Date()
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
                lastMessageReceivedAt: Date(),
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
        session.lastMessageReceivedAt = Date()

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
        case let .promptRequest(prompt):
            let message = prompt.promptConfig.message.trimmingCharacters(in: .whitespacesAndNewlines)
            if !message.isEmpty {
                return "Prompt (\(prompt.promptType)): \(message)"
            }
            return "Prompt (\(prompt.promptType))"
        default:
            return nil
        }
    }
}
