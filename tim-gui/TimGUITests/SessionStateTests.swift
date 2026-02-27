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
        terminal: TerminalPayload? = nil) -> SessionInfoPayload
    {
        SessionInfoPayload(
            command: command,
            planId: planId,
            planTitle: planTitle,
            workspacePath: workspacePath,
            gitRemote: gitRemote,
            terminal: terminal)
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
        let info = self.makeInfo(
            command: "agent",
            planId: 42,
            planTitle: "My Plan",
            workspacePath: "/projects/test",
            gitRemote: "git@github.com:user/repo.git")

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

        state.addSession(connectionId: connId1, info: self.makeInfo(command: "agent"))
        state.addSession(connectionId: connId2, info: self.makeInfo(command: "review"))

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
        state.addSession(connectionId: connId, info: self.makeInfo())

        #expect(state.selectedSessionId == state.sessions[0].id)
    }

    @Test("addSession does NOT change selection if something is already selected")
    func addSessionPreservesSelection() throws {
        let state = SessionState()
        let connId1 = UUID()
        state.addSession(connectionId: connId1, info: self.makeInfo(command: "agent"))
        let firstSessionId = try #require(state.selectedSessionId)

        let connId2 = UUID()
        state.addSession(connectionId: connId2, info: self.makeInfo(command: "review"))

        #expect(state.selectedSessionId == firstSessionId)
        // Verify the first session is still selected, not the newly added one
        #expect(state.sessions[0].connectionId == connId2)
        #expect(state.selectedSessionId != state.sessions[0].id)
    }

    @Test("addSession with minimal info sets optional fields to nil")
    func addSessionMinimalInfo() {
        let state = SessionState()
        let info = self.makeInfo(command: "review")

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
        state.addSession(connectionId: connId, info: self.makeInfo(
            command: "agent",
            planId: 10,
            planTitle: "Original Plan",
            workspacePath: "/original/path",
            gitRemote: "git@github.com:user/repo.git"))
        #expect(state.sessions.count == 1)
        let originalId = state.sessions[0].id
        let originalConnectedAt = state.sessions[0].connectedAt

        // Duplicate session_info with updated metadata
        state.addSession(connectionId: connId, info: self.makeInfo(
            command: "review",
            planId: 20,
            planTitle: "Updated Plan",
            workspacePath: "/updated/path",
            gitRemote: "git@github.com:user/other.git"))

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

        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 1, text: "msg1"))
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 2, text: "msg2"))

        // Duplicate session_info
        state.addSession(connectionId: connId, info: self.makeInfo(command: "review"))

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].messages.count == 2)
        #expect(state.sessions[0].messages[0].text == "msg1")
        #expect(state.sessions[0].messages[1].text == "msg2")
    }

    @Test("Duplicate session_info does not change selection")
    func duplicateSessionInfoPreservesSelection() throws {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()

        state.addSession(connectionId: connId1, info: self.makeInfo(command: "agent"))
        let selectedId = try #require(state.selectedSessionId)

        state.addSession(connectionId: connId2, info: self.makeInfo(command: "review"))

        // Duplicate session_info for connId1 — should not affect selection
        state.addSession(connectionId: connId1, info: self.makeInfo(command: "updated"))

        #expect(state.selectedSessionId == selectedId)
        #expect(state.sessions.count == 2)
    }

    @Test("Duplicate session_info preserves existing messages")
    func duplicateSessionInfoPreservesExistingMessages() throws {
        let state = SessionState()
        let connId = UUID()

        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 1, text: "msg1"))
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 2, text: "msg2"))

        // Duplicate session_info should not affect accumulated messages
        state.addSession(connectionId: connId, info: self.makeInfo(command: "review"))

        let session = try #require(state.sessions.first { $0.connectionId == connId })
        #expect(session.messages.count == 2)
        #expect(session.messages[0].text == "msg1")
        #expect(session.messages[1].text == "msg2")
        #expect(session.command == "review")
    }

    @Test("Duplicate session_info keeps isActive unchanged")
    func duplicateSessionInfoKeepsIsActive() {
        let state = SessionState()
        let connId = UUID()

        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        #expect(state.sessions[0].isActive == true)

        // Duplicate session_info should not change isActive
        state.addSession(connectionId: connId, info: self.makeInfo(command: "review"))
        #expect(state.sessions[0].isActive == true)
    }

    // MARK: - appendMessage

    @Test("appendMessage adds message to the correct session by connectionId")
    func appendMessageCorrectSession() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(connectionId: connId1, info: self.makeInfo(command: "first"))
        state.addSession(connectionId: connId2, info: self.makeInfo(command: "second"))

        let msg = self.makeMessage(seq: 1, text: "hello world", category: .llmOutput)
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
        state.addSession(connectionId: connId, info: self.makeInfo())

        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 1, text: "first"))
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 2, text: "second"))
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 3, text: "third"))

        #expect(state.sessions[0].messages.count == 3)
        #expect(state.sessions[0].messages[0].text == "first")
        #expect(state.sessions[0].messages[1].text == "second")
        #expect(state.sessions[0].messages[2].text == "third")
    }

    @Test("displayTimestamp falls back to connectedAt before messages are received")
    func displayTimestampFallsBackToConnectedAt() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo())

        let session = state.sessions[0]
        #expect(session.lastMessageReceivedAt == nil)
        #expect(session.displayTimestamp == session.connectedAt)
    }

    @Test("appendMessage updates lastMessageReceivedAt")
    func appendMessageUpdatesLastMessageReceivedAt() throws {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo())
        let connectedAt = state.sessions[0].connectedAt

        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 1, text: "hello"))

        let session = state.sessions[0]
        let lastMessageReceivedAt = try #require(session.lastMessageReceivedAt)
        #expect(lastMessageReceivedAt >= connectedAt)
        #expect(session.displayTimestamp == lastMessageReceivedAt)
    }

    @Test("appendMessage buffers messages for unknown connectionId (does not affect existing sessions)")
    func appendMessageUnknownConnection() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo())

        state.appendMessage(connectionId: UUID(), message: self.makeMessage(seq: 1, text: "orphan"))

        // Existing session should not be affected
        #expect(state.sessions[0].messages.isEmpty)
    }

    @Test("appendMessage buffers messages before session_info, addSession flushes them")
    func appendMessageBufferingAndFlush() {
        let state = SessionState()
        let connId = UUID()

        // Messages arrive before session_info
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 1, text: "early msg 1"))
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 2, text: "early msg 2"))

        // No sessions exist yet
        #expect(state.sessions.isEmpty)

        // Now session_info arrives
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))

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
        state.appendMessage(connectionId: connId1, message: self.makeMessage(seq: 1, text: "conn1 early"))
        state.appendMessage(connectionId: connId2, message: self.makeMessage(seq: 1, text: "conn2 early"))

        // Register first session
        state.addSession(connectionId: connId1, info: self.makeInfo(command: "agent"))
        #expect(state.sessions[0].messages.count == 1)
        #expect(state.sessions[0].messages[0].text == "conn1 early")

        // Register second session
        state.addSession(connectionId: connId2, info: self.makeInfo(command: "review"))
        #expect(state.sessions[0].messages.count == 1)
        #expect(state.sessions[0].messages[0].text == "conn2 early")
    }

    @Test("appendMessage continues normally after buffered messages are flushed")
    func appendMessageAfterFlush() {
        let state = SessionState()
        let connId = UUID()

        // Buffer one message
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 1, text: "buffered"))

        // Register session (flushes buffer)
        state.addSession(connectionId: connId, info: self.makeInfo())

        // New messages append normally
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 2, text: "live msg"))

        #expect(state.sessions[0].messages.count == 2)
        #expect(state.sessions[0].messages[0].text == "buffered")
        #expect(state.sessions[0].messages[1].text == "live msg")
    }

    @Test("ingestSessionMetadata updates planTitle from plan_discovery")
    func ingestSessionMetadataFromPlanDiscovery() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        #expect(state.sessions[0].planTitle == nil)

        state.ingestSessionMetadata(
            connectionId: connId,
            tunnelMessage: .structured(message: .planDiscovery(
                planId: 42,
                title: "New Plan Title",
                timestamp: nil)))

        #expect(state.sessions[0].planTitle == "New Plan Title")
    }

    @Test("ingestSessionMetadata updates planTitle from execution_summary")
    func ingestSessionMetadataFromExecutionSummary() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        #expect(state.sessions[0].planTitle == nil)

        state.ingestSessionMetadata(
            connectionId: connId,
            tunnelMessage: .structured(message: .executionSummary(ExecutionSummaryPayload(
                planId: "42",
                planTitle: "Execution Summary Title",
                mode: "agent",
                durationMs: nil,
                totalSteps: nil,
                failedSteps: nil,
                changedFiles: nil,
                errors: nil,
                timestamp: nil))))

        #expect(state.sessions[0].planTitle == "Execution Summary Title")
    }

    @Test("ingestSessionMetadata ignores empty titles")
    func ingestSessionMetadataIgnoresEmptyTitles() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent", planTitle: "Existing"))

        state.ingestSessionMetadata(
            connectionId: connId,
            tunnelMessage: .structured(message: .planDiscovery(
                planId: 42,
                title: "   ",
                timestamp: nil)))

        #expect(state.sessions[0].planTitle == "Existing")
    }

    @Test("replay buffers messages and flushes them only on replay_end")
    func replayBuffersUntilEnd() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo())

        state.startReplay(connectionId: connId)
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 1, text: "replay 1"))
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 2, text: "replay 2"))

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
        state.addSession(connectionId: connId, info: self.makeInfo())

        state.startReplay(connectionId: connId)
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 1, text: "replay"))
        state.endReplay(connectionId: connId)

        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 2, text: "live"))

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
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 1, text: "replay orphan"))

        state.markDisconnected(connectionId: connId)
        state.addSession(connectionId: connId, info: self.makeInfo())
        state.endReplay(connectionId: connId)

        #expect(state.sessions[0].messages.isEmpty)
    }

    @Test("markDisconnected cleans up pending message buffer")
    func markDisconnectedCleansPendingBuffer() {
        let state = SessionState()
        let connId = UUID()

        // Buffer messages for a connection that never sends session_info
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 1, text: "orphan"))
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 2, text: "orphan 2"))

        // Disconnect without ever registering the session
        state.markDisconnected(connectionId: connId)

        // Now if addSession is called (shouldn't happen but test cleanup), buffer should be empty
        state.addSession(connectionId: connId, info: self.makeInfo())
        #expect(state.sessions[0].messages.isEmpty)
    }

    // MARK: - markDisconnected

    @Test("markDisconnected sets isActive to false")
    func markDisconnectedSetsInactive() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo())
        #expect(state.sessions[0].isActive == true)

        state.markDisconnected(connectionId: connId)

        #expect(state.sessions[0].isActive == false)
    }

    @Test("markDisconnected updates notification state for that session")
    func markDisconnectedSetsNotification() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo())
        state.selectedSessionId = nil

        state.markDisconnected(connectionId: connId)

        #expect(state.sessions[0].hasUnreadNotification == true)
        #expect(state.sessions[0].notificationMessage == "Agent session disconnected")
    }

    @Test("markDisconnected sets unread notification for selected session")
    func markDisconnectedSelectedSessionUnread() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo())
        state.selectedSessionId = state.sessions[0].id

        state.markDisconnected(connectionId: connId)

        #expect(state.sessions[0].hasUnreadNotification == true)
        #expect(state.sessions[0].notificationMessage == "Agent session disconnected")
    }

    @Test("markDisconnected only affects the targeted session")
    func markDisconnectedTargeted() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(connectionId: connId1, info: self.makeInfo())
        state.addSession(connectionId: connId2, info: self.makeInfo())

        state.markDisconnected(connectionId: connId1)

        // connId2 at index 0, connId1 at index 1
        #expect(state.sessions[0].isActive == true)
        #expect(state.sessions[1].isActive == false)
    }

    @Test("markDisconnected is a no-op for unknown connectionId")
    func markDisconnectedUnknownConnection() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo())

        state.markDisconnected(connectionId: UUID())

        #expect(state.sessions[0].isActive == true)
    }

    // MARK: - dismissSession

    @Test("dismissSession removes a closed session from the list")
    func dismissSessionRemoves() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo())
        let sessionId = state.sessions[0].id
        state.markDisconnected(connectionId: connId)

        state.dismissSession(id: sessionId)

        #expect(state.sessions.isEmpty)
    }

    @Test("dismissSession is a no-op for an active session")
    func dismissSessionActiveSessionNoop() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo())
        let sessionId = state.sessions[0].id
        #expect(state.sessions[0].isActive == true)

        state.dismissSession(id: sessionId)

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].id == sessionId)
    }

    @Test("dismissSession reselects first session if dismissed session was selected")
    func dismissSessionReselects() throws {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(connectionId: connId1, info: self.makeInfo(command: "first"))
        state.addSession(connectionId: connId2, info: self.makeInfo(command: "second"))

        // First session added was auto-selected; it's now at index 1
        let selectedId = try #require(state.selectedSessionId)
        #expect(state.sessions[1].id == selectedId)

        // Mark disconnected before dismissing
        state.markDisconnected(connectionId: connId1)
        state.dismissSession(id: selectedId)

        // Should reselect the remaining session (connId2, now the only one)
        #expect(state.sessions.count == 1)
        #expect(state.selectedSessionId == state.sessions[0].id)
    }

    @Test("dismissSession does not change selection if a different session was dismissed")
    func dismissSessionPreservesSelection() throws {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(connectionId: connId1, info: self.makeInfo(command: "first"))
        let firstSessionId = try #require(state.selectedSessionId)

        state.addSession(connectionId: connId2, info: self.makeInfo(command: "second"))
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
        state.addSession(connectionId: connId, info: self.makeInfo())
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
        state.addSession(connectionId: connId1, info: self.makeInfo(command: "first"))
        state.addSession(connectionId: connId2, info: self.makeInfo(command: "second"))
        state.addSession(connectionId: connId3, info: self.makeInfo(command: "third"))

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
        state.addSession(connectionId: connId1, info: self.makeInfo(command: "first"))
        state.addSession(connectionId: connId2, info: self.makeInfo(command: "second"))

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
        state.addSession(connectionId: connId1, info: self.makeInfo(command: "first"))
        state.addSession(connectionId: connId2, info: self.makeInfo(command: "second"))

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
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))

        state.dismissAllDisconnected()

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].connectionId == connId)
    }

    @Test("dismissSession is a no-op for unknown session ID")
    func dismissSessionUnknownId() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo())
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
        state.addSession(connectionId: connId1, info: self.makeInfo(command: "first"))
        state.addSession(connectionId: connId2, info: self.makeInfo(command: "second"))

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
        state.addSession(connectionId: UUID(), info: self.makeInfo())
        state.selectedSessionId = UUID() // Set to a non-existent session ID

        #expect(state.selectedSession == nil)
    }

    @Test("selectedSession updates when selection changes")
    func selectedSessionUpdatesOnSelectionChange() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(connectionId: connId1, info: self.makeInfo(command: "first"))
        state.addSession(connectionId: connId2, info: self.makeInfo(command: "second"))

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
        let info = self.makeInfo(
            command: "agent",
            workspacePath: "/tmp/project",
            terminal: terminal)

        state.addSession(connectionId: connId, info: info)

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].terminal?.type == "wezterm")
        #expect(state.sessions[0].terminal?.paneId == "42")
    }

    @Test("addSession with nil terminal sets terminal to nil")
    func addSessionNilTerminal() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(command: "agent"))

        #expect(state.sessions[0].terminal == nil)
    }

    @Test("Duplicate session_info updates terminal field")
    func duplicateSessionInfoUpdatesTerminal() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        #expect(state.sessions[0].terminal == nil)

        let terminal = TerminalPayload(type: "wezterm", paneId: "5")
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent", terminal: terminal))

        #expect(state.sessions[0].terminal?.type == "wezterm")
        #expect(state.sessions[0].terminal?.paneId == "5")
    }

    // MARK: - Notification properties

    @Test("SessionItem defaults hasUnreadNotification to false and notificationMessage to nil")
    func sessionItemNotificationDefaults() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(command: "agent"))

        #expect(state.sessions[0].hasUnreadNotification == false)
        #expect(state.sessions[0].notificationMessage == nil)
    }

    // MARK: - ingestNotification

    @Test("ingestNotification matches session by pane ID")
    func ingestNotificationMatchesByPaneId() {
        let state = SessionState()
        let terminal = TerminalPayload(type: "wezterm", paneId: "42")
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project/a",
            terminal: terminal))
        // Deselect so we can verify the unread flag is set
        state.selectedSessionId = nil

        let payload = MessagePayload(
            message: "Task completed",
            workspacePath: "/project/a",
            gitRemote: nil,
            terminal: TerminalPayload(type: "wezterm", paneId: "42"))
        state.ingestNotification(payload: payload)

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].hasUnreadNotification == true)
        #expect(state.sessions[0].notificationMessage == "Task completed")
    }

    @Test("ingestNotification matches session by workspace path when no pane match")
    func ingestNotificationMatchesByWorkspace() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project/b"))
        // Deselect so we can verify the unread flag is set
        state.selectedSessionId = nil

        let payload = MessagePayload(
            message: "Done",
            workspacePath: "/project/b",
            gitRemote: nil,
            terminal: nil)
        state.ingestNotification(payload: payload)

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].hasUnreadNotification == true)
        #expect(state.sessions[0].notificationMessage == "Done")
    }

    @Test("ingestNotification matches by gitRemote when pane and workspace are unavailable")
    func ingestNotificationMatchesByGitRemote() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project/a",
            gitRemote: "github.com/owner/repo"))
        state.selectedSessionId = nil

        let payload = MessagePayload(
            message: "Matched by remote",
            workspacePath: "",
            gitRemote: "git@github.com:owner/repo.git",
            terminal: nil)
        state.ingestNotification(payload: payload)

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].hasUnreadNotification == true)
        #expect(state.sessions[0].notificationMessage == "Matched by remote")
    }

    @Test("ingestNotification creates new session when no match found")
    func ingestNotificationCreatesNewSession() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project/a"))

        let payload = MessagePayload(
            message: "Hello from unknown",
            workspacePath: "/project/c",
            gitRemote: nil,
            terminal: TerminalPayload(type: "wezterm", paneId: "99"))
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

    @Test("ingestNotification creates notification-only session grouped by gitRemote")
    func ingestNotificationCreatesSessionUsingGitRemote() {
        let state = SessionState()

        let payload = MessagePayload(
            message: "Remote-only notification",
            workspacePath: "",
            gitRemote: "github.com/owner/remote-only",
            terminal: nil)
        state.ingestNotification(payload: payload)

        #expect(state.sessions.count == 1)
        let newSession = state.sessions[0]
        #expect(newSession.gitRemote == "github.com/owner/remote-only")
        #expect(
            sessionGroupKey(gitRemote: newSession.gitRemote, workspacePath: newSession.workspacePath)
                == "owner/remote-only")
    }

    @Test("ingestNotification with multiple sessions same workspace matches most recent (first)")
    func ingestNotificationMatchesMostRecent() {
        let state = SessionState()
        // Add two sessions with same workspace - second added is at index 0 (most recent)
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(connectionId: connId1, info: self.makeInfo(
            command: "agent",
            workspacePath: "/shared/project"))
        state.addSession(connectionId: connId2, info: self.makeInfo(
            command: "review",
            workspacePath: "/shared/project"))

        let payload = MessagePayload(
            message: "Notification",
            workspacePath: "/shared/project",
            gitRemote: nil,
            terminal: nil)
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
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project"))
        // Session with matching pane ID but different workspace
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "review",
            workspacePath: "/other",
            terminal: TerminalPayload(type: "wezterm", paneId: "7")))

        let payload = MessagePayload(
            message: "Matched by pane",
            workspacePath: "/project",
            gitRemote: nil,
            terminal: TerminalPayload(type: "wezterm", paneId: "7"))
        state.ingestNotification(payload: payload)

        // Pane ID match (index 0, the review session) should be matched
        #expect(state.sessions[0].hasUnreadNotification == true)
        #expect(state.sessions[0].notificationMessage == "Matched by pane")
        // Workspace match session should not be affected
        #expect(state.sessions[1].hasUnreadNotification == false)
    }

    @Test("ingestNotification sets hasUnreadNotification on non-selected matched session")
    func ingestNotificationSetsFlag() throws {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project"))
        // Add a second session and select it so /project is not selected
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "review",
            workspacePath: "/other"))
        state.selectedSessionId = state.sessions[0].id // select /other
        let projectSession = try #require(state.sessions.first { $0.workspacePath == "/project" })
        #expect(projectSession.hasUnreadNotification == false)

        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "/project",
            gitRemote: nil,
            terminal: nil))

        #expect(projectSession.hasUnreadNotification == true)
    }

    @Test("Second notification replaces message on same session")
    func ingestNotificationReplacesMessage() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project"))
        // Deselect so we can verify the unread flag is set
        state.selectedSessionId = nil

        state.ingestNotification(payload: MessagePayload(
            message: "First notification",
            workspacePath: "/project",
            gitRemote: nil,
            terminal: nil))
        #expect(state.sessions[0].notificationMessage == "First notification")

        state.ingestNotification(payload: MessagePayload(
            message: "Second notification",
            workspacePath: "/project",
            gitRemote: nil,
            terminal: nil))
        #expect(state.sessions[0].notificationMessage == "Second notification")
        #expect(state.sessions[0].hasUnreadNotification == true)
    }

    @Test("ingestNotification with no terminal info matches by workspace only")
    func ingestNotificationNoTerminalMatchesByWorkspace() {
        let state = SessionState()
        let terminal = TerminalPayload(type: "wezterm", paneId: "5")
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project/x",
            terminal: terminal))
        // Deselect so we can verify the unread flag is set
        state.selectedSessionId = nil

        // Notification has no terminal info - should still match by workspace
        state.ingestNotification(payload: MessagePayload(
            message: "Done",
            workspacePath: "/project/x",
            gitRemote: nil,
            terminal: nil))

        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].hasUnreadNotification == true)
    }

    // MARK: - ingestNotification(connectionId:tunnelMessage:)

    @Test("agent_session_end structured output is ignored")
    func ingestStructuredAgentSessionEndNotificationIgnored() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(
            command: "agent",
            workspacePath: "/project/x"))
        state.selectedSessionId = nil

        state.ingestNotification(
            connectionId: connId,
            tunnelMessage: .structured(message: .agentSessionEnd(AgentSessionEndPayload(
                success: true,
                sessionId: nil,
                threadId: nil,
                durationMs: nil,
                costUsd: nil,
                turns: nil,
                summary: "All tasks complete",
                timestamp: nil))))

        #expect(state.sessions[0].hasUnreadNotification == false)
        #expect(state.sessions[0].notificationMessage == nil)
    }

    @Test("input_required structured output updates selected session with unread badge")
    func ingestStructuredInputRequiredNotificationSelectedSession() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(
            command: "review",
            workspacePath: "/project/x"))
        state.selectedSessionId = state.sessions[0].id

        state.ingestNotification(
            connectionId: connId,
            tunnelMessage: .structured(message: .inputRequired(
                prompt: "Choose how to proceed",
                timestamp: nil)))

        #expect(state.sessions[0].notificationMessage == "Input required: Choose how to proceed")
        #expect(state.sessions[0].hasUnreadNotification == true)
    }

    @Test("prompt_request structured output updates notification state")
    func ingestStructuredPromptRequestNotification() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(
            command: "agent",
            workspacePath: "/project/x"))

        state.ingestNotification(
            connectionId: connId,
            tunnelMessage: .structured(message: .promptRequest(PromptRequestPayload(
                requestId: "req-1",
                promptType: "confirm",
                promptConfig: PromptConfigPayload(message: "Continue with deploy?"),
                timeoutMs: nil,
                timestamp: nil))))

        #expect(state.sessions[0].notificationMessage == "Prompt (confirm): Continue with deploy?")
        #expect(state.sessions[0].hasUnreadNotification == true)
    }

    @Test("prompt_answered structured output is ignored")
    func ingestStructuredPromptAnsweredNotificationIgnored() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(
            command: "agent",
            workspacePath: "/project/x"))

        state.ingestNotification(
            connectionId: connId,
            tunnelMessage: .structured(message: .promptAnswered(PromptAnsweredPayload(
                requestId: "req-1",
                promptType: "confirm",
                source: "terminal",
                value: nil,
                timestamp: nil))))

        #expect(state.sessions[0].notificationMessage == nil)
        #expect(state.sessions[0].hasUnreadNotification == false)
    }

    @Test("structured messages other than input_required and prompt_request are ignored")
    func ingestStructuredNotificationIgnoresOtherMessages() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(
            command: "agent",
            workspacePath: "/project/x"))

        state.ingestNotification(
            connectionId: connId,
            tunnelMessage: .structured(message: .agentSessionStart(AgentSessionStartPayload(
                executor: "claude",
                mode: "agent",
                planId: nil,
                sessionId: nil,
                threadId: nil,
                tools: nil,
                mcpServers: nil,
                timestamp: nil))))

        #expect(state.sessions[0].notificationMessage == nil)
        #expect(state.sessions[0].hasUnreadNotification == false)
    }

    // MARK: - markNotificationRead

    @Test("markNotificationRead clears notification on session")
    func markNotificationReadClears() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project"))
        // Deselect so the notification flag gets set
        state.selectedSessionId = nil
        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "/project",
            gitRemote: nil,
            terminal: nil))
        let sessionId = state.sessions[0].id
        #expect(state.sessions[0].hasUnreadNotification == true)

        state.markNotificationRead(sessionId: sessionId)

        #expect(state.sessions[0].hasUnreadNotification == false)
        #expect(state.sessions[0].notificationMessage == "Alert")
    }

    @Test("markNotificationRead is a no-op for unknown session ID")
    func markNotificationReadUnknownId() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(command: "agent"))

        // Should not crash or affect anything
        state.markNotificationRead(sessionId: UUID())

        #expect(state.sessions[0].hasUnreadNotification == false)
    }

    @Test("markNotificationRead only clears targeted session, not others")
    func markNotificationReadTargeted() throws {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project/a"))
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "review",
            workspacePath: "/project/b"))
        // Deselect so both notifications set the unread flag
        state.selectedSessionId = nil

        // Send notifications to both sessions
        state.ingestNotification(payload: MessagePayload(
            message: "Alert A",
            workspacePath: "/project/a",
            gitRemote: nil,
            terminal: nil))
        state.ingestNotification(payload: MessagePayload(
            message: "Alert B",
            workspacePath: "/project/b",
            gitRemote: nil,
            terminal: nil))

        // Both should have notifications
        let sessionA = try #require(state.sessions.first { $0.workspacePath == "/project/a" })
        let sessionB = try #require(state.sessions.first { $0.workspacePath == "/project/b" })
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

    @Test("handleSessionListItemTap clears unread when tapping already-selected session")
    func handleSessionListItemTapClearsSelectedUnread() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project"))
        let sessionId = state.sessions[0].id
        state.selectedSessionId = sessionId
        state.ingestNotification(payload: MessagePayload(
            message: "Done",
            workspacePath: "/project",
            gitRemote: nil,
            terminal: nil))
        #expect(state.sessions[0].hasUnreadNotification == true)

        state.handleSessionListItemTap(sessionId: sessionId)

        #expect(state.sessions[0].hasUnreadNotification == false)
    }

    @Test("handleSessionListItemTap selects and clears unread for non-selected session")
    func handleSessionListItemTapSelectsAndClearsUnread() throws {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project/a"))
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "review",
            workspacePath: "/project/b"))
        let initiallySelected = try #require(state.selectedSessionId)

        state.ingestNotification(payload: MessagePayload(
            message: "Alert A",
            workspacePath: "/project/a",
            gitRemote: nil,
            terminal: nil))

        let sessionA = try #require(state.sessions.first { $0.workspacePath == "/project/a" })
        #expect(sessionA.hasUnreadNotification == true)
        #expect(state.selectedSessionId == initiallySelected)

        state.handleSessionListItemTap(sessionId: sessionA.id)

        #expect(state.selectedSessionId == sessionA.id)
        #expect(sessionA.hasUnreadNotification == false)
    }

    @Test("handleTerminalIconTap clears unread without changing selection")
    func handleTerminalIconTapClearsUnread() throws {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project/a",
            terminal: TerminalPayload(type: "wezterm", paneId: "1")))
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "review",
            workspacePath: "/project/b",
            terminal: TerminalPayload(type: "wezterm", paneId: "2")))

        let selectedBeforeTap = try #require(state.selectedSessionId)
        state.ingestNotification(payload: MessagePayload(
            message: "Alert A",
            workspacePath: "/project/a",
            gitRemote: nil,
            terminal: nil))

        let sessionA = try #require(state.sessions.first { $0.workspacePath == "/project/a" })
        #expect(sessionA.hasUnreadNotification == true)

        state.handleTerminalIconTap(sessionId: sessionA.id)

        #expect(sessionA.hasUnreadNotification == false)
        #expect(state.selectedSessionId == selectedBeforeTap)
    }

    @Test("handleTerminalIconTap is a no-op for unknown session ID")
    func handleTerminalIconTapUnknownId() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project",
            terminal: TerminalPayload(type: "wezterm", paneId: "1")))

        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "/project",
            gitRemote: nil,
            terminal: nil))
        #expect(state.sessions[0].hasUnreadNotification == true)

        state.handleTerminalIconTap(sessionId: UUID())

        #expect(state.sessions[0].hasUnreadNotification == true)
    }

    @Test("Notification for already-selected session sets unread flag")
    func ingestNotificationForSelectedSessionSetsFlag() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project"))
        // First session is auto-selected
        let sessionId = state.sessions[0].id
        #expect(state.selectedSessionId == sessionId)

        state.ingestNotification(payload: MessagePayload(
            message: "Done",
            workspacePath: "/project",
            gitRemote: nil,
            terminal: nil))

        // Message should be stored and unread should remain set until explicitly cleared.
        #expect(state.sessions[0].notificationMessage == "Done")
        #expect(state.sessions[0].hasUnreadNotification == true)
    }

    @Test("Notification for non-selected session sets unread flag")
    func ingestNotificationForNonSelectedSession() throws {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project/a"))
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "review",
            workspacePath: "/project/b"))
        // First added session (project/a) is auto-selected, project/b is not

        state.ingestNotification(payload: MessagePayload(
            message: "Alert B",
            workspacePath: "/project/b",
            gitRemote: nil,
            terminal: nil))

        let sessionB = try #require(state.sessions.first { $0.workspacePath == "/project/b" })
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
            gitRemote: nil,
            terminal: nil))
        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].notificationMessage == "First alert")
        // Deselect so the second notification sets the unread flag
        state.selectedSessionId = nil

        // Second notification to same workspace should update, not create new
        state.ingestNotification(payload: MessagePayload(
            message: "Second alert",
            workspacePath: "/orphan/project",
            gitRemote: nil,
            terminal: nil))
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
            gitRemote: nil,
            terminal: terminal))

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
        #expect(session.lastMessageReceivedAt != nil)
        #expect(session.displayTimestamp == session.lastMessageReceivedAt)
        #expect(session.messages.isEmpty)
    }

    @Test("dismissAllDisconnected removes notification-only sessions")
    func dismissAllDisconnectedRemovesNotificationOnlySessions() {
        let state = SessionState()
        // Create a notification-only session (no matching session)
        state.ingestNotification(payload: MessagePayload(
            message: "Orphan notification",
            workspacePath: "/orphan",
            gitRemote: nil,
            terminal: nil))
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
        let info = self.makeInfo(
            command: "agent", planId: 10, planTitle: "Build feature",
            workspacePath: "/home/user/project")

        // Connect
        state.addSession(connectionId: connId, info: info)
        #expect(state.sessions.count == 1)
        #expect(state.selectedSession?.command == "agent")

        // Receive messages
        state.appendMessage(
            connectionId: connId, message: self.makeMessage(seq: 1, text: "Starting...", category: .lifecycle))
        state.appendMessage(
            connectionId: connId,
            message: self.makeMessage(seq: 2, text: "Thinking about the problem", category: .llmOutput))
        state.appendMessage(
            connectionId: connId,
            message: self.makeMessage(seq: 3, text: "Edit: main.swift", category: .fileChange))
        #expect(state.sessions[0].messages.count == 3)

        // Disconnect
        state.markDisconnected(connectionId: connId)
        #expect(state.sessions[0].isActive == false)
        #expect(state.sessions[0].messages.count == 3) // Messages preserved

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
        state.addSession(connectionId: connId1, info: self.makeInfo(command: "agent"))
        state.addSession(connectionId: connId2, info: self.makeInfo(command: "review"))
        state.addSession(connectionId: connId3, info: self.makeInfo(command: "codex"))

        state.appendMessage(connectionId: connId2, message: self.makeMessage(seq: 1, text: "review msg"))
        state.appendMessage(connectionId: connId1, message: self.makeMessage(seq: 1, text: "agent msg"))
        state.appendMessage(connectionId: connId3, message: self.makeMessage(seq: 1, text: "codex msg"))
        state.appendMessage(connectionId: connId2, message: self.makeMessage(seq: 2, text: "review msg 2"))

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
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent", planTitle: "Test Plan"))

        // Hold a reference to the session
        let sessionRef = state.sessions[0]
        #expect(sessionRef.isActive == true)
        #expect(sessionRef.messages.isEmpty)

        // Mutate through SessionState methods
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 1, text: "msg1"))
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
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))

        let fromArray = state.sessions[0]
        let fromSelected = state.selectedSession

        // Both should be the exact same object (reference identity)
        #expect(fromArray === fromSelected)
    }

    @Test("Appending messages to SessionItem via reference is visible through SessionState")
    func referenceMessageAppend() throws {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo())

        // Append multiple messages and verify the reference stays consistent
        for i in 1...5 {
            state.appendMessage(connectionId: connId, message: self.makeMessage(seq: i, text: "msg \(i)"))
        }

        let session = try #require(state.selectedSession)
        #expect(session.messages.count == 5)

        // Append more after getting the reference
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 6, text: "msg 6"))
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
            gitRemote: nil,
            terminal: terminal))
        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].command == "")
        #expect(state.sessions[0].isActive == false)
        #expect(state.sessions[0].hasUnreadNotification == true)
        #expect(state.sessions[0].notificationMessage == "Task completed")
        let originalSessionId = state.sessions[0].id

        // Now WebSocket session_info arrives with matching pane ID
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(
            command: "agent",
            planId: 10,
            planTitle: "My Plan",
            workspacePath: "/project/a",
            terminal: terminal))

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
            gitRemote: nil,
            terminal: nil))
        #expect(state.sessions.count == 1)
        let originalSessionId = state.sessions[0].id

        // WebSocket session_info arrives with matching workspace (no terminal)
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(
            command: "review",
            workspacePath: "/project/b"))

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
            gitRemote: nil,
            terminal: terminal))

        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(
            command: "agent",
            workspacePath: "/project",
            terminal: terminal))

        // Messages should route to the reconciled session
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 1, text: "hello"))
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
            gitRemote: nil,
            terminal: nil))

        let connId = UUID()
        // Messages arrive before session_info
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 1, text: "early msg"))

        // session_info reconciles with the notification-only session
        state.addSession(connectionId: connId, info: self.makeInfo(
            command: "agent",
            workspacePath: "/project"))

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
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project",
            terminal: terminal))

        // A different WebSocket connection arrives with the same terminal
        let connId2 = UUID()
        state.addSession(connectionId: connId2, info: self.makeInfo(
            command: "review",
            workspacePath: "/project",
            terminal: terminal))

        // Should create a second session (no reconciliation since the first isn't notification-only)
        #expect(state.sessions.count == 2)
    }

    // MARK: - Empty workspace path guard

    @Test("ingestNotification with empty workspacePath does not match sessions by workspace")
    func ingestNotificationEmptyWorkspaceNoMatch() {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: ""))

        // Notification with empty workspacePath should NOT match the session with empty workspace
        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "",
            gitRemote: nil,
            terminal: nil))

        // Should create a new notification-only session, not match the existing one
        #expect(state.sessions.count == 2)
    }

    @Test("ingestNotification matches a disconnected session")
    func ingestNotificationMatchesDisconnectedSession() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(
            command: "agent",
            workspacePath: "/project"))
        state.markDisconnected(connectionId: connId)
        #expect(state.sessions[0].isActive == false)
        // Deselect so the notification flag gets set
        state.selectedSessionId = nil

        state.ingestNotification(payload: MessagePayload(
            message: "Post-disconnect alert",
            workspacePath: "/project",
            gitRemote: nil,
            terminal: nil))

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
            gitRemote: nil,
            terminal: terminal))
        #expect(state.sessions.count == 1)

        // Second notification with same pane ID should match the existing notification-only session
        state.ingestNotification(payload: MessagePayload(
            message: "Second",
            workspacePath: "/project",
            gitRemote: nil,
            terminal: terminal))
        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].notificationMessage == "Second")
    }

    @Test("Notification-only session does NOT auto-select when nothing is selected")
    func notificationOnlyDoesNotAutoSelect() {
        let state = SessionState()
        #expect(state.selectedSessionId == nil)

        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "/project",
            gitRemote: nil,
            terminal: nil))
        // Notification-only sessions should NOT be auto-selected
        #expect(state.selectedSessionId == nil)
        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].hasUnreadNotification == true)
    }

    @Test("Reconciliation auto-selects when nothing was selected")
    func reconcileAutoSelectsWhenNothingSelected() {
        let state = SessionState()
        #expect(state.selectedSessionId == nil)

        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "/project",
            gitRemote: nil,
            terminal: nil))
        let notifSessionId = state.sessions[0].id
        // Notification-only sessions do not auto-select
        #expect(state.selectedSessionId == nil)

        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(
            command: "agent",
            workspacePath: "/project"))

        // After reconciliation, addSession auto-selects because nothing was selected
        #expect(state.selectedSessionId == notifSessionId)
        #expect(state.selectedSession?.command == "agent")
    }

    @Test("Notification with pane ID does not fall back to workspace when pane match is not found")
    func ingestNotificationPaneIdNoWorkspaceFallback() {
        let state = SessionState()

        // An older session exists for the same workspace but with a different (or no) pane ID
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project/a",
            terminal: TerminalPayload(type: "wezterm", paneId: "10")))
        // Deselect so we can verify unread gets set on the matched session.
        state.selectedSessionId = nil

        // Notification arrives with a NEW pane ID (e.g., a new run in a different pane)
        // No session has pane ID "42" yet
        state.ingestNotification(payload: MessagePayload(
            message: "Task done",
            workspacePath: "/project/a",
            gitRemote: nil,
            terminal: TerminalPayload(type: "wezterm", paneId: "42")))

        // Pane lookup misses, so a new notification-only session is created.
        #expect(state.sessions.count == 2)
        let notificationSession = state.sessions[0]
        #expect(notificationSession.command == "")
        #expect(notificationSession.hasUnreadNotification == true)
        #expect(notificationSession.notificationMessage == "Task done")
        #expect(notificationSession.terminal?.paneId == "42")

        // Existing session should remain unchanged.
        let existingSession = state.sessions[1]
        #expect(existingSession.command == "agent")
        #expect(existingSession.hasUnreadNotification == false)
        #expect(existingSession.terminal?.paneId == "10")
    }

    @Test("Pane-miss creates notification-only session before later session_info")
    func ingestNotificationPaneIdMissBeforeLaterSessionInfo() throws {
        let state = SessionState()

        // An older session exists for the same workspace
        let oldConnId = UUID()
        state.addSession(connectionId: oldConnId, info: self.makeInfo(
            command: "agent",
            workspacePath: "/project/a",
            terminal: TerminalPayload(type: "wezterm", paneId: "10")))
        state.markDisconnected(connectionId: oldConnId)
        // Deselect so we can verify unread gets set on the matched session.
        state.selectedSessionId = nil

        // Notification for a new run arrives before its session_info
        let newPaneId = "42"
        state.ingestNotification(payload: MessagePayload(
            message: "New run done",
            workspacePath: "/project/a",
            gitRemote: nil,
            terminal: TerminalPayload(type: "wezterm", paneId: newPaneId)))

        // Pane lookup misses, so a notification-only session is created.
        #expect(state.sessions.count == 2)
        let oldSessionId = state.sessions[1].id
        let notificationSessionId = state.sessions[0].id
        #expect(state.sessions[0].connectionId != oldConnId)
        #expect(state.sessions[0].hasUnreadNotification == true)
        #expect(state.sessions[0].command == "")
        #expect(state.sessions[0].terminal?.paneId == newPaneId)

        // Now the real session_info arrives with the matching pane ID
        let newConnId = UUID()
        state.addSession(connectionId: newConnId, info: self.makeInfo(
            command: "review",
            workspacePath: "/project/a",
            terminal: TerminalPayload(type: "wezterm", paneId: newPaneId)))

        // The notification-only session should reconcile with the incoming pane.
        #expect(state.sessions.count == 2)
        let oldSession = try #require(state.sessions.first { $0.id == oldSessionId })
        #expect(oldSession.connectionId == oldConnId)
        #expect(oldSession.isActive == false)

        let newSession = try #require(state.sessions.first { $0.connectionId == newConnId })
        #expect(newSession.id == notificationSessionId)
        #expect(newSession.command == "review")
        #expect(newSession.isActive == true)
        #expect(newSession.terminal?.paneId == newPaneId)
        #expect(newSession.notificationMessage == "New run done")
        #expect(newSession.hasUnreadNotification == true)
    }

    @Test("Pane-miss notification copies metadata from same workspace row without pane ID")
    func ingestNotificationPaneIdMissCopiesMetadataFromNoPaneRow() {
        let state = SessionState()

        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            planId: 77,
            planTitle: "Shared Plan",
            workspacePath: "/project/a",
            gitRemote: "git@github.com:dimfeld/example.git",
            terminal: nil))

        state.ingestNotification(payload: MessagePayload(
            message: "Task done",
            workspacePath: "/project/a",
            gitRemote: nil,
            terminal: TerminalPayload(type: "wezterm", paneId: "42")))

        #expect(state.sessions.count == 2)
        let notificationSession = state.sessions[0]
        #expect(notificationSession.command == "")
        #expect(notificationSession.planId == 77)
        #expect(notificationSession.planTitle == "Shared Plan")
        #expect(notificationSession.gitRemote == "git@github.com:dimfeld/example.git")
        #expect(notificationSession.terminal?.paneId == "42")
    }

    @Test("Reconciliation does not match notification-only session when pane IDs differ")
    func reconcileDoesNotMatchMismatchedPaneId() throws {
        let state = SessionState()

        // Create a notification-only session with pane 10
        state.ingestNotification(payload: MessagePayload(
            message: "Alert from pane 10",
            workspacePath: "/project",
            gitRemote: nil,
            terminal: TerminalPayload(type: "wezterm", paneId: "10")))
        #expect(state.sessions.count == 1)
        let notifSessionId = state.sessions[0].id

        // session_info arrives with same workspace but different pane ID (12)
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(
            command: "agent",
            workspacePath: "/project",
            terminal: TerminalPayload(type: "wezterm", paneId: "12")))

        // Should NOT reconcile — pane IDs differ and the incoming session has a pane ID,
        // so workspace fallback is skipped. A new session should be created.
        #expect(state.sessions.count == 2)
        // The notification-only session should remain unchanged
        let notifSession = try #require(state.sessions.first { $0.id == notifSessionId })
        #expect(notifSession.command == "")
        #expect(notifSession.isActive == false)
        #expect(notifSession.hasUnreadNotification == true)
        #expect(notifSession.terminal?.paneId == "10")
        // The new session should be a real session
        let newSession = try #require(state.sessions.first { $0.connectionId == connId })
        #expect(newSession.command == "agent")
        #expect(newSession.isActive == true)
        #expect(newSession.terminal?.paneId == "12")
    }

    @Test("Reconciliation does not match notification-only session with empty workspace by workspace path")
    func reconcileDoesNotMatchEmptyWorkspace() {
        let state = SessionState()

        // Create a notification-only session with no workspace
        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "",
            gitRemote: nil,
            terminal: nil))
        #expect(state.sessions.count == 1)

        // WebSocket session with empty workspace should NOT reconcile
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: ""))

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
            gitRemote: nil,
            terminal: TerminalPayload(type: "wezterm", paneId: "99")))
        #expect(state.sessions.count == 1)
        let sessionId = state.sessions[0].id
        #expect(state.sessions[0].isActive == false)

        state.dismissSession(id: sessionId)

        #expect(state.sessions.isEmpty)
        #expect(state.selectedSessionId == nil)
    }

    @Test("Second notification to unselected notification-only session keeps unread flag")
    func notificationOnlySecondNotificationKeepsUnread() {
        let state = SessionState()
        #expect(state.selectedSessionId == nil)

        // First notification creates a notification-only session (not auto-selected)
        state.ingestNotification(payload: MessagePayload(
            message: "First",
            workspacePath: "/orphan",
            gitRemote: nil,
            terminal: nil))
        #expect(state.sessions.count == 1)
        #expect(state.selectedSessionId == nil)

        // Second notification to the same session — still not selected
        state.ingestNotification(payload: MessagePayload(
            message: "Second",
            workspacePath: "/orphan",
            gitRemote: nil,
            terminal: nil))

        // The session is not selected so hasUnreadNotification should be true
        #expect(state.sessions.count == 1)
        #expect(state.sessions[0].notificationMessage == "Second")
        #expect(state.sessions[0].hasUnreadNotification == true)
    }

    @Test("Notification-only session does not auto-select when another session is already selected")
    func notificationOnlyNoAutoSelectWhenOtherSelected() throws {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(
            command: "agent",
            workspacePath: "/project/a"))
        let existingSessionId = try #require(state.selectedSessionId)

        // Create a notification-only session (no match)
        state.ingestNotification(payload: MessagePayload(
            message: "Alert",
            workspacePath: "/orphan",
            gitRemote: nil,
            terminal: nil))

        // The existing session should still be selected
        #expect(state.selectedSessionId == existingSessionId)
        #expect(state.sessions.count == 2)
    }

    // MARK: - sendUserInput

    @Test("sendUserInput adds a local message with .userInput category")
    func sendUserInputAddsLocalMessage() async throws {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        let sessionId = state.sessions[0].id

        var handlerCalled = false
        state.sendMessageHandler = { _, _ in handlerCalled = true }

        try await state.sendUserInput(sessionId: sessionId, content: "hello")

        #expect(handlerCalled == true)
        #expect(state.sessions[0].messages.count == 1)
        let msg = state.sessions[0].messages[0]
        #expect(msg.title == "You")
        #expect(msg.category == .userInput)
        #expect(msg.text == "You\nhello")
        #expect(msg.timestamp != nil)
    }

    @Test("sendUserInput calls handler with correct connectionId and message")
    func sendUserInputCallsHandler() async throws {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        let sessionId = state.sessions[0].id

        var receivedConnectionId: UUID?
        var receivedMessage: OutgoingMessage?
        state.sendMessageHandler = { cId, msg in
            receivedConnectionId = cId
            receivedMessage = msg
        }

        try await state.sendUserInput(sessionId: sessionId, content: "test message")

        #expect(receivedConnectionId == connId)
        // Verify the message encodes correctly
        let data = try JSONEncoder().encode(#require(receivedMessage))
        let dict = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(dict["type"] == "user_input")
        #expect(dict["content"] == "test message")
    }

    @Test("sendUserInput is a no-op for inactive session")
    func sendUserInputInactiveSession() async throws {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        let sessionId = state.sessions[0].id
        state.markDisconnected(connectionId: connId)

        var handlerCalled = false
        state.sendMessageHandler = { _, _ in handlerCalled = true }

        try await state.sendUserInput(sessionId: sessionId, content: "hello")

        #expect(handlerCalled == false)
        // No message should be added (only the disconnect notification is present via markDisconnected side effects)
        // The messages array should be empty since we didn't add any output messages
        #expect(state.sessions[0].messages.isEmpty)
    }

    @Test("sendUserInput is a no-op for unknown session ID")
    func sendUserInputUnknownSession() async throws {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(command: "agent"))

        var handlerCalled = false
        state.sendMessageHandler = { _, _ in handlerCalled = true }

        try await state.sendUserInput(sessionId: UUID(), content: "hello")

        #expect(handlerCalled == false)
        #expect(state.sessions[0].messages.isEmpty)
    }

    @Test("sendUserInput throws when handler is nil")
    func sendUserInputWithoutHandler() async throws {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        let sessionId = state.sessions[0].id

        // No handler set — should throw
        await #expect(throws: SendError.self) {
            try await state.sendUserInput(sessionId: sessionId, content: "hello")
        }

        // No local message should be added
        #expect(state.sessions[0].messages.isEmpty)
    }

    @Test("sendUserInput propagates handler error and does not add local message")
    func sendUserInputHandlerError() async throws {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        let sessionId = state.sessions[0].id

        struct SendError: Error {}
        state.sendMessageHandler = { _, _ in throw SendError() }

        await #expect(throws: SendError.self) {
            try await state.sendUserInput(sessionId: sessionId, content: "should not appear")
        }

        // No local message should be added when the handler fails
        #expect(state.sessions[0].messages.isEmpty)
    }

    @Test("sendUserInput propagates noServer error and does not add local message")
    func sendUserInputNoServerError() async throws {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        let sessionId = state.sessions[0].id

        // Simulate the wiring pattern from TimGUIApp where server is nil
        state.sendMessageHandler = { _, _ in throw SendError.noServer }

        await #expect(throws: SendError.self) {
            try await state.sendUserInput(sessionId: sessionId, content: "should not appear")
        }

        // No local message should be added when the server is unavailable
        #expect(state.sessions[0].messages.isEmpty)
    }

    @Test("sendUserInput assigns sequential seq numbers")
    func sendUserInputSequentialSeq() async throws {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        let sessionId = state.sessions[0].id
        state.sendMessageHandler = { _, _ in }

        // Add an existing message first
        state.appendMessage(connectionId: connId, message: self.makeMessage(seq: 1, text: "from agent"))

        try await state.sendUserInput(sessionId: sessionId, content: "first")
        try await state.sendUserInput(sessionId: sessionId, content: "second")

        #expect(state.sessions[0].messages.count == 3)
        #expect(state.sessions[0].messages[1].seq == 2)
        #expect(state.sessions[0].messages[2].seq == 3)
    }

    // MARK: - setActivePrompt

    private func makePromptPayload(
        requestId: String = "prompt-1",
        promptType: String = "confirm",
        message: String = "Continue?") -> PromptRequestPayload
    {
        PromptRequestPayload(
            requestId: requestId,
            promptType: promptType,
            promptConfig: PromptConfigPayload(message: message),
            timeoutMs: nil,
            timestamp: nil)
    }

    @Test("setActivePrompt sets prompt on correct session")
    func setActivePromptSetsOnCorrectSession() throws {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(connectionId: connId1, info: self.makeInfo(command: "agent"))
        state.addSession(connectionId: connId2, info: self.makeInfo(command: "review"))

        let prompt = self.makePromptPayload(requestId: "req-1")
        state.setActivePrompt(connectionId: connId1, prompt: prompt)

        // Session with connId1 should have the prompt
        let session1 = try #require(state.sessions.first { $0.connectionId == connId1 })
        #expect(session1.pendingPrompt?.requestId == "req-1")

        // Session with connId2 should NOT have the prompt
        let session2 = try #require(state.sessions.first { $0.connectionId == connId2 })
        #expect(session2.pendingPrompt == nil)
    }

    @Test("setActivePrompt replaces existing prompt")
    func setActivePromptReplacesExisting() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))

        state.setActivePrompt(connectionId: connId, prompt: self.makePromptPayload(requestId: "first"))
        #expect(state.sessions[0].pendingPrompt?.requestId == "first")

        state.setActivePrompt(connectionId: connId, prompt: self.makePromptPayload(requestId: "second"))
        #expect(state.sessions[0].pendingPrompt?.requestId == "second")
    }

    @Test("setActivePrompt no-ops for unknown connectionId")
    func setActivePromptUnknownConnection() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))

        state.setActivePrompt(connectionId: UUID(), prompt: self.makePromptPayload())
        #expect(state.sessions[0].pendingPrompt == nil)
    }

    @Test("setActivePrompt during replay is a no-op")
    func setActivePromptDuringReplay() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        state.startReplay(connectionId: connId)

        state.setActivePrompt(connectionId: connId, prompt: self.makePromptPayload())
        #expect(state.sessions[0].pendingPrompt == nil)
    }

    // MARK: - clearActivePrompt

    @Test("clearActivePrompt clears when requestId matches")
    func clearActivePromptMatchingId() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        state.setActivePrompt(connectionId: connId, prompt: self.makePromptPayload(requestId: "req-x"))
        #expect(state.sessions[0].pendingPrompt != nil)

        state.clearActivePrompt(connectionId: connId, requestId: "req-x")
        #expect(state.sessions[0].pendingPrompt == nil)
    }

    @Test("clearActivePrompt does not clear when requestId does not match")
    func clearActivePromptMismatchedId() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        state.setActivePrompt(connectionId: connId, prompt: self.makePromptPayload(requestId: "req-x"))

        state.clearActivePrompt(connectionId: connId, requestId: "req-y")
        #expect(state.sessions[0].pendingPrompt?.requestId == "req-x")
    }

    @Test("clearActivePrompt no-ops when no pending prompt")
    func clearActivePromptNoPending() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))

        // Should not crash or have side effects
        state.clearActivePrompt(connectionId: connId, requestId: "req-z")
        #expect(state.sessions[0].pendingPrompt == nil)
    }

    @Test("clearActivePrompt during replay is a no-op")
    func clearActivePromptDuringReplay() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        state.setActivePrompt(connectionId: connId, prompt: self.makePromptPayload(requestId: "req-r"))

        state.startReplay(connectionId: connId)
        state.clearActivePrompt(connectionId: connId, requestId: "req-r")
        // Prompt should still be there because replay mode blocks the clear
        #expect(state.sessions[0].pendingPrompt?.requestId == "req-r")
    }

    // MARK: - sendPromptResponse

    @Test("sendPromptResponse sends correct OutgoingMessage and clears prompt")
    func sendPromptResponseSendsAndClears() async throws {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        let sessionId = state.sessions[0].id
        state.setActivePrompt(connectionId: connId, prompt: self.makePromptPayload(requestId: "req-send"))

        var sentConnectionId: UUID?
        var sentMessage: OutgoingMessage?
        state.sendMessageHandler = { connectionId, message in
            sentConnectionId = connectionId
            sentMessage = message
        }

        try await state.sendPromptResponse(sessionId: sessionId, requestId: "req-send", value: .bool(true))

        // Verify the handler was called with correct connection and message
        #expect(sentConnectionId == connId)
        if case let .promptResponse(requestId, value) = sentMessage {
            #expect(requestId == "req-send")
            if case let .bool(v) = value {
                #expect(v == true)
            } else {
                Issue.record("Expected .bool value, got \(value)")
            }
        } else {
            Issue.record("Expected .promptResponse, got \(String(describing: sentMessage))")
        }

        // Prompt should be cleared
        #expect(state.sessions[0].pendingPrompt == nil)
    }

    @Test("sendPromptResponse is a no-op for inactive session")
    func sendPromptResponseInactiveSession() async throws {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        let sessionId = state.sessions[0].id
        state.setActivePrompt(connectionId: connId, prompt: self.makePromptPayload(requestId: "req-inactive"))
        state.markDisconnected(connectionId: connId) // makes session inactive

        var handlerCalled = false
        state.sendMessageHandler = { _, _ in handlerCalled = true }

        try await state.sendPromptResponse(sessionId: sessionId, requestId: "req-inactive", value: .string("test"))
        #expect(handlerCalled == false)
    }

    @Test("sendPromptResponse is a no-op for unknown session ID")
    func sendPromptResponseUnknownSession() async throws {
        let state = SessionState()
        state.addSession(connectionId: UUID(), info: self.makeInfo(command: "agent"))

        var handlerCalled = false
        state.sendMessageHandler = { _, _ in handlerCalled = true }

        try await state.sendPromptResponse(sessionId: UUID(), requestId: "req-unknown", value: .bool(false))
        #expect(handlerCalled == false)
    }

    @Test("sendPromptResponse throws when handler is nil")
    func sendPromptResponseWithoutHandler() async throws {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        let sessionId = state.sessions[0].id

        await #expect(throws: SendError.self) {
            try await state.sendPromptResponse(sessionId: sessionId, requestId: "req-no-handler", value: .bool(true))
        }
    }

    @Test("sendPromptResponse preserves prompt when handler throws")
    func sendPromptResponseHandlerErrorPreservesPrompt() async throws {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        let sessionId = state.sessions[0].id
        state.setActivePrompt(connectionId: connId, prompt: self.makePromptPayload(requestId: "req-err"))

        struct TestSendError: Error {}
        state.sendMessageHandler = { _, _ in throw TestSendError() }

        await #expect(throws: TestSendError.self) {
            try await state.sendPromptResponse(sessionId: sessionId, requestId: "req-err", value: .bool(true))
        }

        // Prompt should still be pending since the send failed
        #expect(state.sessions[0].pendingPrompt?.requestId == "req-err")
    }

    @Test("sendPromptResponse does not clear a newer prompt set during send")
    func sendPromptResponseDoesNotClearNewerPrompt() async throws {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        let sessionId = state.sessions[0].id
        state.setActivePrompt(connectionId: connId, prompt: self.makePromptPayload(requestId: "req-old"))

        // Simulate a new prompt arriving during the send by having the handler
        // replace the pending prompt before returning.
        state.sendMessageHandler = { _, _ in
            state.setActivePrompt(connectionId: connId, prompt: self.makePromptPayload(requestId: "req-new"))
        }

        try await state.sendPromptResponse(sessionId: sessionId, requestId: "req-old", value: .bool(true))

        // The newer prompt should NOT have been cleared
        #expect(state.sessions[0].pendingPrompt?.requestId == "req-new")
    }

    // MARK: - markDisconnected clears pendingPrompt

    @Test("markDisconnected clears pendingPrompt")
    func markDisconnectedClearsPrompt() {
        let state = SessionState()
        let connId = UUID()
        state.addSession(connectionId: connId, info: self.makeInfo(command: "agent"))
        state.setActivePrompt(connectionId: connId, prompt: self.makePromptPayload(requestId: "req-disc"))
        #expect(state.sessions[0].pendingPrompt != nil)

        state.markDisconnected(connectionId: connId)
        #expect(state.sessions[0].pendingPrompt == nil)
    }

    // MARK: - Grouping tests

    @Test("groupedSessions groups sessions by gitRemote")
    func groupedSessionsByGitRemote() {
        let state = SessionState()
        state.addSession(
            connectionId: UUID(),
            info: self.makeInfo(command: "agent1", gitRemote: "git@github.com:owner/repo.git"))
        state.addSession(
            connectionId: UUID(),
            info: self.makeInfo(command: "agent2", gitRemote: "git@github.com:owner/repo.git"))
        state.addSession(
            connectionId: UUID(),
            info: self.makeInfo(command: "agent3", gitRemote: "git@github.com:owner/other.git"))

        let groups = state.groupedSessions
        #expect(groups.count == 2)

        let repoGroup = groups.first { $0.id == "owner/repo" }
        #expect(repoGroup?.sessionCount == 2)
        let otherGroup = groups.first { $0.id == "owner/other" }
        #expect(otherGroup?.sessionCount == 1)
    }

    @Test("groupedSessions follows groupOrder ordering")
    func groupedSessionsOrderFollowsGroupOrder() {
        let state = SessionState()
        state.addSession(
            connectionId: UUID(),
            info: self.makeInfo(command: "agent1", gitRemote: "git@github.com:owner/alpha.git"))
        state.addSession(
            connectionId: UUID(),
            info: self.makeInfo(command: "agent2", gitRemote: "git@github.com:owner/beta.git"))

        // beta was added last, so it's at index 0 in groupOrder (newest first)
        #expect(state.groupedSessions[0].id == "owner/beta")
        #expect(state.groupedSessions[1].id == "owner/alpha")
    }

    @Test("moveGroup reorders groups in groupOrder")
    func moveGroupReorders() {
        let state = SessionState()
        state.addSession(
            connectionId: UUID(),
            info: self.makeInfo(command: "agent1", gitRemote: "git@github.com:owner/alpha.git"))
        state.addSession(
            connectionId: UUID(),
            info: self.makeInfo(command: "agent2", gitRemote: "git@github.com:owner/beta.git"))

        // Initially: [beta, alpha] (beta added last)
        #expect(state.groupedSessions[0].id == "owner/beta")

        // Move alpha (index 1) before beta (to index 0)
        state.moveGroup(from: IndexSet(integer: 1), to: 0)

        #expect(state.groupedSessions[0].id == "owner/alpha")
        #expect(state.groupedSessions[1].id == "owner/beta")
    }

    @Test("firstSessionWithNotification returns first session with notification in display order")
    func firstSessionWithNotification() throws {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()
        state.addSession(
            connectionId: connId1,
            info: self.makeInfo(command: "agent1", gitRemote: "git@github.com:owner/alpha.git"))
        state.addSession(
            connectionId: connId2,
            info: self.makeInfo(command: "agent2", gitRemote: "git@github.com:owner/beta.git"))

        // No notifications yet
        #expect(state.firstSessionWithNotification == nil)

        // Set notification on alpha session (which is in group index 1 since beta was added last)
        let alphaSession = try #require(state.sessions.first { $0.connectionId == connId1 })
        alphaSession.hasUnreadNotification = true

        // alpha is in the second group, so firstSessionWithNotification should return it
        // (no session in beta group has a notification)
        let first = state.firstSessionWithNotification
        #expect(first?.connectionId == connId1)
    }

    @Test("firstSessionWithNotification respects group display order after reorder")
    func firstSessionWithNotificationRespectsGroupOrder() throws {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()

        // Add alpha first, then beta — so beta is at index 0 in groupOrder (most recently added)
        state.addSession(
            connectionId: connId1,
            info: self.makeInfo(command: "agent1", gitRemote: "git@github.com:owner/alpha.git"))
        state.addSession(
            connectionId: connId2,
            info: self.makeInfo(command: "agent2", gitRemote: "git@github.com:owner/beta.git"))

        // Initially: beta is first (index 0), alpha is second (index 1)
        #expect(state.groupedSessions[0].id == "owner/beta")
        #expect(state.groupedSessions[1].id == "owner/alpha")

        // Set notifications on both groups
        let alphaSession = try #require(state.sessions.first { $0.connectionId == connId1 })
        let betaSession = try #require(state.sessions.first { $0.connectionId == connId2 })
        alphaSession.hasUnreadNotification = true
        betaSession.hasUnreadNotification = true

        // Before reorder: beta group is first, so firstSessionWithNotification returns beta's session
        let firstBeforeReorder = state.firstSessionWithNotification
        #expect(firstBeforeReorder?.connectionId == connId2)

        // Reorder: move alpha (index 1) before beta (to index 0)
        state.moveGroup(from: IndexSet(integer: 1), to: 0)
        #expect(state.groupedSessions[0].id == "owner/alpha")

        // After reorder: alpha group is now first, so firstSessionWithNotification returns alpha's session
        let firstAfterReorder = state.firstSessionWithNotification
        #expect(firstAfterReorder?.connectionId == connId1)
    }

    @Test("addSession inserts new group key at index 0 in groupOrder")
    func addSessionInsertsGroupKeyAtFront() {
        let state = SessionState()
        state.addSession(
            connectionId: UUID(),
            info: self.makeInfo(command: "agent1", gitRemote: "git@github.com:owner/alpha.git"))
        state.addSession(
            connectionId: UUID(),
            info: self.makeInfo(command: "agent2", gitRemote: "git@github.com:owner/beta.git"))

        // beta was added last, should be at index 0 in groupOrder
        #expect(state.groupOrder[0] == "owner/beta")
        #expect(state.groupOrder[1] == "owner/alpha")
    }

    @Test("addSession does not duplicate existing group key in groupOrder")
    func addSessionNoDuplicateGroupKey() {
        let state = SessionState()
        state.addSession(
            connectionId: UUID(),
            info: self.makeInfo(command: "agent1", gitRemote: "git@github.com:owner/repo.git"))
        state.addSession(
            connectionId: UUID(),
            info: self.makeInfo(command: "agent2", gitRemote: "git@github.com:owner/repo.git"))

        // Same group key — groupOrder should only contain it once
        #expect(state.groupOrder.count == 1)
        #expect(state.groupOrder[0] == "owner/repo")
    }

    @Test("dismissSession removes empty group keys from groupOrder")
    func dismissSessionCleansGroupOrder() throws {
        let state = SessionState()
        let connId = UUID()
        state.addSession(
            connectionId: connId,
            info: self.makeInfo(command: "agent1", gitRemote: "git@github.com:owner/alpha.git"))
        state.addSession(
            connectionId: UUID(),
            info: self.makeInfo(command: "agent2", gitRemote: "git@github.com:owner/beta.git"))

        #expect(state.groupOrder.count == 2)

        // Mark alpha session as disconnected, then dismiss it
        state.markDisconnected(connectionId: connId)
        let alphaSession = try #require(state.sessions.first { $0.connectionId == connId })
        state.dismissSession(id: alphaSession.id)

        // alpha group should be removed from groupOrder
        #expect(state.groupOrder.count == 1)
        #expect(state.groupOrder[0] == "owner/beta")
    }

    @Test("dismissAllDisconnected removes empty group keys from groupOrder")
    func dismissAllDisconnectedCleansGroupOrder() {
        let state = SessionState()
        let connId1 = UUID()
        state.addSession(
            connectionId: connId1,
            info: self.makeInfo(command: "agent1", gitRemote: "git@github.com:owner/alpha.git"))
        state.addSession(
            connectionId: UUID(),
            info: self.makeInfo(command: "agent2", gitRemote: "git@github.com:owner/beta.git"))

        // Disconnect alpha
        state.markDisconnected(connectionId: connId1)
        state.dismissAllDisconnected()

        #expect(state.groupOrder.count == 1)
        #expect(state.groupOrder.contains("owner/beta"))
        #expect(!state.groupOrder.contains("owner/alpha"))
    }

    @Test("addSession removes stale group key when session metadata changes to new group")
    func addSessionRemovesStaleGroupKeyOnMetadataChange() {
        let state = SessionState()
        let connId = UUID()

        // Add session with gitRemote alpha
        state.addSession(
            connectionId: connId,
            info: self.makeInfo(command: "agent1", gitRemote: "git@github.com:owner/alpha.git"))

        #expect(state.groupOrder.contains("owner/alpha"))
        #expect(!state.groupOrder.contains("owner/beta"))

        // Update same session with different gitRemote (simulates session_info update with changed repo)
        state.addSession(
            connectionId: connId,
            info: self.makeInfo(command: "agent1", gitRemote: "git@github.com:owner/beta.git"))

        // Old key should be gone, new key should be present
        #expect(!state.groupOrder.contains("owner/alpha"))
        #expect(state.groupOrder.contains("owner/beta"))
        #expect(state.groupOrder.count == 1)
    }

    @Test("addSession keeps old group key when another session still uses it after metadata change")
    func addSessionKeepsOldGroupKeyIfOtherSessionUsesIt() {
        let state = SessionState()
        let connId1 = UUID()
        let connId2 = UUID()

        // Two sessions in the same group
        state.addSession(
            connectionId: connId1,
            info: self.makeInfo(command: "agent1", gitRemote: "git@github.com:owner/alpha.git"))
        state.addSession(
            connectionId: connId2,
            info: self.makeInfo(command: "agent2", gitRemote: "git@github.com:owner/alpha.git"))

        #expect(state.groupOrder.count == 1)
        #expect(state.groupOrder.contains("owner/alpha"))

        // Move connId1's session to a different group
        state.addSession(
            connectionId: connId1,
            info: self.makeInfo(command: "agent1", gitRemote: "git@github.com:owner/beta.git"))

        // Old key stays because connId2's session still uses it
        #expect(state.groupOrder.contains("owner/alpha"))
        #expect(state.groupOrder.contains("owner/beta"))
        #expect(state.groupOrder.count == 2)
    }

    @Test("moveGroup works correctly when groupedSessions contains notification-only groups not in groupOrder")
    func moveGroupWithNotificationOnlyGroups() {
        let state = SessionState()

        // Add one normal session (goes into groupOrder)
        state.addSession(
            connectionId: UUID(),
            info: self.makeInfo(command: "agent1", gitRemote: "git@github.com:owner/alpha.git"))

        // Inject a notification-only session for a different workspace (NOT added to groupOrder)
        let notifPayload = MessagePayload(
            message: "Notification from beta",
            workspacePath: "/projects/beta",
            gitRemote: nil,
            terminal: nil)
        state.ingestNotification(payload: notifPayload)

        // groupedSessions should have 2 groups: alpha (from groupOrder) and beta (notification-only, appended)
        #expect(state.groupedSessions.count == 2)
        // groupOrder only contains alpha
        #expect(state.groupOrder.count == 1)
        #expect(state.groupOrder.contains("owner/alpha"))

        // Move the second group (beta, index 1) to position 0
        state.moveGroup(from: IndexSet(integer: 1), to: 0)

        // After move, groupOrder should contain both keys in new order (beta first, then alpha)
        #expect(state.groupOrder.count == 2)
        #expect(state.groupOrder[0] == "/projects/beta")
        #expect(state.groupOrder[1] == "owner/alpha")
    }
}
