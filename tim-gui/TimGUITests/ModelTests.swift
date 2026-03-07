import Foundation
import Testing
@testable import TimGUI

struct ModelTests {
    // MARK: - MessagePayload

    @Test
    func `Decodes full payload with terminal info`() throws {
        let json = """
        {
            "message": "Build complete",
            "workspacePath": "/tmp/project",
            "gitRemote": "github.com/owner/repo",
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
        #expect(payload.gitRemote == "github.com/owner/repo")
        let terminal = try #require(payload.terminal)
        #expect(terminal.type == "wezterm")
        #expect(terminal.paneId == "42")
    }

    @Test
    func `Decodes payload without terminal info`() throws {
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
        #expect(payload.gitRemote == nil)
        #expect(payload.terminal == nil)
    }

    @Test
    func `Rejects payload missing required fields`() {
        let json = """
        { "message": "Hello" }
        """
        let data = Data(json.utf8)
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(MessagePayload.self, from: data)
        }
    }

    // MARK: - TerminalPayload

    @Test
    func `Decodes terminal payload with snake_case pane_id`() throws {
        let json = """
        { "type": "wezterm", "pane_id": "7" }
        """
        let data = Data(json.utf8)
        let terminal = try JSONDecoder().decode(TerminalPayload.self, from: data)

        #expect(terminal.type == "wezterm")
        #expect(terminal.paneId == "7")
    }
}
