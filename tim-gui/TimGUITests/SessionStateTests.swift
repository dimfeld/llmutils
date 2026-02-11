import Foundation
import Testing

@testable import TimGUI

@Suite("SessionState", .serialized)
@MainActor
struct SessionStateTests {
    // MARK: - Helpers

    private func makeInfo(
        command: String = "agent",
        planId: Int? = nil,
        planTitle: String? = nil,
        workspacePath: String? = nil,
        gitRemote: String? = nil
    ) -> SessionInfoPayload {
        SessionInfoPayload(
            command: command,
            planId: planId,
            planTitle: planTitle,
            workspacePath: workspacePath,
            gitRemote: gitRemote
        )
    }

    private func makeMessage(seq: Int = 1, text: String = "hello", category: MessageCategory = .log)
        -> SessionMessage
    {
        SessionMessage(seq: seq, text: text, category: category)
    }

    // MARK: - addSession

    @Test("addSession creates a session with correct properties from SessionInfoPayload")
    func addSessionProperties() {
        let state = SessionState()
        let connId = UUID()
        let info = makeInfo(
            command: "agent",
            planId: 42,
            planTitle: "My Plan",
            workspacePath: "/projects/test",
            gitRemote: "git@github.com:user/repo.git"
        )

        state.addSession(connectionId: connId, info: info)

        #expect(state.sessions.count == 1)
        let session = state.sessions[0]
        #expect(session.connectionId == connId)
        #expect(session.command == "agent")
        #expect(session.planId == 42)
        #expect(session.planTitle == "My Plan")
        #expect(session.workspacePath == "/projects/test")
        #expect(session.isActive == true)
        #expect(session.messages.isEmpty)
    }

    @Test("addSession inserts at index 0 (newest first)")
    func addSessionInsertsAtFront() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()

        state.addSession(connectionId: connId1, info: makeInfo(command: "agent"))
        state.addSession(connectionId: connId2, info: makeInfo(command: "review"))

        #expect(state.sessions.count == 2)
        #expect(state.sessions[0].connectionId == connId2)
        #expect(state.sessions[0].command == "review")
        #expect(state.sessions[1].connectionId == connId1)
        #expect(state.sessions[1].command == "agent")
    }

    @Test("addSession auto-selects first session if nothing is selected")
    func addSessionAutoSelects() {
        let state = SessionState()
        #expect(state.selectedSessionId == nil)

        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo())

        #expect(state.selectedSessionId == state.sessions[0].id)
    }

    @Test("addSession does NOT change selection if something is already selected")
    func addSessionPreservesSelection() {
        let state = SessionState()
        let connId1 = UUID()
        state.addSession(connectionId: connId1, info: makeInfo(command: "agent"))
        let firstSessionId = state.selectedSessionId!

        let connId2 = UUID()
        state.addSession(connectionId: connId2, info: makeInfo(command: "review"))

        #expect(state.selectedSessionId == firstSessionId)
        // Verify the first session is still selected, not the newly added one
        #expect(state.sessions[0].connectionId == connId2)
        #expect(state.selectedSessionId != state.sessions[0].id)
    }

    @Test("addSession with minimal info sets optional fields to nil")
    func addSessionMinimalInfo() {
        let state = SessionState()
        let info = makeInfo(command: "review")

        state.addSession(connectionId: UUID(), info: info)

        let session = state.sessions[0]
        #expect(session.command == "review")
        #expect(session.planId == nil)
        #expect(session.planTitle == nil)
        #expect(session.workspacePath == nil)
    }

    // MARK: - appendMessage

    @Test("appendMessage adds message to the correct session by connectionId")
    func appendMessageCorrectSession() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(connectionId: connId1, info: makeInfo(command: "first"))
        state.addSession(connectionId: connId2, info: makeInfo(command: "second"))

        let msg = makeMessage(seq: 1, text: "hello world", category: .llmOutput)
        state.appendMessage(connectionId: connId1, message: msg)

        // connId2 is at index 0 (newest first), connId1 is at index 1
        #expect(state.sessions[1].messages.count == 1)
        #expect(state.sessions[1].messages[0].text == "hello world")
        #expect(state.sessions[1].messages[0].category == .llmOutput)
        // Other session should have no messages
        #expect(state.sessions[0].messages.isEmpty)
    }

    @Test("appendMessage appends multiple messages in order")
    func appendMessageOrder() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo())

        state.appendMessage(connectionId: connId, message: makeMessage(seq: 1, text: "first"))
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 2, text: "second"))
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 3, text: "third"))

        #expect(state.sessions[0].messages.count == 3)
        #expect(state.sessions[0].messages[0].text == "first")
        #expect(state.sessions[0].messages[1].text == "second")
        #expect(state.sessions[0].messages[2].text == "third")
    }

    @Test("appendMessage is a no-op for unknown connectionId")
    func appendMessageUnknownConnection() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo())

        state.appendMessage(connectionId: UUID(), message: makeMessage(seq: 1, text: "orphan"))

        #expect(state.sessions[0].messages.isEmpty)
    }

    // MARK: - markDisconnected

    @Test("markDisconnected sets isActive to false")
    func markDisconnectedSetsInactive() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo())
        #expect(state.sessions[0].isActive == true)

        state.markDisconnected(connectionId: connId)

        #expect(state.sessions[0].isActive == false)
    }

    @Test("markDisconnected only affects the targeted session")
    func markDisconnectedTargeted() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(connectionId: connId1, info: makeInfo())
        state.addSession(connectionId: connId2, info: makeInfo())

        state.markDisconnected(connectionId: connId1)

        // connId2 at index 0, connId1 at index 1
        #expect(state.sessions[0].isActive == true)
        #expect(state.sessions[1].isActive == false)
    }

    @Test("markDisconnected is a no-op for unknown connectionId")
    func markDisconnectedUnknownConnection() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo())

        state.markDisconnected(connectionId: UUID())

        #expect(state.sessions[0].isActive == true)
    }

    // MARK: - dismissSession

    @Test("dismissSession removes a closed session from the list")
    func dismissSessionRemoves() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo())
        let sessionId = state.sessions[0].id
        state.markDisconnected(connectionId: connId)

        state.dismissSession(id: sessionId)

        #expect(state.sessions.isEmpty)
    }

    @Test("dismissSession is a no-op for an active session")
    func dismissSessionActiveSessionNoop() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo())
        let sessionId = state.sessions[0].id
        #expect(state.sessions[0].isActive == true)

        state.dismissSession(id: sessionId)

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].id == sessionId)
    }

    @Test("dismissSession reselects first session if dismissed session was selected")
    func dismissSessionReselects() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(connectionId: connId1, info: makeInfo(command: "first"))
        state.addSession(connectionId: connId2, info: makeInfo(command: "second"))

        // First session added was auto-selected; it's now at index 1
        let selectedId = state.selectedSessionId!
        #expect(state.sessions[1].id == selectedId)

        // Mark disconnected before dismissing
        state.markDisconnected(connectionId: connId1)
        state.dismissSession(id: selectedId)

        // Should reselect the remaining session (connId2, now the only one)
        #expect(state.sessions.count == 1)
        #expect(state.selectedSessionId == state.sessions[0].id)
    }

    @Test("dismissSession does not change selection if a different session was dismissed")
    func dismissSessionPreservesSelection() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(connectionId: connId1, info: makeInfo(command: "first"))
        let firstSessionId = state.selectedSessionId!

        state.addSession(connectionId: connId2, info: makeInfo(command: "second"))
        let secondSessionId = state.sessions[0].id

        // First session is still selected
        #expect(state.selectedSessionId == firstSessionId)

        // Mark second session disconnected before dismissing
        state.markDisconnected(connectionId: connId2)
        state.dismissSession(id: secondSessionId)

        #expect(state.sessions.count == 1)
        #expect(state.selectedSessionId == firstSessionId)
    }

    @Test("dismissSession sets selectedSessionId to nil when last session is dismissed")
    func dismissSessionLastSession() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo())
        let sessionId = state.sessions[0].id
        state.markDisconnected(connectionId: connId)

        state.dismissSession(id: sessionId)

        #expect(state.sessions.isEmpty)
        #expect(state.selectedSessionId == nil)
    }

    @Test("dismissSession is a no-op for unknown session ID")
    func dismissSessionUnknownId() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: makeInfo())
        let originalCount = state.sessions.count

        state.dismissSession(id: UUID())

        #expect(state.sessions.count == originalCount)
    }

    // MARK: - selectedSession computed property

    @Test("selectedSession returns the correct session when one is selected")
    func selectedSessionReturnsCorrect() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(connectionId: connId1, info: makeInfo(command: "first"))
        state.addSession(connectionId: connId2, info: makeInfo(command: "second"))

        // First session was auto-selected
        let selected = state.selectedSession
        #expect(selected != nil)
        #expect(selected?.connectionId == connId1)
        #expect(selected?.command == "first")
    }

    @Test("selectedSession returns nil when nothing is selected")
    func selectedSessionReturnsNil() {
        let state = SessionState()

        #expect(state.selectedSession == nil)
    }

    @Test("selectedSession returns nil after selectedSessionId is set to an invalid ID")
    func selectedSessionInvalidId() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: makeInfo())
        state.selectedSessionId = UUID()  // Set to a non-existent session ID

        #expect(state.selectedSession == nil)
    }

    @Test("selectedSession updates when selection changes")
    func selectedSessionUpdatesOnSelectionChange() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(connectionId: connId1, info: makeInfo(command: "first"))
        state.addSession(connectionId: connId2, info: makeInfo(command: "second"))

        // Initially first session is selected
        #expect(state.selectedSession?.connectionId == connId1)

        // Switch selection to second session
        state.selectedSessionId = state.sessions[0].id
        #expect(state.selectedSession?.connectionId == connId2)
    }

    // MARK: - Integration scenarios

    @Test("Full lifecycle: add, message, disconnect, dismiss")
    func fullLifecycle() {
        let state = SessionState()
        let connId = UUID()
        let info = makeInfo(
            command: "agent", planId: 10, planTitle: "Build feature",
            workspacePath: "/home/user/project")

        // Connect
        state.addSession(connectionId: connId, info: info)
        #expect(state.sessions.count == 1)
        #expect(state.selectedSession?.command == "agent")

        // Receive messages
        state.appendMessage(
            connectionId: connId, message: makeMessage(seq: 1, text: "Starting...", category: .lifecycle))
        state.appendMessage(
            connectionId: connId,
            message: makeMessage(seq: 2, text: "Thinking about the problem", category: .llmOutput))
        state.appendMessage(
            connectionId: connId,
            message: makeMessage(seq: 3, text: "Edit: main.swift", category: .fileChange))
        #expect(state.sessions[0].messages.count == 3)

        // Disconnect
        state.markDisconnected(connectionId: connId)
        #expect(state.sessions[0].isActive == false)
        #expect(state.sessions[0].messages.count == 3)  // Messages preserved

        // Dismiss
        let sessionId = state.sessions[0].id
        state.dismissSession(id: sessionId)
        #expect(state.sessions.isEmpty)
        #expect(state.selectedSessionId == nil)
    }

    @Test("Multiple sessions: messages go to correct sessions")
    func multipleSessionsMessageRouting() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        let connId3 = UUID()
        state.addSession(connectionId: connId1, info: makeInfo(command: "agent"))
        state.addSession(connectionId: connId2, info: makeInfo(command: "review"))
        state.addSession(connectionId: connId3, info: makeInfo(command: "codex"))

        state.appendMessage(connectionId: connId2, message: makeMessage(seq: 1, text: "review msg"))
        state.appendMessage(connectionId: connId1, message: makeMessage(seq: 1, text: "agent msg"))
        state.appendMessage(connectionId: connId3, message: makeMessage(seq: 1, text: "codex msg"))
        state.appendMessage(connectionId: connId2, message: makeMessage(seq: 2, text: "review msg 2"))

        // Sessions are in reverse order: connId3 at 0, connId2 at 1, connId1 at 2
        #expect(state.sessions[2].messages.count == 1)
        #expect(state.sessions[2].messages[0].text == "agent msg")
        #expect(state.sessions[1].messages.count == 2)
        #expect(state.sessions[1].messages[0].text == "review msg")
        #expect(state.sessions[1].messages[1].text == "review msg 2")
        #expect(state.sessions[0].messages.count == 1)
        #expect(state.sessions[0].messages[0].text == "codex msg")
    }
}
