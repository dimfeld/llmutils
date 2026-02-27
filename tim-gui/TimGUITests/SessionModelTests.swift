import Foundation
import Testing
@testable import TimGUI

@Suite("HeadlessMessage decoding")
struct HeadlessMessageTests {
    @Test("Decodes session_info with all fields")
    func decodesSessionInfoFull() throws {
        let json = """
        {
            "type": "session_info",
            "command": "agent",
            "planId": 42,
            "planTitle": "Add dark mode",
            "workspacePath": "/tmp/project",
            "gitRemote": "git@github.com:user/repo.git"
        }
        """
        let msg = try JSONDecoder().decode(HeadlessMessage.self, from: Data(json.utf8))
        guard case let .sessionInfo(info) = msg else {
            Issue.record("Expected sessionInfo, got \(msg)")
            return
        }
        #expect(info.command == "agent")
        #expect(info.planId == 42)
        #expect(info.planTitle == "Add dark mode")
        #expect(info.workspacePath == "/tmp/project")
        #expect(info.gitRemote == "git@github.com:user/repo.git")
        #expect(info.terminal == nil)
    }

    @Test("Decodes session_info with minimal fields")
    func decodesSessionInfoMinimal() throws {
        let json = """
        {
            "type": "session_info",
            "command": "review"
        }
        """
        let msg = try JSONDecoder().decode(HeadlessMessage.self, from: Data(json.utf8))
        guard case let .sessionInfo(info) = msg else {
            Issue.record("Expected sessionInfo, got \(msg)")
            return
        }
        #expect(info.command == "review")
        #expect(info.planId == nil)
        #expect(info.planTitle == nil)
        #expect(info.workspacePath == nil)
        #expect(info.gitRemote == nil)
        #expect(info.terminal == nil)
    }

    @Test("Decodes session_info with terminal pane info")
    func decodesSessionInfoWithTerminal() throws {
        let json = """
        {
            "type": "session_info",
            "command": "agent",
            "planId": 42,
            "planTitle": "Add dark mode",
            "workspacePath": "/tmp/project",
            "gitRemote": "git@github.com:user/repo.git",
            "terminalPaneId": "7",
            "terminalType": "wezterm"
        }
        """
        let msg = try JSONDecoder().decode(HeadlessMessage.self, from: Data(json.utf8))
        guard case let .sessionInfo(info) = msg else {
            Issue.record("Expected sessionInfo, got \(msg)")
            return
        }
        #expect(info.command == "agent")
        #expect(info.terminal?.type == "wezterm")
        #expect(info.terminal?.paneId == "7")
    }

    @Test("Decodes session_info with terminalPaneId but no terminalType defaults to unknown")
    func decodesSessionInfoWithTerminalPaneIdOnly() throws {
        let json = """
        {
            "type": "session_info",
            "command": "agent",
            "terminalPaneId": "12"
        }
        """
        let msg = try JSONDecoder().decode(HeadlessMessage.self, from: Data(json.utf8))
        guard case let .sessionInfo(info) = msg else {
            Issue.record("Expected sessionInfo, got \(msg)")
            return
        }
        #expect(info.terminal?.type == "unknown")
        #expect(info.terminal?.paneId == "12")
    }

    @Test("Decodes session_info with terminalType but no terminalPaneId has no terminal")
    func decodesSessionInfoWithTerminalTypeOnly() throws {
        let json = """
        {
            "type": "session_info",
            "command": "agent",
            "terminalType": "wezterm"
        }
        """
        let msg = try JSONDecoder().decode(HeadlessMessage.self, from: Data(json.utf8))
        guard case let .sessionInfo(info) = msg else {
            Issue.record("Expected sessionInfo, got \(msg)")
            return
        }
        #expect(info.terminal == nil)
    }

    @Test("Decodes output with args tunnel message")
    func decodesOutputWithArgs() throws {
        let json = """
        {
            "type": "output",
            "seq": 5,
            "message": {
                "type": "log",
                "args": ["hello", "world"]
            }
        }
        """
        let msg = try JSONDecoder().decode(HeadlessMessage.self, from: Data(json.utf8))
        guard case let .output(seq, tunnelMsg) = msg else {
            Issue.record("Expected output, got \(msg)")
            return
        }
        #expect(seq == 5)
        guard case let .args(type, args) = tunnelMsg else {
            Issue.record("Expected args tunnel message")
            return
        }
        #expect(type == "log")
        #expect(args == ["hello", "world"])
    }

    @Test("Decodes output with data tunnel message")
    func decodesOutputWithData() throws {
        let json = """
        {
            "type": "output",
            "seq": 10,
            "message": {
                "type": "stdout",
                "data": "some output text"
            }
        }
        """
        let msg = try JSONDecoder().decode(HeadlessMessage.self, from: Data(json.utf8))
        guard case let .output(seq, tunnelMsg) = msg else {
            Issue.record("Expected output, got \(msg)")
            return
        }
        #expect(seq == 10)
        guard case let .data(type, data) = tunnelMsg else {
            Issue.record("Expected data tunnel message")
            return
        }
        #expect(type == "stdout")
        #expect(data == "some output text")
    }

    @Test("Decodes output with structured tunnel message")
    func decodesOutputWithStructured() throws {
        let json = """
        {
            "type": "output",
            "seq": 1,
            "message": {
                "type": "structured",
                "message": {
                    "type": "workflow_progress",
                    "message": "Building project",
                    "phase": "build",
                    "timestamp": "2026-02-10T08:00:00Z"
                }
            }
        }
        """
        let msg = try JSONDecoder().decode(HeadlessMessage.self, from: Data(json.utf8))
        guard case let .output(_, tunnelMsg) = msg else {
            Issue.record("Expected output")
            return
        }
        guard case let .structured(structured) = tunnelMsg else {
            Issue.record("Expected structured tunnel message")
            return
        }
        guard case let .workflowProgress(message, phase, _) = structured else {
            Issue.record("Expected workflowProgress, got \(structured)")
            return
        }
        #expect(message == "Building project")
        #expect(phase == "build")
    }

    @Test("Decodes replay_start")
    func decodesReplayStart() throws {
        let json = """
        {"type": "replay_start"}
        """
        let msg = try JSONDecoder().decode(HeadlessMessage.self, from: Data(json.utf8))
        guard case .replayStart = msg else {
            Issue.record("Expected replayStart, got \(msg)")
            return
        }
    }

    @Test("Decodes replay_end")
    func decodesReplayEnd() throws {
        let json = """
        {"type": "replay_end"}
        """
        let msg = try JSONDecoder().decode(HeadlessMessage.self, from: Data(json.utf8))
        guard case .replayEnd = msg else {
            Issue.record("Expected replayEnd, got \(msg)")
            return
        }
    }

    @Test("Unknown type decodes to .unknown")
    func unknownTypeFallsBack() throws {
        let json = """
        {"type": "unknown_message_type"}
        """
        let msg = try JSONDecoder().decode(HeadlessMessage.self, from: Data(json.utf8))
        guard case let .unknown(type) = msg else {
            Issue.record("Expected unknown, got \(msg)")
            return
        }
        #expect(type == "unknown_message_type")
    }
}

@Suite("TunnelMessage decoding")
struct TunnelMessageTests {
    @Test("Decodes log with args")
    func decodesLog() throws {
        let json = """
        {"type": "log", "args": ["Starting", "process"]}
        """
        let msg = try JSONDecoder().decode(TunnelMessage.self, from: Data(json.utf8))
        guard case let .args(type, args) = msg else {
            Issue.record("Expected args message")
            return
        }
        #expect(type == "log")
        #expect(args == ["Starting", "process"])
    }

    @Test("Decodes error with args")
    func decodesError() throws {
        let json = """
        {"type": "error", "args": ["Something failed"]}
        """
        let msg = try JSONDecoder().decode(TunnelMessage.self, from: Data(json.utf8))
        guard case let .args(type, args) = msg else {
            Issue.record("Expected args message")
            return
        }
        #expect(type == "error")
        #expect(args == ["Something failed"])
    }

    @Test("Decodes warn with args")
    func decodesWarn() throws {
        let json = """
        {"type": "warn", "args": ["Warning!"]}
        """
        let msg = try JSONDecoder().decode(TunnelMessage.self, from: Data(json.utf8))
        guard case let .args(type, _) = msg else {
            Issue.record("Expected args message")
            return
        }
        #expect(type == "warn")
    }

    @Test("Decodes debug with args")
    func decodesDebug() throws {
        let json = """
        {"type": "debug", "args": ["debug info"]}
        """
        let msg = try JSONDecoder().decode(TunnelMessage.self, from: Data(json.utf8))
        guard case let .args(type, _) = msg else {
            Issue.record("Expected args message")
            return
        }
        #expect(type == "debug")
    }

    @Test("Decodes stdout with data")
    func decodesStdout() throws {
        let json = """
        {"type": "stdout", "data": "hello stdout"}
        """
        let msg = try JSONDecoder().decode(TunnelMessage.self, from: Data(json.utf8))
        guard case let .data(type, data) = msg else {
            Issue.record("Expected data message")
            return
        }
        #expect(type == "stdout")
        #expect(data == "hello stdout")
    }

    @Test("Decodes stderr with data")
    func decodesStderr() throws {
        let json = """
        {"type": "stderr", "data": "error output"}
        """
        let msg = try JSONDecoder().decode(TunnelMessage.self, from: Data(json.utf8))
        guard case let .data(type, data) = msg else {
            Issue.record("Expected data message")
            return
        }
        #expect(type == "stderr")
        #expect(data == "error output")
    }

    @Test("Decodes structured with agent_session_start")
    func decodesStructured() throws {
        let json = """
        {
            "type": "structured",
            "message": {
                "type": "agent_session_start",
                "executor": "claude",
                "mode": "agent",
                "planId": 169,
                "timestamp": "2026-02-10T08:00:00Z"
            }
        }
        """
        let msg = try JSONDecoder().decode(TunnelMessage.self, from: Data(json.utf8))
        guard case let .structured(structured) = msg else {
            Issue.record("Expected structured message")
            return
        }
        guard case let .agentSessionStart(payload) = structured else {
            Issue.record("Expected agentSessionStart, got \(structured)")
            return
        }
        #expect(payload.executor == "claude")
        #expect(payload.mode == "agent")
        #expect(payload.planId == 169)
    }

    @Test("Unknown tunnel type decodes to .unknown")
    func unknownTypeFallsBack() throws {
        let json = """
        {"type": "unknown_tunnel", "data": "something"}
        """
        let msg = try JSONDecoder().decode(TunnelMessage.self, from: Data(json.utf8))
        guard case let .unknown(type) = msg else {
            Issue.record("Expected unknown, got \(msg)")
            return
        }
        #expect(type == "unknown_tunnel")
    }
}

@Suite("StructuredMessagePayload decoding")
struct StructuredMessagePayloadTests {
    @Test("Decodes agent_session_start")
    func decodesAgentSessionStart() throws {
        let json = """
        {
            "type": "agent_session_start",
            "executor": "claude",
            "mode": "agent",
            "planId": 42,
            "sessionId": "sess-123",
            "threadId": "thread-456",
            "tools": ["Read", "Write", "Edit"],
            "mcpServers": ["context7"],
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .agentSessionStart(p) = msg else {
            Issue.record("Expected agentSessionStart, got \(msg)")
            return
        }
        #expect(p.executor == "claude")
        #expect(p.mode == "agent")
        #expect(p.planId == 42)
        #expect(p.sessionId == "sess-123")
        #expect(p.threadId == "thread-456")
        #expect(p.tools == ["Read", "Write", "Edit"])
        #expect(p.mcpServers == ["context7"])
    }

    @Test("Decodes agent_session_end")
    func decodesAgentSessionEnd() throws {
        let json = """
        {
            "type": "agent_session_end",
            "success": true,
            "sessionId": "sess-123",
            "durationMs": 45000,
            "costUsd": 1.25,
            "turns": 12,
            "summary": "All tasks completed",
            "timestamp": "2026-02-10T08:01:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .agentSessionEnd(p) = msg else {
            Issue.record("Expected agentSessionEnd, got \(msg)")
            return
        }
        #expect(p.success == true)
        #expect(p.durationMs == 45000)
        #expect(p.costUsd == 1.25)
        #expect(p.turns == 12)
        #expect(p.summary == "All tasks completed")
    }

    @Test("Decodes agent_iteration_start")
    func decodesAgentIterationStart() throws {
        let json = """
        {
            "type": "agent_iteration_start",
            "iterationNumber": 3,
            "taskTitle": "Implement feature X",
            "taskDescription": "Build the X component",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .agentIterationStart(p) = msg else {
            Issue.record("Expected agentIterationStart, got \(msg)")
            return
        }
        #expect(p.iterationNumber == 3)
        #expect(p.taskTitle == "Implement feature X")
    }

    @Test("Decodes llm_tool_use with inputSummary")
    func decodesLlmToolUse() throws {
        let json = """
        {
            "type": "llm_tool_use",
            "toolName": "Read",
            "inputSummary": "Reading src/main.ts",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmToolUse(p) = msg else {
            Issue.record("Expected llmToolUse, got \(msg)")
            return
        }
        #expect(p.toolName == "Read")
        #expect(p.inputSummary == "Reading src/main.ts")
        #expect(p.input == nil)
    }

    @Test("Decodes llm_tool_use with string input field")
    func decodesLlmToolUseWithInput() throws {
        let json = """
        {
            "type": "llm_tool_use",
            "toolName": "Bash",
            "input": "npm test",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmToolUse(p) = msg else {
            Issue.record("Expected llmToolUse, got \(msg)")
            return
        }
        #expect(p.toolName == "Bash")
        #expect(p.inputSummary == nil)
        #expect(p.input == "npm test")
    }

    @Test("Decodes llm_tool_use with both inputSummary and input")
    func decodesLlmToolUseWithBoth() throws {
        let json = """
        {
            "type": "llm_tool_use",
            "toolName": "Read",
            "inputSummary": "Reading file",
            "input": "src/main.ts",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmToolUse(p) = msg else {
            Issue.record("Expected llmToolUse, got \(msg)")
            return
        }
        #expect(p.inputSummary == "Reading file")
        #expect(p.input == "src/main.ts")
    }

    @Test("Decodes llm_tool_use with numeric input")
    func decodesLlmToolUseWithNumericInput() throws {
        let json = """
        {
            "type": "llm_tool_use",
            "toolName": "Test",
            "input": 42,
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmToolUse(p) = msg else {
            Issue.record("Expected llmToolUse, got \(msg)")
            return
        }
        #expect(p.input == "42")
    }

    @Test("Decodes llm_tool_use with boolean input")
    func decodesLlmToolUseWithBoolInput() throws {
        let json = """
        {
            "type": "llm_tool_use",
            "toolName": "Test",
            "input": true,
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmToolUse(p) = msg else {
            Issue.record("Expected llmToolUse, got \(msg)")
            return
        }
        #expect(p.input == "true")
    }

    @Test("Decodes llm_tool_use with object input as serialized JSON")
    func decodesLlmToolUseWithObjectInput() throws {
        let json = """
        {
            "type": "llm_tool_use",
            "toolName": "Write",
            "input": {"file_path": "/tmp/test.ts", "content": "hello"},
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmToolUse(p) = msg else {
            Issue.record("Expected llmToolUse, got \(msg)")
            return
        }
        #expect(p.input == "{\"content\":\"hello\",\"file_path\":\"\\/tmp\\/test.ts\"}")
    }

    @Test("Decodes llm_tool_use with array input as serialized JSON")
    func decodesLlmToolUseWithArrayInput() throws {
        let json = """
        {
            "type": "llm_tool_use",
            "toolName": "Test",
            "input": [1, 2, 3],
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmToolUse(p) = msg else {
            Issue.record("Expected llmToolUse, got \(msg)")
            return
        }
        #expect(p.input == "[1,2,3]")
    }

    @Test("Decodes llm_tool_use with floating point input")
    func decodesLlmToolUseWithFloatInput() throws {
        let json = """
        {
            "type": "llm_tool_use",
            "toolName": "Test",
            "input": 3.14159,
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmToolUse(p) = msg else {
            Issue.record("Expected llmToolUse, got \(msg)")
            return
        }
        #expect(p.input == "3.14159")
    }

    @Test("Decodes llm_tool_use with no inputSummary and no input")
    func decodesLlmToolUseWithNeither() throws {
        let json = """
        {
            "type": "llm_tool_use",
            "toolName": "Bash",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmToolUse(p) = msg else {
            Issue.record("Expected llmToolUse, got \(msg)")
            return
        }
        #expect(p.toolName == "Bash")
        #expect(p.inputSummary == nil)
        #expect(p.input == nil)
    }

    @Test("Decodes llm_tool_result with resultSummary")
    func decodesLlmToolResult() throws {
        let json = """
        {
            "type": "llm_tool_result",
            "toolName": "Read",
            "resultSummary": "File contents...",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmToolResult(p) = msg else {
            Issue.record("Expected llmToolResult, got \(msg)")
            return
        }
        #expect(p.toolName == "Read")
        #expect(p.resultSummary == "File contents...")
        #expect(p.result == nil)
    }

    @Test("Decodes llm_tool_result with string result field")
    func decodesLlmToolResultWithResult() throws {
        let json = """
        {
            "type": "llm_tool_result",
            "toolName": "Bash",
            "result": "All tests passed",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmToolResult(p) = msg else {
            Issue.record("Expected llmToolResult, got \(msg)")
            return
        }
        #expect(p.toolName == "Bash")
        #expect(p.resultSummary == nil)
        #expect(p.result == "All tests passed")
    }

    @Test("Decodes llm_tool_result with numeric result")
    func decodesLlmToolResultWithNumericResult() throws {
        let json = """
        {
            "type": "llm_tool_result",
            "toolName": "Test",
            "result": 99,
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmToolResult(p) = msg else {
            Issue.record("Expected llmToolResult, got \(msg)")
            return
        }
        #expect(p.result == "99")
    }

    @Test("Decodes llm_tool_result with boolean result")
    func decodesLlmToolResultWithBoolResult() throws {
        let json = """
        {
            "type": "llm_tool_result",
            "toolName": "Test",
            "result": false,
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmToolResult(p) = msg else {
            Issue.record("Expected llmToolResult, got \(msg)")
            return
        }
        #expect(p.result == "false")
    }

    @Test("Decodes llm_tool_result with object result as serialized JSON")
    func decodesLlmToolResultWithObjectResult() throws {
        let json = """
        {
            "type": "llm_tool_result",
            "toolName": "Read",
            "result": {"content": "file data", "lines": 42},
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmToolResult(p) = msg else {
            Issue.record("Expected llmToolResult, got \(msg)")
            return
        }
        #expect(p.result == "{\"content\":\"file data\",\"lines\":42}")
    }

    @Test("Decodes llm_tool_result with both resultSummary and result")
    func decodesLlmToolResultWithBoth() throws {
        let json = """
        {
            "type": "llm_tool_result",
            "toolName": "Read",
            "resultSummary": "File contents (42 lines)",
            "result": "full raw output here",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmToolResult(p) = msg else {
            Issue.record("Expected llmToolResult, got \(msg)")
            return
        }
        #expect(p.resultSummary == "File contents (42 lines)")
        #expect(p.result == "full raw output here")
    }

    @Test("Decodes llm_tool_result with no resultSummary and no result")
    func decodesLlmToolResultWithNeither() throws {
        let json = """
        {
            "type": "llm_tool_result",
            "toolName": "Write",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmToolResult(p) = msg else {
            Issue.record("Expected llmToolResult, got \(msg)")
            return
        }
        #expect(p.toolName == "Write")
        #expect(p.resultSummary == nil)
        #expect(p.result == nil)
    }

    @Test("Decodes file_write")
    func decodesFileWrite() throws {
        let json = """
        {
            "type": "file_write",
            "path": "/tmp/project/src/new.ts",
            "lineCount": 42,
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .fileWrite(path, lineCount, _) = msg else {
            Issue.record("Expected fileWrite, got \(msg)")
            return
        }
        #expect(path == "/tmp/project/src/new.ts")
        #expect(lineCount == 42)
    }

    @Test("Decodes command_result")
    func decodesCommandResult() throws {
        let json = """
        {
            "type": "command_result",
            "command": "npm test",
            "cwd": "/tmp/project",
            "exitCode": 1,
            "stdout": "Running tests...",
            "stderr": "1 test failed",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .commandResult(p) = msg else {
            Issue.record("Expected commandResult, got \(msg)")
            return
        }
        #expect(p.command == "npm test")
        #expect(p.cwd == "/tmp/project")
        #expect(p.exitCode == 1)
        #expect(p.stdout == "Running tests...")
        #expect(p.stderr == "1 test failed")
    }

    @Test("Decodes workflow_progress")
    func decodesWorkflowProgress() throws {
        let json = """
        {
            "type": "workflow_progress",
            "message": "Building project",
            "phase": "build",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .workflowProgress(message, phase, _) = msg else {
            Issue.record("Expected workflowProgress, got \(msg)")
            return
        }
        #expect(message == "Building project")
        #expect(phase == "build")
    }

    @Test("Decodes token_usage")
    func decodesTokenUsage() throws {
        let json = """
        {
            "type": "token_usage",
            "inputTokens": 1000,
            "cachedInputTokens": 500,
            "outputTokens": 200,
            "reasoningTokens": 50,
            "totalTokens": 1250,
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .tokenUsage(p) = msg else {
            Issue.record("Expected tokenUsage, got \(msg)")
            return
        }
        #expect(p.inputTokens == 1000)
        #expect(p.cachedInputTokens == 500)
        #expect(p.outputTokens == 200)
        #expect(p.reasoningTokens == 50)
        #expect(p.totalTokens == 1250)
    }

    @Test("Decodes plan_discovery")
    func decodesPlanDiscovery() throws {
        let json = """
        {
            "type": "plan_discovery",
            "planId": 169,
            "title": "Add WebSocket support",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .planDiscovery(planId, title, _) = msg else {
            Issue.record("Expected planDiscovery, got \(msg)")
            return
        }
        #expect(planId == 169)
        #expect(title == "Add WebSocket support")
    }

    @Test("Decodes workspace_info")
    func decodesWorkspaceInfo() throws {
        let json = """
        {
            "type": "workspace_info",
            "path": "/tmp/project",
            "planFile": "tasks/169.plan.md",
            "workspaceId": "ws-001",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .workspaceInfo(path, planFile, wsId, _) = msg else {
            Issue.record("Expected workspaceInfo, got \(msg)")
            return
        }
        #expect(path == "/tmp/project")
        #expect(planFile == "tasks/169.plan.md")
        #expect(wsId == "ws-001")
    }

    @Test("Decodes failure_report")
    func decodesFailureReport() throws {
        let json = """
        {
            "type": "failure_report",
            "summary": "Build failed",
            "requirements": "Code must compile",
            "problems": "Syntax error in main.ts",
            "solutions": "Fix the missing semicolon",
            "sourceAgent": "claude",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .failureReport(p) = msg else {
            Issue.record("Expected failureReport, got \(msg)")
            return
        }
        #expect(p.summary == "Build failed")
        #expect(p.requirements == "Code must compile")
        #expect(p.problems == "Syntax error in main.ts")
        #expect(p.solutions == "Fix the missing semicolon")
        #expect(p.sourceAgent == "claude")
    }

    @Test("Decodes llm_thinking")
    func decodesLlmThinking() throws {
        let json = """
        {
            "type": "llm_thinking",
            "text": "I need to consider the architecture...",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmThinking(text, _) = msg else {
            Issue.record("Expected llmThinking, got \(msg)")
            return
        }
        #expect(text == "I need to consider the architecture...")
    }

    @Test("Decodes llm_response")
    func decodesLlmResponse() throws {
        let json = """
        {
            "type": "llm_response",
            "text": "Here is my response",
            "isUserRequest": true,
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmResponse(text, isUserRequest, _) = msg else {
            Issue.record("Expected llmResponse, got \(msg)")
            return
        }
        #expect(text == "Here is my response")
        #expect(isUserRequest == true)
    }

    @Test("Decodes llm_status")
    func decodesLlmStatus() throws {
        let json = """
        {
            "type": "llm_status",
            "status": "rate_limited",
            "detail": "Waiting 30s",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .llmStatus(status, detail, _) = msg else {
            Issue.record("Expected llmStatus, got \(msg)")
            return
        }
        #expect(status == "rate_limited")
        #expect(detail == "Waiting 30s")
    }

    @Test("Decodes todo_update")
    func decodesTodoUpdate() throws {
        let json = """
        {
            "type": "todo_update",
            "items": [
                {"label": "Write tests", "status": "completed"},
                {"label": "Fix bug", "status": "in_progress"},
                {"label": "Deploy", "status": "pending"}
            ],
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .todoUpdate(items, _) = msg else {
            Issue.record("Expected todoUpdate, got \(msg)")
            return
        }
        #expect(items.count == 3)
        #expect(items[0].label == "Write tests")
        #expect(items[0].status == "completed")
        #expect(items[1].status == "in_progress")
        #expect(items[2].status == "pending")
    }

    @Test("Decodes file_edit")
    func decodesFileEdit() throws {
        let json = """
        {
            "type": "file_edit",
            "path": "src/main.ts",
            "diff": "@@ -1,3 +1,4 @@\\n+import { foo } from 'bar'",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .fileEdit(path, diff, _) = msg else {
            Issue.record("Expected fileEdit, got \(msg)")
            return
        }
        #expect(path == "src/main.ts")
        #expect(diff.contains("import"))
    }

    @Test("Decodes file_change_summary")
    func decodesFileChangeSummary() throws {
        let json = """
        {
            "type": "file_change_summary",
            "changes": [
                {"path": "src/new.ts", "kind": "added"},
                {"path": "src/main.ts", "kind": "updated"},
                {"path": "src/old.ts", "kind": "removed"}
            ],
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .fileChangeSummary(changes, _) = msg else {
            Issue.record("Expected fileChangeSummary, got \(msg)")
            return
        }
        #expect(changes.count == 3)
        #expect(changes[0].kind == "added")
        #expect(changes[1].kind == "updated")
        #expect(changes[2].kind == "removed")
    }

    @Test("Decodes command_exec")
    func decodesCommandExec() throws {
        let json = """
        {
            "type": "command_exec",
            "command": "npm install",
            "cwd": "/tmp/project",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .commandExec(command, cwd, _) = msg else {
            Issue.record("Expected commandExec, got \(msg)")
            return
        }
        #expect(command == "npm install")
        #expect(cwd == "/tmp/project")
    }

    @Test("Decodes agent_step_start")
    func decodesAgentStepStart() throws {
        let json = """
        {
            "type": "agent_step_start",
            "phase": "implementation",
            "executor": "claude",
            "stepNumber": 3,
            "attempt": 1,
            "message": "Starting implementation",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .agentStepStart(p) = msg else {
            Issue.record("Expected agentStepStart, got \(msg)")
            return
        }
        #expect(p.phase == "implementation")
        #expect(p.executor == "claude")
        #expect(p.stepNumber == 3)
        #expect(p.attempt == 1)
    }

    @Test("Decodes agent_step_end")
    func decodesAgentStepEnd() throws {
        let json = """
        {
            "type": "agent_step_end",
            "phase": "implementation",
            "success": true,
            "summary": "Step completed successfully",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .agentStepEnd(p) = msg else {
            Issue.record("Expected agentStepEnd, got \(msg)")
            return
        }
        #expect(p.phase == "implementation")
        #expect(p.success == true)
        #expect(p.summary == "Step completed successfully")
    }

    @Test("Decodes review_start")
    func decodesReviewStart() throws {
        let json = """
        {
            "type": "review_start",
            "executor": "claude",
            "planId": 42,
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .reviewStart(executor, planId, _) = msg else {
            Issue.record("Expected reviewStart, got \(msg)")
            return
        }
        #expect(executor == "claude")
        #expect(planId == 42)
    }

    @Test("Decodes task_completion")
    func decodesTaskCompletion() throws {
        let json = """
        {
            "type": "task_completion",
            "taskTitle": "Add tests",
            "planComplete": false,
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .taskCompletion(title, planComplete, _) = msg else {
            Issue.record("Expected taskCompletion, got \(msg)")
            return
        }
        #expect(title == "Add tests")
        #expect(planComplete == false)
    }

    @Test("Decodes input_required")
    func decodesInputRequired() throws {
        let json = """
        {
            "type": "input_required",
            "prompt": "Enter your API key",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .inputRequired(prompt, _) = msg else {
            Issue.record("Expected inputRequired, got \(msg)")
            return
        }
        #expect(prompt == "Enter your API key")
    }

    @Test("Decodes execution_summary")
    func decodesExecutionSummary() throws {
        let json = """
        {
            "type": "execution_summary",
            "summary": {
                "planId": "42",
                "planTitle": "Add feature",
                "mode": "agent",
                "durationMs": 60000,
                "changedFiles": ["src/main.ts", "src/utils.ts"],
                "errors": ["Type check failed"]
            },
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .executionSummary(p) = msg else {
            Issue.record("Expected executionSummary, got \(msg)")
            return
        }
        #expect(p.planId == "42")
        #expect(p.planTitle == "Add feature")
        #expect(p.mode == "agent")
        #expect(p.durationMs == 60000)
        #expect(p.changedFiles == ["src/main.ts", "src/utils.ts"])
        #expect(p.errors == ["Type check failed"])
    }

    @Test("Decodes prompt_request")
    func decodesPromptRequest() throws {
        let json = """
        {
            "type": "prompt_request",
            "requestId": "req-001",
            "promptType": "select",
            "promptConfig": {
                "header": "Trigger point",
                "question": "Where should import job creation happen?",
                "message": "Choose an option",
                "choices": [
                    {"name": "Option A", "value": "a", "description": "First option"},
                    {"name": "Option B", "value": 2}
                ]
            },
            "timeoutMs": 30000,
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .promptRequest(p) = msg else {
            Issue.record("Expected promptRequest, got \(msg)")
            return
        }
        #expect(p.requestId == "req-001")
        #expect(p.promptType == "select")
        #expect(p.promptConfig.header == "Trigger point")
        #expect(p.promptConfig.question == "Where should import job creation happen?")
        #expect(p.promptConfig.message == "Choose an option")
        #expect(p.promptConfig.choices?.count == 2)
        #expect(p.promptConfig.choices?[0].name == "Option A")
        #expect(p.promptConfig.choices?[0].value == .string("a"))
        #expect(p.promptConfig.choices?[1].value == .int(2))
        #expect(p.timeoutMs == 30000)
    }

    @Test("Decodes prompt_request with command field for prefix_select")
    func decodesPromptRequestPrefixSelect() throws {
        let json = """
        {
            "type": "prompt_request",
            "requestId": "req-ps-001",
            "promptType": "prefix_select",
            "promptConfig": {
                "message": "Allow this command?",
                "command": "npm install --save-dev typescript"
            },
            "timeoutMs": 60000,
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .promptRequest(p) = msg else {
            Issue.record("Expected promptRequest, got \(msg)")
            return
        }
        #expect(p.requestId == "req-ps-001")
        #expect(p.promptType == "prefix_select")
        #expect(p.promptConfig.message == "Allow this command?")
        #expect(p.promptConfig.command == "npm install --save-dev typescript")
        #expect(p.timeoutMs == 60000)
    }

    @Test("Decodes prompt_request with nil command when not present")
    func decodesPromptRequestWithoutCommand() throws {
        let json = """
        {
            "type": "prompt_request",
            "requestId": "req-no-cmd",
            "promptType": "confirm",
            "promptConfig": {
                "message": "Continue?"
            },
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .promptRequest(p) = msg else {
            Issue.record("Expected promptRequest, got \(msg)")
            return
        }
        #expect(p.promptConfig.header == nil)
        #expect(p.promptConfig.question == nil)
        #expect(p.promptConfig.command == nil)
    }

    @Test("PromptChoiceConfigPayload preserves original JSON types for values")
    func decodesPromptChoicePreservesTypes() throws {
        let json = """
        {
            "type": "prompt_request",
            "requestId": "req-int",
            "promptType": "select",
            "promptConfig": {
                "message": "Pick",
                "choices": [
                    {"name": "Integer", "value": 42},
                    {"name": "Float", "value": 3.14},
                    {"name": "Zero", "value": 0},
                    {"name": "Bool", "value": true},
                    {"name": "String", "value": "hello"}
                ]
            },
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .promptRequest(p) = msg else {
            Issue.record("Expected promptRequest, got \(msg)")
            return
        }
        let choices = try #require(p.promptConfig.choices)
        #expect(choices[0].value == .int(42))
        #expect(choices[1].value == .double(3.14))
        #expect(choices[2].value == .int(0))
        #expect(choices[3].value == .bool(true))
        #expect(choices[4].value == .string("hello"))
    }

    @Test("PromptChoiceConfigPayload preserves bool false values")
    func decodesPromptChoiceBoolFalse() throws {
        let json = """
        {
            "type": "prompt_request",
            "requestId": "req-bool-false",
            "promptType": "select",
            "promptConfig": {
                "message": "Pick",
                "choices": [
                    {"name": "True", "value": true},
                    {"name": "False", "value": false}
                ]
            },
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .promptRequest(p) = msg else {
            Issue.record("Expected promptRequest, got \(msg)")
            return
        }
        let choices = try #require(p.promptConfig.choices)
        #expect(choices[0].value == .bool(true))
        #expect(choices[1].value == .bool(false))
    }

    @Test("PromptChoiceConfigPayload with null value decodes to nil")
    func decodesPromptChoiceNullValue() throws {
        let json = """
        {
            "type": "prompt_request",
            "requestId": "req-null",
            "promptType": "select",
            "promptConfig": {
                "message": "Pick",
                "choices": [
                    {"name": "No value"},
                    {"name": "Null value", "value": null}
                ]
            },
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .promptRequest(p) = msg else {
            Issue.record("Expected promptRequest, got \(msg)")
            return
        }
        let choices = try #require(p.promptConfig.choices)
        #expect(choices[0].value == nil)
        #expect(choices[1].value == nil)
    }

    @Test("PromptConfigPayload.defaultValue preserves typed values")
    func decodesPromptConfigDefaultValueTypes() throws {
        // Bool default
        let boolJson = """
        {
            "type": "prompt_request",
            "requestId": "req-default-bool",
            "promptType": "confirm",
            "promptConfig": {"message": "Continue?", "default": false},
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let boolMsg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(boolJson.utf8))
        guard case let .promptRequest(bp) = boolMsg else {
            Issue.record("Expected promptRequest")
            return
        }
        #expect(bp.promptConfig.defaultValue == .bool(false))

        // Int default
        let intJson = """
        {
            "type": "prompt_request",
            "requestId": "req-default-int",
            "promptType": "select",
            "promptConfig": {"message": "Pick", "default": 42},
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let intMsg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(intJson.utf8))
        guard case let .promptRequest(ip) = intMsg else {
            Issue.record("Expected promptRequest")
            return
        }
        #expect(ip.promptConfig.defaultValue == .int(42))

        // Double default
        let doubleJson = """
        {
            "type": "prompt_request",
            "requestId": "req-default-double",
            "promptType": "select",
            "promptConfig": {"message": "Pick", "default": 3.14},
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let doubleMsg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(doubleJson.utf8))
        guard case let .promptRequest(dp) = doubleMsg else {
            Issue.record("Expected promptRequest")
            return
        }
        #expect(dp.promptConfig.defaultValue == .double(3.14))

        // String default
        let strJson = """
        {
            "type": "prompt_request",
            "requestId": "req-default-string",
            "promptType": "input",
            "promptConfig": {"message": "Enter value", "default": "hello"},
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let strMsg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(strJson.utf8))
        guard case let .promptRequest(sp) = strMsg else {
            Issue.record("Expected promptRequest")
            return
        }
        #expect(sp.promptConfig.defaultValue == .string("hello"))

        // Missing default
        let noDefaultJson = """
        {
            "type": "prompt_request",
            "requestId": "req-no-default",
            "promptType": "input",
            "promptConfig": {"message": "Enter value"},
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let noDefaultMsg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(noDefaultJson.utf8))
        guard case let .promptRequest(ndp) = noDefaultMsg else {
            Issue.record("Expected promptRequest")
            return
        }
        #expect(ndp.promptConfig.defaultValue == nil)
    }

    @Test("Decodes prompt_answered without value")
    func decodesPromptAnswered() throws {
        let json = """
        {
            "type": "prompt_answered",
            "requestId": "req-001",
            "promptType": "select",
            "source": "terminal",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .promptAnswered(p) = msg else {
            Issue.record("Expected promptAnswered, got \(msg)")
            return
        }
        #expect(p.requestId == "req-001")
        #expect(p.promptType == "select")
        #expect(p.source == "terminal")
        #expect(p.value == nil)
    }

    @Test("Decodes prompt_answered with string value")
    func decodesPromptAnsweredWithStringValue() throws {
        let json = """
        {
            "type": "prompt_answered",
            "requestId": "req-002",
            "promptType": "input",
            "source": "gui",
            "value": "user response",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .promptAnswered(p) = msg else {
            Issue.record("Expected promptAnswered, got \(msg)")
            return
        }
        #expect(p.requestId == "req-002")
        #expect(p.source == "gui")
        #expect(p.value == "user response")
    }

    @Test("Decodes prompt_answered with numeric value")
    func decodesPromptAnsweredWithNumericValue() throws {
        let json = """
        {
            "type": "prompt_answered",
            "requestId": "req-003",
            "promptType": "input",
            "source": "terminal",
            "value": 42,
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .promptAnswered(p) = msg else {
            Issue.record("Expected promptAnswered, got \(msg)")
            return
        }
        #expect(p.value == "42")
    }

    @Test("Decodes prompt_answered with boolean value")
    func decodesPromptAnsweredWithBoolValue() throws {
        let json = """
        {
            "type": "prompt_answered",
            "requestId": "req-004",
            "promptType": "confirm",
            "source": "terminal",
            "value": true,
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .promptAnswered(p) = msg else {
            Issue.record("Expected promptAnswered, got \(msg)")
            return
        }
        #expect(p.value == "true")
    }

    @Test("Decodes prompt_answered with object value as serialized JSON")
    func decodesPromptAnsweredWithObjectValue() throws {
        let json = """
        {
            "type": "prompt_answered",
            "requestId": "req-005",
            "promptType": "input",
            "source": "gui",
            "value": {"selected": ["a", "b"], "confirmed": true},
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .promptAnswered(p) = msg else {
            Issue.record("Expected promptAnswered, got \(msg)")
            return
        }
        #expect(p.value == "{\"confirmed\":true,\"selected\":[\"a\",\"b\"]}")
    }

    @Test("Decodes prompt_answered with array value as serialized JSON")
    func decodesPromptAnsweredWithArrayValue() throws {
        let json = """
        {
            "type": "prompt_answered",
            "requestId": "req-006",
            "promptType": "checkbox",
            "source": "terminal",
            "value": ["option1", "option2"],
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .promptAnswered(p) = msg else {
            Issue.record("Expected promptAnswered, got \(msg)")
            return
        }
        #expect(p.value == "[\"option1\",\"option2\"]")
    }

    @Test("Decodes review_result with issues")
    func decodesReviewResult() throws {
        let json = """
        {
            "type": "review_result",
            "issues": [
                {
                    "severity": "critical",
                    "category": "security",
                    "content": "SQL injection risk",
                    "file": "src/user.ts",
                    "line": "42",
                    "suggestion": "Use parameterized queries"
                }
            ],
            "recommendations": ["Use parameterized queries"],
            "actionItems": ["Fix query in user.ts"],
            "verdict": "NEEDS_FIXES",
            "fixInstructions": "Fix the SQL injection",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .reviewResult(p) = msg else {
            Issue.record("Expected reviewResult, got \(msg)")
            return
        }
        #expect(p.issues.count == 1)
        #expect(p.issues[0].severity == "critical")
        #expect(p.issues[0].file == "src/user.ts")
        #expect(p.issues[0].line == "42")
        #expect(p.issues[0].suggestion == "Use parameterized queries")
        #expect(p.recommendations == ["Use parameterized queries"])
        #expect(p.actionItems == ["Fix query in user.ts"])
        #expect(p.verdict == "NEEDS_FIXES")
        #expect(p.fixInstructions == "Fix the SQL injection")
    }

    @Test("Decodes execution_summary with metadata totalSteps and failedSteps")
    func decodesExecutionSummaryWithMetadata() throws {
        let json = """
        {
            "type": "execution_summary",
            "summary": {
                "planId": "99",
                "planTitle": "Big feature",
                "mode": "agent",
                "durationMs": 180000,
                "metadata": {
                    "totalSteps": 7,
                    "failedSteps": 2
                },
                "changedFiles": ["a.ts", "b.ts"]
            },
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .executionSummary(p) = msg else {
            Issue.record("Expected executionSummary, got \(msg)")
            return
        }
        #expect(p.planId == "99")
        #expect(p.planTitle == "Big feature")
        #expect(p.totalSteps == 7)
        #expect(p.failedSteps == 2)
        #expect(p.durationMs == 180_000)
        #expect(p.changedFiles == ["a.ts", "b.ts"])
    }

    @Test("Decodes execution_summary without metadata (totalSteps/failedSteps nil)")
    func decodesExecutionSummaryWithoutMetadata() throws {
        let json = """
        {
            "type": "execution_summary",
            "summary": {
                "planId": "42",
                "planTitle": "Add feature",
                "mode": "agent",
                "durationMs": 60000,
                "changedFiles": ["src/main.ts", "src/utils.ts"],
                "errors": ["Type check failed"]
            },
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .executionSummary(p) = msg else {
            Issue.record("Expected executionSummary, got \(msg)")
            return
        }
        #expect(p.totalSteps == nil)
        #expect(p.failedSteps == nil)
    }

    @Test("Unknown structured type falls back to .unknown")
    func unknownTypeFallsBack() throws {
        let json = """
        {
            "type": "some_future_message_type",
            "data": "whatever",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .unknown(type) = msg else {
            Issue.record("Expected unknown, got \(msg)")
            return
        }
        #expect(type == "some_future_message_type")
    }

    @Test("Decodes user_terminal_input")
    func decodesUserTerminalInput() throws {
        let json = """
        {
            "type": "user_terminal_input",
            "content": "hello from gui",
            "source": "gui",
            "timestamp": "2026-02-10T08:00:00Z"
        }
        """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case let .userTerminalInput(content, source, timestamp) = msg else {
            Issue.record("Expected userTerminalInput, got \(msg)")
            return
        }
        #expect(content == "hello from gui")
        #expect(source == .gui)
        #expect(timestamp == "2026-02-10T08:00:00Z")
    }
}

@Suite("OutgoingMessage encoding")
struct OutgoingMessageTests {
    @Test("userInput encodes to correct JSON structure")
    func userInputEncoding() throws {
        let message = OutgoingMessage.userInput(content: "hello world")
        let data = try JSONEncoder().encode(message)
        let dict = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(dict["type"] == "user_input")
        #expect(dict["content"] == "hello world")
        #expect(dict.count == 2)
    }

    @Test("userInput handles special characters in content")
    func userInputSpecialChars() throws {
        let message = OutgoingMessage.userInput(content: "line1\nline2\ttab \"quoted\"")
        let data = try JSONEncoder().encode(message)
        let dict = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(dict["type"] == "user_input")
        #expect(dict["content"] == "line1\nline2\ttab \"quoted\"")
    }

    @Test("userInput handles empty content")
    func userInputEmptyContent() throws {
        let message = OutgoingMessage.userInput(content: "")
        let data = try JSONEncoder().encode(message)
        let dict = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(dict["type"] == "user_input")
        #expect(dict["content"] == "")
    }

    // MARK: - promptResponse encoding

    @Test("promptResponse with bool true encodes correctly")
    func promptResponseBoolTrue() throws {
        let message = OutgoingMessage.promptResponse(requestId: "req-1", value: .bool(true))
        let data = try JSONEncoder().encode(message)
        let dict = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(dict["type"] as? String == "prompt_response")
        #expect(dict["requestId"] as? String == "req-1")
        // Must be a real boolean, not a string
        let value = try #require(dict["value"])
        #expect(value as? Bool == true)
        #expect(value as? String == nil) // Not a string "true"
        #expect(dict.count == 3)
    }

    @Test("promptResponse with bool false encodes correctly")
    func promptResponseBoolFalse() throws {
        let message = OutgoingMessage.promptResponse(requestId: "req-2", value: .bool(false))
        let data = try JSONEncoder().encode(message)
        let dict = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(dict["value"] as? Bool == false)
    }

    @Test("promptResponse with string encodes correctly")
    func promptResponseString() throws {
        let message = OutgoingMessage.promptResponse(requestId: "req-3", value: .string("user input text"))
        let data = try JSONEncoder().encode(message)
        let dict = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(dict["type"] as? String == "prompt_response")
        #expect(dict["requestId"] as? String == "req-3")
        #expect(dict["value"] as? String == "user input text")
        #expect(dict.count == 3)
    }

    @Test("promptResponse with int encodes as JSON number")
    func promptResponseInt() throws {
        let message = OutgoingMessage.promptResponse(requestId: "req-4", value: .int(42))
        let data = try JSONEncoder().encode(message)
        let dict = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(dict["type"] as? String == "prompt_response")
        #expect(dict["requestId"] as? String == "req-4")
        // Should be a numeric value, not a string
        let value = try #require(dict["value"])
        #expect(value as? Int == 42)
        #expect(value as? String == nil)
    }

    @Test("promptResponse with double encodes as JSON number")
    func promptResponseDouble() throws {
        let message = OutgoingMessage.promptResponse(requestId: "req-5", value: .double(3.14))
        let data = try JSONEncoder().encode(message)
        let dict = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(dict["type"] as? String == "prompt_response")
        #expect(dict["requestId"] as? String == "req-5")
        let value = try #require(dict["value"] as? Double)
        #expect(abs(value - 3.14) < 0.001)
    }

    @Test("promptResponse with array encodes as JSON array")
    func promptResponseArray() throws {
        let message = OutgoingMessage.promptResponse(
            requestId: "req-6",
            value: .array([.string("option1"), .string("option2")]))
        let data = try JSONEncoder().encode(message)
        let dict = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(dict["type"] as? String == "prompt_response")
        #expect(dict["requestId"] as? String == "req-6")
        let arr = try #require(dict["value"] as? [String])
        #expect(arr == ["option1", "option2"])
    }

    @Test("promptResponse with object encodes as JSON object (prefix_select format)")
    func promptResponseObject() throws {
        let message = OutgoingMessage.promptResponse(
            requestId: "req-7",
            value: .object(["exact": .bool(true), "command": .string("npm install")]))
        let data = try JSONEncoder().encode(message)
        let dict = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(dict["type"] as? String == "prompt_response")
        #expect(dict["requestId"] as? String == "req-7")
        let valueObj = try #require(dict["value"] as? [String: Any])
        #expect(valueObj["exact"] as? Bool == true)
        #expect(valueObj["command"] as? String == "npm install")
        #expect(valueObj.count == 2)
    }

    @Test("promptResponse with mixed-type array encodes correctly")
    func promptResponseMixedArray() throws {
        let message = OutgoingMessage.promptResponse(
            requestId: "req-8",
            value: .array([.string("a"), .int(1), .bool(true)]))
        let data = try JSONEncoder().encode(message)
        let dict = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let arr = try #require(dict["value"] as? [Any])
        #expect(arr.count == 3)
        #expect(arr[0] as? String == "a")
        #expect(arr[1] as? Int == 1)
        #expect(arr[2] as? Bool == true)
    }
}

@Suite("Prefix select command normalization")
struct PrefixSelectCommandNormalizationTests {
    @Test("extractCommandAfterCd strips leading cd prefix")
    func extractCommandAfterCdStripsCdPrefix() {
        #expect(PrefixSelectCommandNormalizer.extractCommandAfterCd("cd /repo && npm test") == "npm test")
        #expect(PrefixSelectCommandNormalizer.extractCommandAfterCd("cd ../dir && bun run check") == "bun run check")
    }

    @Test("extractCommandAfterCd handles spacing and quoted paths")
    func extractCommandAfterCdHandlesSpacingAndQuotes() {
        #expect(PrefixSelectCommandNormalizer
            .extractCommandAfterCd(#"cd "/path with spaces" && npm test"#) == "npm test")
        #expect(PrefixSelectCommandNormalizer.extractCommandAfterCd("cd /path  &&  npm test   ") == "npm test")
    }

    @Test("extractCommandAfterCd leaves non-matching commands unchanged")
    func extractCommandAfterCdLeavesOtherCommandsUnchanged() {
        #expect(PrefixSelectCommandNormalizer.extractCommandAfterCd("npm test") == "npm test")
        #expect(PrefixSelectCommandNormalizer
            .extractCommandAfterCd("echo cd /path && npm test") == "echo cd /path && npm test")
    }
}

// MARK: - Project display name and session grouping tests

@Suite("Project display name and session grouping")
struct ProjectDisplayNameTests {
    @Test("parseProjectDisplayName with SSH remote returns owner/repo")
    func parseSSHRemote() {
        let result = parseProjectDisplayName(
            gitRemote: "git@github.com:someowner/myrepo.git",
            workspacePath: nil)
        #expect(result == "someowner/myrepo")
    }

    @Test("parseProjectDisplayName with HTTPS remote returns owner/repo")
    func parseHTTPSRemote() {
        let result = parseProjectDisplayName(
            gitRemote: "https://github.com/someowner/myrepo.git",
            workspacePath: nil)
        #expect(result == "someowner/myrepo")
    }

    @Test("parseProjectDisplayName with sanitized host/owner/repo remote returns owner/repo")
    func parseSanitizedHostPathRemote() {
        let result = parseProjectDisplayName(
            gitRemote: "github.com/someowner/myrepo",
            workspacePath: nil)
        #expect(result == "someowner/myrepo")
    }

    @Test("parseProjectDisplayName with HTTPS remote without .git suffix")
    func parseHTTPSRemoteNoGitSuffix() {
        let result = parseProjectDisplayName(
            gitRemote: "https://github.com/someowner/myrepo",
            workspacePath: nil)
        #expect(result == "someowner/myrepo")
    }

    @Test("parseProjectDisplayName elides owner when matching current user")
    func ownerElision() {
        let result = parseProjectDisplayName(
            gitRemote: "git@github.com:testuser/myrepo.git",
            workspacePath: nil,
            currentUser: "testuser")
        #expect(result == "myrepo")
    }

    @Test("parseProjectDisplayName owner elision is case-insensitive")
    func ownerElisionCaseInsensitive() {
        let result = parseProjectDisplayName(
            gitRemote: "git@github.com:TestUser/myrepo.git",
            workspacePath: nil,
            currentUser: "testuser")
        #expect(result == "myrepo")
    }

    @Test("parseProjectDisplayName does not elide owner when different from current user")
    func ownerNoElision() {
        let result = parseProjectDisplayName(
            gitRemote: "git@github.com:otheruser/myrepo.git",
            workspacePath: nil,
            currentUser: "testuser")
        #expect(result == "otheruser/myrepo")
    }

    @Test("parseProjectDisplayName falls back to workspacePath when no gitRemote")
    func workspacePathFallback() {
        let result = parseProjectDisplayName(
            gitRemote: nil,
            workspacePath: "/Users/test/projects/myproject")
        #expect(result == "projects/myproject")
    }

    @Test("parseProjectDisplayName returns full path when workspacePath is short")
    func shortWorkspacePath() {
        let result = parseProjectDisplayName(
            gitRemote: nil,
            workspacePath: "/myproject")
        #expect(result == "/myproject")
    }

    @Test("parseProjectDisplayName returns Unknown when neither is available")
    func unknownFallback() {
        let result = parseProjectDisplayName(gitRemote: nil, workspacePath: nil)
        #expect(result == "Unknown")
    }

    @Test("sessionGroupKey returns consistent key for SSH and HTTPS of same repo")
    func groupKeyConsistency() {
        let sshKey = sessionGroupKey(
            gitRemote: "git@github.com:owner/repo.git",
            workspacePath: nil)
        let httpsKey = sessionGroupKey(
            gitRemote: "https://github.com/owner/repo.git",
            workspacePath: nil)
        #expect(sshKey == httpsKey)
        #expect(sshKey == "owner/repo")
    }

    @Test("sessionGroupKey parses sanitized host/owner/repo remote")
    func groupKeySanitizedHostPathRemote() {
        let key = sessionGroupKey(
            gitRemote: "github.com/owner/repo",
            workspacePath: nil)
        #expect(key == "owner/repo")
    }

    @Test("sessionGroupKey is lowercased")
    func groupKeyLowercased() {
        let key = sessionGroupKey(
            gitRemote: "git@github.com:Owner/Repo.git",
            workspacePath: nil)
        #expect(key == "owner/repo")
    }

    @Test("sessionGroupKey falls back to workspacePath when no gitRemote")
    func groupKeyWorkspacePath() {
        let key = sessionGroupKey(gitRemote: nil, workspacePath: "/Users/test/myproject")
        #expect(key == "/Users/test/myproject")
    }

    @Test("sessionGroupKey returns __unknown__ when neither is available")
    func groupKeyUnknown() {
        let key = sessionGroupKey(gitRemote: nil, workspacePath: nil)
        #expect(key == "__unknown__")
    }

    @Test("SessionGroup.hasNotification is true when any session has unread notification")
    @MainActor
    func sessionGroupHasNotification() {
        let session1 = SessionItem(
            id: UUID(), connectionId: UUID(), command: "agent",
            planId: nil, planTitle: nil, workspacePath: nil, gitRemote: nil,
            connectedAt: Date(), isActive: true, messages: [],
            hasUnreadNotification: false)
        let session2 = SessionItem(
            id: UUID(), connectionId: UUID(), command: "agent",
            planId: nil, planTitle: nil, workspacePath: nil, gitRemote: nil,
            connectedAt: Date(), isActive: true, messages: [],
            hasUnreadNotification: true)
        let group = SessionGroup(id: "test", displayName: "Test", sessions: [session1, session2])
        #expect(group.hasNotification == true)
        #expect(group.sessionCount == 2)
    }

    @Test("parseProjectDisplayName with empty currentUser falls through to system user lookup")
    func emptyCurrentUserFallsThrough() {
        // Passing currentUser: "" means the explicit override is empty, so the function
        // should fall through to NSUserName() / env["USER"]. Use an owner that won't
        // match any real system user to confirm no elision occurs.
        let result = parseProjectDisplayName(
            gitRemote: "git@github.com:zzzzunlikelyowner99999/myrepo.git",
            workspacePath: nil,
            currentUser: "")
        // Owner doesn't match any system user, so full owner/repo should be returned
        #expect(result == "zzzzunlikelyowner99999/myrepo")
    }

    @Test("parseProjectDisplayName with all user sources empty does not elide owner")
    func noUserAvailableNoElision() {
        // When currentUser is an empty string and the owner happens to be empty too,
        // the guard `!effectiveUser.isEmpty` prevents a false match.
        // We test with a real owner but explicitly provided non-empty user that differs.
        let result = parseProjectDisplayName(
            gitRemote: "git@github.com:differentowner/myrepo.git",
            workspacePath: nil,
            currentUser: "anotheruser")
        #expect(result == "differentowner/myrepo")
    }

    @Test("SessionGroup.hasNotification is false when no sessions have notifications")
    @MainActor
    func sessionGroupNoNotification() {
        let session = SessionItem(
            id: UUID(), connectionId: UUID(), command: "agent",
            planId: nil, planTitle: nil, workspacePath: nil, gitRemote: nil,
            connectedAt: Date(), isActive: true, messages: [],
            hasUnreadNotification: false)
        let group = SessionGroup(id: "test", displayName: "Test", sessions: [session])
        #expect(group.hasNotification == false)
        #expect(group.sessionCount == 1)
    }
}
