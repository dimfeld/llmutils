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
        gitRemote: String? = nil,
        terminal: TerminalPayload? = nil
    ) -> SessionInfoPayload {
        SessionInfoPayload(
            command: command,
            planId: planId,
            planTitle: planTitle,
            workspacePath: workspacePath,
            gitRemote: gitRemote,
            terminal: terminal
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
        #expect(session.gitRemote == "git@github.com:user/repo.git")
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
        #expect(session.gitRemote == nil)
    }

    // MARK: - Duplicate session_info handling

    @Test("Duplicate session_info updates metadata instead of creating a new session")
    func duplicateSessionInfoUpdatesMetadata() {
        let state = SessionState()
        let connId = UUID()

        // First session_info
        state.addSession(connectionId: connId, info: makeInfo(
            command: "agent",
            planId: 10,
            planTitle: "Original Plan",
            workspacePath: "/original/path",
            gitRemote: "git@github.com:user/repo.git"
        ))
        #expect(state.sessions.count == 1)
        let originalId = state.sessions[0].id
        let originalConnectedAt = state.sessions[0].connectedAt

        // Duplicate session_info with updated metadata
        state.addSession(connectionId: connId, info: makeInfo(
            command: "review",
            planId: 20,
            planTitle: "Updated Plan",
            workspacePath: "/updated/path",
            gitRemote: "git@github.com:user/other.git"
        ))

        // Should still be one session, not two
        #expect(state.sessions.count == 1)
        let session = state.sessions[0]
        // Identity preserved
        #expect(session.id == originalId)
        #expect(session.connectionId == connId)
        #expect(session.connectedAt == originalConnectedAt)
        // Metadata updated
        #expect(session.command == "review")
        #expect(session.planId == 20)
        #expect(session.planTitle == "Updated Plan")
        #expect(session.workspacePath == "/updated/path")
        #expect(session.gitRemote == "git@github.com:user/other.git")
    }

    @Test("Duplicate session_info preserves existing messages")
    func duplicateSessionInfoPreservesMessages() {
        let state = SessionState()
        let connId = UUID()

        state.addSession(connectionId: connId, info: makeInfo(command: "agent"))
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 1, text: "msg1"))
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 2, text: "msg2"))

        // Duplicate session_info
        state.addSession(connectionId: connId, info: makeInfo(command: "review"))

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].messages.count == 2)
        #expect(state.sessions[0].messages[0].text == "msg1")
        #expect(state.sessions[0].messages[1].text == "msg2")
    }

    @Test("Duplicate session_info does not change selection")
    func duplicateSessionInfoPreservesSelection() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()

        state.addSession(connectionId: connId1, info: makeInfo(command: "agent"))
        let selectedId = state.selectedSessionId!

        state.addSession(connectionId: connId2, info: makeInfo(command: "review"))

        // Duplicate session_info for connId1 — should not affect selection
        state.addSession(connectionId: connId1, info: makeInfo(command: "updated"))

        #expect(state.selectedSessionId == selectedId)
        #expect(state.sessions.count == 2)
    }

    @Test("Duplicate session_info preserves existing messages")
    func duplicateSessionInfoPreservesExistingMessages() {
        let state = SessionState()
        let connId = UUID()

        state.addSession(connectionId: connId, info: makeInfo(command: "agent"))
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 1, text: "msg1"))
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 2, text: "msg2"))

        // Duplicate session_info should not affect accumulated messages
        state.addSession(connectionId: connId, info: makeInfo(command: "review"))

        let session = state.sessions.first { $0.connectionId == connId }!
        #expect(session.messages.count == 2)
        #expect(session.messages[0].text == "msg1")
        #expect(session.messages[1].text == "msg2")
        #expect(session.command == "review")
    }

    @Test("Duplicate session_info keeps isActive unchanged")
    func duplicateSessionInfoKeepsIsActive() {
        let state = SessionState()
        let connId = UUID()

        state.addSession(connectionId: connId, info: makeInfo(command: "agent"))
        #expect(state.sessions[0].isActive == true)

        // Duplicate session_info should not change isActive
        state.addSession(connectionId: connId, info: makeInfo(command: "review"))
        #expect(state.sessions[0].isActive == true)
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

    @Test("appendMessage buffers messages for unknown connectionId (does not affect existing sessions)")
    func appendMessageUnknownConnection() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo())

        state.appendMessage(connectionId: UUID(), message: makeMessage(seq: 1, text: "orphan"))

        // Existing session should not be affected
        #expect(state.sessions[0].messages.isEmpty)
    }

    @Test("appendMessage buffers messages before session_info, addSession flushes them")
    func appendMessageBufferingAndFlush() {
        let state = SessionState()
        let connId = UUID()

        // Messages arrive before session_info
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 1, text: "early msg 1"))
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 2, text: "early msg 2"))

        // No sessions exist yet
        #expect(state.sessions.isEmpty)

        // Now session_info arrives
        state.addSession(connectionId: connId, info: makeInfo(command: "agent"))

        // Buffered messages should be flushed to the new session
        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].messages.count == 2)
        #expect(state.sessions[0].messages[0].text == "early msg 1")
        #expect(state.sessions[0].messages[1].text == "early msg 2")
    }

    @Test("appendMessage buffer is per-connection, messages go to correct sessions")
    func appendMessageBufferingPerConnection() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()

        // Buffer messages for two different connections
        state.appendMessage(connectionId: connId1, message: makeMessage(seq: 1, text: "conn1 early"))
        state.appendMessage(connectionId: connId2, message: makeMessage(seq: 1, text: "conn2 early"))

        // Register first session
        state.addSession(connectionId: connId1, info: makeInfo(command: "agent"))
        #expect(state.sessions[0].messages.count == 1)
        #expect(state.sessions[0].messages[0].text == "conn1 early")

        // Register second session
        state.addSession(connectionId: connId2, info: makeInfo(command: "review"))
        #expect(state.sessions[0].messages.count == 1)
        #expect(state.sessions[0].messages[0].text == "conn2 early")
    }

    @Test("appendMessage continues normally after buffered messages are flushed")
    func appendMessageAfterFlush() {
        let state = SessionState()
        let connId = UUID()

        // Buffer one message
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 1, text: "buffered"))

        // Register session (flushes buffer)
        state.addSession(connectionId: connId, info: makeInfo())

        // New messages append normally
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 2, text: "live msg"))

        #expect(state.sessions[0].messages.count == 2)
        #expect(state.sessions[0].messages[0].text == "buffered")
        #expect(state.sessions[0].messages[1].text == "live msg")
    }

    @Test("replay buffers messages and flushes them only on replay_end")
    func replayBuffersUntilEnd() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo())

        state.startReplay(connectionId: connId)
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 1, text: "replay 1"))
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 2, text: "replay 2"))

        // Messages should not be visible during replay.
        #expect(state.sessions[0].messages.isEmpty)
        #expect(state.sessions[0].forceScrollToBottomVersion == 0)

        state.endReplay(connectionId: connId)

        #expect(state.sessions[0].messages.count == 2)
        #expect(state.sessions[0].messages[0].text == "replay 1")
        #expect(state.sessions[0].messages[1].text == "replay 2")
        #expect(state.sessions[0].forceScrollToBottomVersion == 1)
    }

    @Test("messages after replay_end append normally")
    func replayThenLiveMessages() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo())

        state.startReplay(connectionId: connId)
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 1, text: "replay"))
        state.endReplay(connectionId: connId)

        state.appendMessage(connectionId: connId, message: makeMessage(seq: 2, text: "live"))

        #expect(state.sessions[0].messages.count == 2)
        #expect(state.sessions[0].messages[0].text == "replay")
        #expect(state.sessions[0].messages[1].text == "live")
        #expect(state.sessions[0].forceScrollToBottomVersion == 1)
    }

    @Test("markDisconnected during replay discards buffered replay messages")
    func replayBufferClearedOnDisconnect() {
        let state = SessionState()
        let connId = UUID()

        state.startReplay(connectionId: connId)
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 1, text: "replay orphan"))

        state.markDisconnected(connectionId: connId)
        state.addSession(connectionId: connId, info: makeInfo())
        state.endReplay(connectionId: connId)

        #expect(state.sessions[0].messages.isEmpty)
    }

    @Test("markDisconnected cleans up pending message buffer")
    func markDisconnectedCleansPendingBuffer() {
        let state = SessionState()
        let connId = UUID()

        // Buffer messages for a connection that never sends session_info
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 1, text: "orphan"))
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 2, text: "orphan 2"))

        // Disconnect without ever registering the session
        state.markDisconnected(connectionId: connId)

        // Now if addSession is called (shouldn't happen but test cleanup), buffer should be empty
        state.addSession(connectionId: connId, info: makeInfo())
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

    // MARK: - dismissAllDisconnected

    @Test("dismissAllDisconnected removes all inactive sessions and keeps active ones")
    func dismissAllDisconnectedRemovesInactive() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        let connId3 = UUID()
        state.addSession(connectionId: connId1, info: makeInfo(command: "first"))
        state.addSession(connectionId: connId2, info: makeInfo(command: "second"))
        state.addSession(connectionId: connId3, info: makeInfo(command: "third"))

        state.markDisconnected(connectionId: connId1)
        state.markDisconnected(connectionId: connId3)

        state.dismissAllDisconnected()

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].connectionId == connId2)
        #expect(state.sessions[0].isActive == true)
    }

    @Test("dismissAllDisconnected reselects when selected session is removed")
    func dismissAllDisconnectedReselects() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(connectionId: connId1, info: makeInfo(command: "first"))
        state.addSession(connectionId: connId2, info: makeInfo(command: "second"))

        // connId1 was auto-selected
        #expect(state.selectedSession?.connectionId == connId1)

        state.markDisconnected(connectionId: connId1)
        state.dismissAllDisconnected()

        #expect(state.sessions.count == 1)
        #expect(state.selectedSessionId == state.sessions[0].id)
        #expect(state.selectedSession?.connectionId == connId2)
    }

    @Test("dismissAllDisconnected sets selection to nil when all sessions removed")
    func dismissAllDisconnectedAllRemoved() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(connectionId: connId1, info: makeInfo(command: "first"))
        state.addSession(connectionId: connId2, info: makeInfo(command: "second"))

        state.markDisconnected(connectionId: connId1)
        state.markDisconnected(connectionId: connId2)

        state.dismissAllDisconnected()

        #expect(state.sessions.isEmpty)
        #expect(state.selectedSessionId == nil)
    }

    @Test("dismissAllDisconnected is a no-op when no disconnected sessions exist")
    func dismissAllDisconnectedNoop() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo(command: "agent"))

        state.dismissAllDisconnected()

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].connectionId == connId)
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

    // MARK: - Terminal info

    @Test("addSession populates terminal field from SessionInfoPayload")
    func addSessionPopulatesTerminal() {
        let state = SessionState()
        let connId = UUID()
        let terminal = TerminalPayload(type: "wezterm", paneId: "42")
        let info = makeInfo(
            command: "agent",
            workspacePath: "/tmp/project",
            terminal: terminal
        )

        state.addSession(connectionId: connId, info: info)

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].terminal?.type == "wezterm")
        #expect(state.sessions[0].terminal?.paneId == "42")
    }

    @Test("addSession with nil terminal sets terminal to nil")
    func addSessionNilTerminal() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: makeInfo(command: "agent"))

        #expect(state.sessions[0].terminal == nil)
    }

    @Test("Duplicate session_info updates terminal field")
    func duplicateSessionInfoUpdatesTerminal() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo(command: "agent"))
        #expect(state.sessions[0].terminal == nil)

        let terminal = TerminalPayload(type: "wezterm", paneId: "5")
        state.addSession(connectionId: connId, info: makeInfo(command: "agent", terminal: terminal))

        #expect(state.sessions[0].terminal?.type == "wezterm")
        #expect(state.sessions[0].terminal?.paneId == "5")
    }

    // MARK: - Notification properties

    @Test("SessionItem defaults hasUnreadNotification to false and notificationMessage to nil")
    func sessionItemNotificationDefaults() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: makeInfo(command: "agent"))

        #expect(state.sessions[0].hasUnreadNotification == false)
        #expect(state.sessions[0].notificationMessage == nil)
    }

    // MARK: - ingestNotification

    @Test("ingestNotification matches session by pane ID")
    func ingestNotificationMatchesByPaneId() {
        let state = SessionState()
        let terminal = TerminalPayload(type: "wezterm", paneId: "42")
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "agent",
            workspacePath: "/project/a",
            terminal: terminal
        ))
        // Deselect so we can verify the unread flag is set
        state.selectedSessionId = nil

        let payload = MessagePayload(
            message: "Task completed",
            workspacePath: "/project/a",
            terminal: TerminalPayload(type: "wezterm", paneId: "42")
        )
        state.ingestNotification(payload: payload)

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].hasUnreadNotification == true)
        #expect(state.sessions[0].notificationMessage == "Task completed")
    }

    @Test("ingestNotification matches session by workspace path when no pane match")
    func ingestNotificationMatchesByWorkspace() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "agent",
            workspacePath: "/project/b"
        ))
        // Deselect so we can verify the unread flag is set
        state.selectedSessionId = nil

        let payload = MessagePayload(
            message: "Done",
            workspacePath: "/project/b",
            terminal: nil
        )
        state.ingestNotification(payload: payload)

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].hasUnreadNotification == true)
        #expect(state.sessions[0].notificationMessage == "Done")
    }

    @Test("ingestNotification creates new session when no match found")
    func ingestNotificationCreatesNewSession() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "agent",
            workspacePath: "/project/a"
        ))

        let payload = MessagePayload(
            message: "Hello from unknown",
            workspacePath: "/project/c",
            terminal: TerminalPayload(type: "wezterm", paneId: "99")
        )
        state.ingestNotification(payload: payload)

        #expect(state.sessions.count == 2)
        // New session inserted at front
        let newSession = state.sessions[0]
        #expect(newSession.hasUnreadNotification == true)
        #expect(newSession.notificationMessage == "Hello from unknown")
        #expect(newSession.workspacePath == "/project/c")
        #expect(newSession.terminal?.paneId == "99")
        #expect(newSession.isActive == false)
        #expect(newSession.command == "")
    }

    @Test("ingestNotification with multiple sessions same workspace matches most recent (first)")
    func ingestNotificationMatchesMostRecent() {
        let state = SessionState()
        // Add two sessions with same workspace - second added is at index 0 (most recent)
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(connectionId: connId1, info: makeInfo(
            command: "agent",
            workspacePath: "/shared/project"
        ))
        state.addSession(connectionId: connId2, info: makeInfo(
            command: "review",
            workspacePath: "/shared/project"
        ))

        let payload = MessagePayload(
            message: "Notification",
            workspacePath: "/shared/project",
            terminal: nil
        )
        state.ingestNotification(payload: payload)

        // Should match the most recent (index 0, connId2)
        #expect(state.sessions[0].hasUnreadNotification == true)
        #expect(state.sessions[0].connectionId == connId2)
        // Older session should not be affected
        #expect(state.sessions[1].hasUnreadNotification == false)
    }

    @Test("ingestNotification prefers pane ID match over workspace match")
    func ingestNotificationPrefersPaneIdMatch() {
        let state = SessionState()
        // Session with matching workspace but no terminal
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "agent",
            workspacePath: "/project"
        ))
        // Session with matching pane ID but different workspace
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "review",
            workspacePath: "/other",
            terminal: TerminalPayload(type: "wezterm", paneId: "7")
        ))

        let payload = MessagePayload(
            message: "Matched by pane",
            workspacePath: "/project",
            terminal: TerminalPayload(type: "wezterm", paneId: "7")
        )
        state.ingestNotification(payload: payload)

        // Pane ID match (index 0, the review session) should be matched
        #expect(state.sessions[0].hasUnreadNotification == true)
        #expect(state.sessions[0].notificationMessage == "Matched by pane")
        // Workspace match session should not be affected
        #expect(state.sessions[1].hasUnreadNotification == false)
    }

    @Test("ingestNotification sets hasUnreadNotification on non-selected matched session")
    func ingestNotificationSetsFlag() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "agent",
            workspacePath: "/project"
        ))
        // Add a second session and select it so /project is not selected
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "review",
            workspacePath: "/other"
        ))
        state.selectedSessionId = state.sessions[0].id  // select /other
        let projectSession = state.sessions.first { $0.workspacePath == "/project" }!
        #expect(projectSession.hasUnreadNotification == false)

        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "/project",
            terminal: nil
        ))

        #expect(projectSession.hasUnreadNotification == true)
    }

    @Test("Second notification replaces message on same session")
    func ingestNotificationReplacesMessage() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "agent",
            workspacePath: "/project"
        ))
        // Deselect so we can verify the unread flag is set
        state.selectedSessionId = nil

        state.ingestNotification(payload: MessagePayload(
            message: "First notification",
            workspacePath: "/project",
            terminal: nil
        ))
        #expect(state.sessions[0].notificationMessage == "First notification")

        state.ingestNotification(payload: MessagePayload(
            message: "Second notification",
            workspacePath: "/project",
            terminal: nil
        ))
        #expect(state.sessions[0].notificationMessage == "Second notification")
        #expect(state.sessions[0].hasUnreadNotification == true)
    }

    @Test("ingestNotification with no terminal info matches by workspace only")
    func ingestNotificationNoTerminalMatchesByWorkspace() {
        let state = SessionState()
        let terminal = TerminalPayload(type: "wezterm", paneId: "5")
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "agent",
            workspacePath: "/project/x",
            terminal: terminal
        ))
        // Deselect so we can verify the unread flag is set
        state.selectedSessionId = nil

        // Notification has no terminal info - should still match by workspace
        state.ingestNotification(payload: MessagePayload(
            message: "Done",
            workspacePath: "/project/x",
            terminal: nil
        ))

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].hasUnreadNotification == true)
    }

    // MARK: - markNotificationRead

    @Test("markNotificationRead clears notification on session")
    func markNotificationReadClears() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "agent",
            workspacePath: "/project"
        ))
        // Deselect so the notification flag gets set
        state.selectedSessionId = nil
        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "/project",
            terminal: nil
        ))
        let sessionId = state.sessions[0].id
        #expect(state.sessions[0].hasUnreadNotification == true)

        state.markNotificationRead(sessionId: sessionId)

        #expect(state.sessions[0].hasUnreadNotification == false)
        #expect(state.sessions[0].notificationMessage == "Alert")
    }

    @Test("markNotificationRead is a no-op for unknown session ID")
    func markNotificationReadUnknownId() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: makeInfo(command: "agent"))

        // Should not crash or affect anything
        state.markNotificationRead(sessionId: UUID())

        #expect(state.sessions[0].hasUnreadNotification == false)
    }

    @Test("markNotificationRead only clears targeted session, not others")
    func markNotificationReadTargeted() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "agent",
            workspacePath: "/project/a"
        ))
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "review",
            workspacePath: "/project/b"
        ))
        // Deselect so both notifications set the unread flag
        state.selectedSessionId = nil

        // Send notifications to both sessions
        state.ingestNotification(payload: MessagePayload(
            message: "Alert A",
            workspacePath: "/project/a",
            terminal: nil
        ))
        state.ingestNotification(payload: MessagePayload(
            message: "Alert B",
            workspacePath: "/project/b",
            terminal: nil
        ))

        // Both should have notifications
        let sessionA = state.sessions.first { $0.workspacePath == "/project/a" }!
        let sessionB = state.sessions.first { $0.workspacePath == "/project/b" }!
        #expect(sessionA.hasUnreadNotification == true)
        #expect(sessionB.hasUnreadNotification == true)

        // Clear only session A
        state.markNotificationRead(sessionId: sessionA.id)

        #expect(sessionA.hasUnreadNotification == false)
        #expect(sessionA.notificationMessage == "Alert A")
        // Session B should still have its notification
        #expect(sessionB.hasUnreadNotification == true)
        #expect(sessionB.notificationMessage == "Alert B")
    }

    @Test("Notification for already-selected session does not set unread flag")
    func ingestNotificationForSelectedSessionClearsFlag() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "agent",
            workspacePath: "/project"
        ))
        // First session is auto-selected
        let sessionId = state.sessions[0].id
        #expect(state.selectedSessionId == sessionId)

        state.ingestNotification(payload: MessagePayload(
            message: "Done",
            workspacePath: "/project",
            terminal: nil
        ))

        // Message should be stored but unread flag should not be set
        #expect(state.sessions[0].notificationMessage == "Done")
        #expect(state.sessions[0].hasUnreadNotification == false)
    }

    @Test("Notification for non-selected session sets unread flag")
    func ingestNotificationForNonSelectedSession() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "agent",
            workspacePath: "/project/a"
        ))
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "review",
            workspacePath: "/project/b"
        ))
        // First added session (project/a) is auto-selected, project/b is not

        state.ingestNotification(payload: MessagePayload(
            message: "Alert B",
            workspacePath: "/project/b",
            terminal: nil
        ))

        let sessionB = state.sessions.first { $0.workspacePath == "/project/b" }!
        #expect(sessionB.hasUnreadNotification == true)
        #expect(sessionB.notificationMessage == "Alert B")
    }

    @Test("Second notification to notification-only session updates it rather than creating another")
    func ingestNotificationUpdatesNotificationOnlySession() {
        let state = SessionState()

        // First notification creates a notification-only session
        state.ingestNotification(payload: MessagePayload(
            message: "First alert",
            workspacePath: "/orphan/project",
            terminal: nil
        ))
        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].notificationMessage == "First alert")
        // Deselect so the second notification sets the unread flag
        state.selectedSessionId = nil

        // Second notification to same workspace should update, not create new
        state.ingestNotification(payload: MessagePayload(
            message: "Second alert",
            workspacePath: "/orphan/project",
            terminal: nil
        ))
        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].notificationMessage == "Second alert")
        #expect(state.sessions[0].hasUnreadNotification == true)
    }

    @Test("Notification-only session has nil planId, planTitle, gitRemote and empty command")
    func notificationOnlySessionProperties() {
        let state = SessionState()
        let terminal = TerminalPayload(type: "wezterm", paneId: "55")
        state.ingestNotification(payload: MessagePayload(
            message: "Notification",
            workspacePath: "/some/path",
            terminal: terminal
        ))

        #expect(state.sessions.count == 1)
        let session = state.sessions[0]
        #expect(session.command == "")
        #expect(session.planId == nil)
        #expect(session.planTitle == nil)
        #expect(session.gitRemote == nil)
        #expect(session.workspacePath == "/some/path")
        #expect(session.terminal?.type == "wezterm")
        #expect(session.terminal?.paneId == "55")
        #expect(session.isActive == false)
        #expect(session.hasUnreadNotification == true)
        #expect(session.notificationMessage == "Notification")
        #expect(session.messages.isEmpty)
    }

    @Test("dismissAllDisconnected removes notification-only sessions")
    func dismissAllDisconnectedRemovesNotificationOnlySessions() {
        let state = SessionState()
        // Create a notification-only session (no matching session)
        state.ingestNotification(payload: MessagePayload(
            message: "Orphan notification",
            workspacePath: "/orphan",
            terminal: nil
        ))
        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].isActive == false)

        state.dismissAllDisconnected()

        #expect(state.sessions.isEmpty)
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

    // MARK: - Reference semantics (SessionItem as class)

    @Test("SessionItem reference reflects mutations made through SessionState")
    func referenceSemanticsMutations() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo(command: "agent", planTitle: "Test Plan"))

        // Hold a reference to the session
        let sessionRef = state.sessions[0]
        #expect(sessionRef.isActive == true)
        #expect(sessionRef.messages.isEmpty)

        // Mutate through SessionState methods
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 1, text: "msg1"))
        state.markDisconnected(connectionId: connId)

        // The held reference should reflect the changes (class semantics)
        #expect(sessionRef.messages.count == 1)
        #expect(sessionRef.messages[0].text == "msg1")
        #expect(sessionRef.isActive == false)
    }

    @Test("selectedSession returns the same instance as sessions array element")
    func selectedSessionIdentity() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo(command: "agent"))

        let fromArray = state.sessions[0]
        let fromSelected = state.selectedSession

        // Both should be the exact same object (reference identity)
        #expect(fromArray === fromSelected)
    }

    @Test("Appending messages to SessionItem via reference is visible through SessionState")
    func referenceMessageAppend() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo())

        // Append multiple messages and verify the reference stays consistent
        for i in 1...5 {
            state.appendMessage(connectionId: connId, message: makeMessage(seq: i, text: "msg \(i)"))
        }

        let session = state.selectedSession!
        #expect(session.messages.count == 5)

        // Append more after getting the reference
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 6, text: "msg 6"))
        #expect(session.messages.count == 6)
        #expect(session.messages[5].text == "msg 6")
    }

    // MARK: - Notification-session reconciliation (race condition)

    @Test("Notification arrives first, then session_info with matching pane ID reconciles into one session")
    func reconcileNotificationThenSessionByPaneId() {
        let state = SessionState()
        let terminal = TerminalPayload(type: "wezterm", paneId: "42")

        // Notification arrives first (no WebSocket session yet)
        state.ingestNotification(payload: MessagePayload(
            message: "Task completed",
            workspacePath: "/project/a",
            terminal: terminal
        ))
        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].command == "")
        #expect(state.sessions[0].isActive == false)
        #expect(state.sessions[0].hasUnreadNotification == true)
        #expect(state.sessions[0].notificationMessage == "Task completed")
        let originalSessionId = state.sessions[0].id

        // Now WebSocket session_info arrives with matching pane ID
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo(
            command: "agent",
            planId: 10,
            planTitle: "My Plan",
            workspacePath: "/project/a",
            terminal: terminal
        ))

        // Should reconcile into a single session, not create a duplicate
        #expect(state.sessions.count == 1)
        let session = state.sessions[0]
        #expect(session.id == originalSessionId)
        #expect(session.connectionId == connId)
        #expect(session.command == "agent")
        #expect(session.planId == 10)
        #expect(session.planTitle == "My Plan")
        #expect(session.workspacePath == "/project/a")
        #expect(session.isActive == true)
        // Notification state preserved
        #expect(session.hasUnreadNotification == true)
        #expect(session.notificationMessage == "Task completed")
        #expect(session.terminal?.paneId == "42")
    }

    @Test("Notification arrives first, then session_info with matching workspace reconciles into one session")
    func reconcileNotificationThenSessionByWorkspace() {
        let state = SessionState()

        // Notification arrives first (no terminal info)
        state.ingestNotification(payload: MessagePayload(
            message: "Done",
            workspacePath: "/project/b",
            terminal: nil
        ))
        #expect(state.sessions.count == 1)
        let originalSessionId = state.sessions[0].id

        // WebSocket session_info arrives with matching workspace (no terminal)
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo(
            command: "review",
            workspacePath: "/project/b"
        ))

        // Should reconcile into one session
        #expect(state.sessions.count == 1)
        let session = state.sessions[0]
        #expect(session.id == originalSessionId)
        #expect(session.connectionId == connId)
        #expect(session.command == "review")
        #expect(session.isActive == true)
        #expect(session.hasUnreadNotification == true)
        #expect(session.notificationMessage == "Done")
    }

    @Test("After reconciliation, messages route correctly to the reconciled session")
    func reconcileSessionReceivesMessages() {
        let state = SessionState()
        let terminal = TerminalPayload(type: "wezterm", paneId: "7")

        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "/project",
            terminal: terminal
        ))

        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo(
            command: "agent",
            workspacePath: "/project",
            terminal: terminal
        ))

        // Messages should route to the reconciled session
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 1, text: "hello"))
        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].messages.count == 1)
        #expect(state.sessions[0].messages[0].text == "hello")
    }

    @Test("Reconciliation flushes buffered messages to the notification-only session")
    func reconcileFlushesBufferedMessages() {
        let state = SessionState()

        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "/project",
            terminal: nil
        ))

        let connId = UUID()
        // Messages arrive before session_info
        state.appendMessage(connectionId: connId, message: makeMessage(seq: 1, text: "early msg"))

        // session_info reconciles with the notification-only session
        state.addSession(connectionId: connId, info: makeInfo(
            command: "agent",
            workspacePath: "/project"
        ))

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].messages.count == 1)
        #expect(state.sessions[0].messages[0].text == "early msg")
        #expect(state.sessions[0].hasUnreadNotification == true)
    }

    @Test("Reconciliation does not match a real session (non-empty command)")
    func reconcileDoesNotMatchRealSession() {
        let state = SessionState()
        let terminal = TerminalPayload(type: "wezterm", paneId: "42")

        // Create a real session (not notification-only)
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "agent",
            workspacePath: "/project",
            terminal: terminal
        ))

        // A different WebSocket connection arrives with the same terminal
        let connId2 = UUID()
        state.addSession(connectionId: connId2, info: makeInfo(
            command: "review",
            workspacePath: "/project",
            terminal: terminal
        ))

        // Should create a second session (no reconciliation since the first isn't notification-only)
        #expect(state.sessions.count == 2)
    }

    // MARK: - Empty workspace path guard

    @Test("ingestNotification with empty workspacePath does not match sessions by workspace")
    func ingestNotificationEmptyWorkspaceNoMatch() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "agent",
            workspacePath: ""
        ))

        // Notification with empty workspacePath should NOT match the session with empty workspace
        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "",
            terminal: nil
        ))

        // Should create a new notification-only session, not match the existing one
        #expect(state.sessions.count == 2)
    }

    @Test("ingestNotification matches a disconnected session")
    func ingestNotificationMatchesDisconnectedSession() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo(
            command: "agent",
            workspacePath: "/project"
        ))
        state.markDisconnected(connectionId: connId)
        #expect(state.sessions[0].isActive == false)
        // Deselect so the notification flag gets set
        state.selectedSessionId = nil

        state.ingestNotification(payload: MessagePayload(
            message: "Post-disconnect alert",
            workspacePath: "/project",
            terminal: nil
        ))

        // Should match the disconnected session, not create a new one
        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].hasUnreadNotification == true)
        #expect(state.sessions[0].notificationMessage == "Post-disconnect alert")
    }

    @Test("Second notification to notification-only session matches by pane ID")
    func ingestNotificationUpdatesNotificationOnlyByPaneId() {
        let state = SessionState()
        let terminal = TerminalPayload(type: "wezterm", paneId: "33")

        state.ingestNotification(payload: MessagePayload(
            message: "First",
            workspacePath: "/project",
            terminal: terminal
        ))
        #expect(state.sessions.count == 1)

        // Second notification with same pane ID should match the existing notification-only session
        state.ingestNotification(payload: MessagePayload(
            message: "Second",
            workspacePath: "/project",
            terminal: terminal
        ))
        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].notificationMessage == "Second")
    }

    @Test("Notification-only session auto-selects when nothing is selected")
    func notificationOnlyAutoSelects() {
        let state = SessionState()
        #expect(state.selectedSessionId == nil)

        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "/project",
            terminal: nil
        ))
        // Notification-only session should be auto-selected when nothing was selected
        #expect(state.selectedSessionId == state.sessions[0].id)
    }

    @Test("Reconciliation preserves selection after notification-only auto-select")
    func reconcilePreservesAutoSelect() {
        let state = SessionState()
        #expect(state.selectedSessionId == nil)

        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "/project",
            terminal: nil
        ))
        let notifSessionId = state.sessions[0].id
        #expect(state.selectedSessionId == notifSessionId)

        let connId = UUID()
        state.addSession(connectionId: connId, info: makeInfo(
            command: "agent",
            workspacePath: "/project"
        ))

        // After reconciliation, the same session should still be selected
        #expect(state.selectedSessionId == notifSessionId)
        #expect(state.selectedSession?.command == "agent")
    }

    @Test("Notification with pane ID skips workspace fallback when older session has same workspace")
    func ingestNotificationPaneIdSkipsWorkspaceFallback() {
        let state = SessionState()

        // An older session exists for the same workspace but with a different (or no) pane ID
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "agent",
            workspacePath: "/project/a",
            terminal: TerminalPayload(type: "wezterm", paneId: "10")
        ))

        // Notification arrives with a NEW pane ID (e.g., a new run in a different pane)
        // No session has pane ID "42" yet
        state.ingestNotification(payload: MessagePayload(
            message: "Task done",
            workspacePath: "/project/a",
            terminal: TerminalPayload(type: "wezterm", paneId: "42")
        ))

        // Should create a notification-only session, NOT attach to the old session
        #expect(state.sessions.count == 2)
        let notificationSession = state.sessions[0]  // newest-first
        #expect(notificationSession.command == "")
        #expect(notificationSession.hasUnreadNotification == true)
        #expect(notificationSession.notificationMessage == "Task done")
        #expect(notificationSession.terminal?.paneId == "42")
        // The old session should NOT have the notification
        #expect(state.sessions[1].hasUnreadNotification == false)
        #expect(state.sessions[1].terminal?.paneId == "10")
    }

    @Test("Notification with pane ID creates notification-only session that reconciles with later session_info")
    func ingestNotificationPaneIdReconcilationAfterRaceCondition() {
        let state = SessionState()

        // An older session exists for the same workspace
        let oldConnId = UUID()
        state.addSession(connectionId: oldConnId, info: makeInfo(
            command: "agent",
            workspacePath: "/project/a",
            terminal: TerminalPayload(type: "wezterm", paneId: "10")
        ))
        state.markDisconnected(connectionId: oldConnId)

        // Notification for a new run arrives before its session_info
        let newPaneId = "42"
        state.ingestNotification(payload: MessagePayload(
            message: "New run done",
            workspacePath: "/project/a",
            terminal: TerminalPayload(type: "wezterm", paneId: newPaneId)
        ))

        // A notification-only session was created
        #expect(state.sessions.count == 2)
        let notifSession = state.sessions[0]
        #expect(notifSession.command == "")
        #expect(notifSession.hasUnreadNotification == true)
        let notifSessionId = notifSession.id

        // Now the real session_info arrives with the matching pane ID
        let newConnId = UUID()
        state.addSession(connectionId: newConnId, info: makeInfo(
            command: "review",
            workspacePath: "/project/a",
            terminal: TerminalPayload(type: "wezterm", paneId: newPaneId)
        ))

        // Should reconcile: still 2 sessions (old + reconciled), not 3
        #expect(state.sessions.count == 2)
        // The notification-only session should have been reconciled
        let reconciledSession = state.sessions.first { $0.id == notifSessionId }!
        #expect(reconciledSession.connectionId == newConnId)
        #expect(reconciledSession.command == "review")
        #expect(reconciledSession.isActive == true)
        #expect(reconciledSession.hasUnreadNotification == true)
        #expect(reconciledSession.notificationMessage == "New run done")
        #expect(reconciledSession.terminal?.paneId == newPaneId)
        // Old session should be unaffected
        let oldSession = state.sessions.first { $0.terminal?.paneId == "10" }!
        #expect(oldSession.hasUnreadNotification == false)
        #expect(oldSession.isActive == false)
    }

    @Test("Reconciliation does not match notification-only session with empty workspace by workspace path")
    func reconcileDoesNotMatchEmptyWorkspace() {
        let state = SessionState()

        // Create a notification-only session with no workspace
        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "",
            terminal: nil
        ))
        #expect(state.sessions.count == 1)

        // WebSocket session with empty workspace should NOT reconcile
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "agent",
            workspacePath: ""
        ))

        // Should create a new session (no reconciliation)
        #expect(state.sessions.count == 2)
    }

    // MARK: - Notification-only session dismiss and selection edge cases

    @Test("dismissSession removes a notification-only session")
    func dismissNotificationOnlySession() {
        let state = SessionState()
        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "/orphan",
            terminal: TerminalPayload(type: "wezterm", paneId: "99")
        ))
        #expect(state.sessions.count == 1)
        let sessionId = state.sessions[0].id
        #expect(state.sessions[0].isActive == false)

        state.dismissSession(id: sessionId)

        #expect(state.sessions.isEmpty)
        #expect(state.selectedSessionId == nil)
    }

    @Test("Second notification to auto-selected notification-only session does not set unread flag")
    func notificationOnlyAutoSelectedThenSecondNotification() {
        let state = SessionState()
        #expect(state.selectedSessionId == nil)

        // First notification creates a notification-only session and auto-selects it
        state.ingestNotification(payload: MessagePayload(
            message: "First",
            workspacePath: "/orphan",
            terminal: nil
        ))
        #expect(state.sessions.count == 1)
        let sessionId = state.sessions[0].id
        #expect(state.selectedSessionId == sessionId)

        // Second notification to the same session — it's already selected
        state.ingestNotification(payload: MessagePayload(
            message: "Second",
            workspacePath: "/orphan",
            terminal: nil
        ))

        // The session is still selected so hasUnreadNotification should be false
        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].notificationMessage == "Second")
        #expect(state.sessions[0].hasUnreadNotification == false)
    }

    @Test("Notification-only session does not auto-select when another session is already selected")
    func notificationOnlyNoAutoSelectWhenOtherSelected() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: makeInfo(
            command: "agent",
            workspacePath: "/project/a"
        ))
        let existingSessionId = state.selectedSessionId!

        // Create a notification-only session (no match)
        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "/orphan",
            terminal: nil
        ))

        // The existing session should still be selected
        #expect(state.selectedSessionId == existingSessionId)
        #expect(state.sessions.count == 2)
    }
}
