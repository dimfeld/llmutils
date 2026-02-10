import Foundation
import Testing

@testable import TimGUI

@Suite("AppState", .serialized)
@MainActor
struct AppStateTests {
    @Test("markRead marks the correct item")
    func markRead() {
        let state = AppState()
        state.items = [
            MessageItem(message: "first", workspacePath: "/a", terminal: nil, receivedAt: Date()),
            MessageItem(message: "second", workspacePath: "/b", terminal: nil, receivedAt: Date()),
        ]
        let targetID = state.items[1].id

        state.markRead(targetID)

        #expect(!state.items[0].isRead)
        #expect(state.items[1].isRead)
    }

    @Test("markRead with unknown ID does nothing")
    func markReadUnknownID() {
        let state = AppState()
        state.items = [
            MessageItem(message: "only", workspacePath: "/a", terminal: nil, receivedAt: Date()),
        ]

        state.markRead(UUID())

        #expect(!state.items[0].isRead)
    }

    @Test("ingest adds a new item at the front")
    func ingestAddsItem() {
        let state = AppState()
        state.items = [
            MessageItem(message: "existing", workspacePath: "/old", terminal: nil, receivedAt: Date()),
        ]

        state.ingest(MessagePayload(message: "new", workspacePath: "/new", terminal: nil))

        #expect(state.items.count == 2)
        #expect(state.items[0].message == "new")
        #expect(state.items[1].message == "existing")
    }

    @Test("ingest replaces item with same workspacePath")
    func ingestReplacesExisting() {
        let state = AppState()
        state.items = [
            MessageItem(message: "old msg", workspacePath: "/project", terminal: nil, receivedAt: Date()),
            MessageItem(message: "other", workspacePath: "/other", terminal: nil, receivedAt: Date()),
        ]

        state.ingest(MessagePayload(message: "updated", workspacePath: "/project", terminal: nil))

        #expect(state.items.count == 2)
        #expect(state.items[0].message == "updated")
        #expect(state.items[0].workspacePath == "/project")
        #expect(state.items[1].message == "other")
    }

    @Test("ingest preserves terminal payload on new item")
    func ingestPreservesTerminal() {
        let state = AppState()
        let terminal = TerminalPayload(type: "wezterm", paneId: "5")

        state.ingest(MessagePayload(message: "hello", workspacePath: "/ws", terminal: terminal))

        let item = try? #require(state.items.first)
        #expect(item?.terminal?.type == "wezterm")
        #expect(item?.terminal?.paneId == "5")
    }
}
