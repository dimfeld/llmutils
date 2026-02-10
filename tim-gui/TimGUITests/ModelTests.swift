import Foundation
import Testing

@testable import TimGUI

@Suite("Model decoding")
struct ModelTests {
    // MARK: - MessagePayload

    @Test("Decodes full payload with terminal info")
    func decodesFullPayload() throws {
        let json = """
            {
                "message": "Build complete",
                "workspacePath": "/tmp/project",
                "terminal": {
                    "type": "wezterm",
                    "pane_id": "42"
                }
            }
            """
        let data = Data(json.utf8)
        let payload = try JSONDecoder().decode(MessagePayload.self, from: data)

        #expect(payload.message == "Build complete")
        #expect(payload.workspacePath == "/tmp/project")
        let terminal = try #require(payload.terminal)
        #expect(terminal.type == "wezterm")
        #expect(terminal.paneId == "42")
    }

    @Test("Decodes payload without terminal info")
    func decodesPayloadWithoutTerminal() throws {
        let json = """
            {
                "message": "Done",
                "workspacePath": "/tmp/other"
            }
            """
        let data = Data(json.utf8)
        let payload = try JSONDecoder().decode(MessagePayload.self, from: data)

        #expect(payload.message == "Done")
        #expect(payload.workspacePath == "/tmp/other")
        #expect(payload.terminal == nil)
    }

    @Test("Rejects payload missing required fields")
    func rejectsMissingFields() {
        let json = """
            { "message": "Hello" }
            """
        let data = Data(json.utf8)
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(MessagePayload.self, from: data)
        }
    }

    // MARK: - TerminalPayload

    @Test("Decodes terminal payload with snake_case pane_id")
    func decodesTerminalPayload() throws {
        let json = """
            { "type": "wezterm", "pane_id": "7" }
            """
        let data = Data(json.utf8)
        let terminal = try JSONDecoder().decode(TerminalPayload.self, from: data)

        #expect(terminal.type == "wezterm")
        #expect(terminal.paneId == "7")
    }

    // MARK: - MessageItem

    @Test("MessageItem defaults to unread")
    func messageItemDefaultsUnread() {
        let item = MessageItem(
            message: "test",
            workspacePath: "/tmp",
            terminal: nil,
            receivedAt: Date())
        #expect(!item.isRead)
    }

    @Test("MessageItem generates unique IDs")
    func messageItemUniqueIDs() {
        let a = MessageItem(message: "a", workspacePath: "/a", terminal: nil, receivedAt: Date())
        let b = MessageItem(message: "b", workspacePath: "/b", terminal: nil, receivedAt: Date())
        #expect(a.id != b.id)
    }
}
