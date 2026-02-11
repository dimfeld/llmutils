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
        guard case .sessionInfo(let info) = msg else {
            Issue.record("Expected sessionInfo, got \(msg)")
            return
        }
        #expect(info.command == "agent")
        #expect(info.planId == 42)
        #expect(info.planTitle == "Add dark mode")
        #expect(info.workspacePath == "/tmp/project")
        #expect(info.gitRemote == "git@github.com:user/repo.git")
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
        guard case .sessionInfo(let info) = msg else {
            Issue.record("Expected sessionInfo, got \(msg)")
            return
        }
        #expect(info.command == "review")
        #expect(info.planId == nil)
        #expect(info.planTitle == nil)
        #expect(info.workspacePath == nil)
        #expect(info.gitRemote == nil)
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
        guard case .output(let seq, let tunnelMsg) = msg else {
            Issue.record("Expected output, got \(msg)")
            return
        }
        #expect(seq == 5)
        guard case .args(let type, let args) = tunnelMsg else {
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
        guard case .output(let seq, let tunnelMsg) = msg else {
            Issue.record("Expected output, got \(msg)")
            return
        }
        #expect(seq == 10)
        guard case .data(let type, let data) = tunnelMsg else {
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
        guard case .output(_, let tunnelMsg) = msg else {
            Issue.record("Expected output")
            return
        }
        guard case .structured(let structured) = tunnelMsg else {
            Issue.record("Expected structured tunnel message")
            return
        }
        guard case .workflowProgress(let message, let phase, _) = structured else {
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
        guard case .unknown(let type) = msg else {
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
        guard case .args(let type, let args) = msg else {
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
        guard case .args(let type, let args) = msg else {
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
        guard case .args(let type, _) = msg else {
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
        guard case .args(let type, _) = msg else {
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
        guard case .data(let type, let data) = msg else {
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
        guard case .data(let type, let data) = msg else {
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
        guard case .structured(let structured) = msg else {
            Issue.record("Expected structured message")
            return
        }
        guard case .agentSessionStart(let payload) = structured else {
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
        guard case .unknown(let type) = msg else {
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
        guard case .agentSessionStart(let p) = msg else {
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
        guard case .agentSessionEnd(let p) = msg else {
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
        guard case .agentIterationStart(let p) = msg else {
            Issue.record("Expected agentIterationStart, got \(msg)")
            return
        }
        #expect(p.iterationNumber == 3)
        #expect(p.taskTitle == "Implement feature X")
    }

    @Test("Decodes llm_tool_use")
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
        guard case .llmToolUse(let p) = msg else {
            Issue.record("Expected llmToolUse, got \(msg)")
            return
        }
        #expect(p.toolName == "Read")
        #expect(p.inputSummary == "Reading src/main.ts")
    }

    @Test("Decodes llm_tool_result")
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
        guard case .llmToolResult(let p) = msg else {
            Issue.record("Expected llmToolResult, got \(msg)")
            return
        }
        #expect(p.toolName == "Read")
        #expect(p.resultSummary == "File contents...")
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
        guard case .fileWrite(let path, let lineCount, _) = msg else {
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
        guard case .commandResult(let p) = msg else {
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
        guard case .workflowProgress(let message, let phase, _) = msg else {
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
        guard case .tokenUsage(let p) = msg else {
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
        guard case .planDiscovery(let planId, let title, _) = msg else {
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
        guard case .workspaceInfo(let path, let planFile, let wsId, _) = msg else {
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
        guard case .failureReport(let p) = msg else {
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
        guard case .llmThinking(let text, _) = msg else {
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
        guard case .llmResponse(let text, let isUserRequest, _) = msg else {
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
        guard case .llmStatus(let status, let detail, _) = msg else {
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
        guard case .todoUpdate(let items, _) = msg else {
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
        guard case .fileEdit(let path, let diff, _) = msg else {
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
        guard case .fileChangeSummary(let changes, _) = msg else {
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
        guard case .commandExec(let command, let cwd, _) = msg else {
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
        guard case .agentStepStart(let p) = msg else {
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
        guard case .agentStepEnd(let p) = msg else {
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
        guard case .reviewStart(let executor, let planId, _) = msg else {
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
        guard case .taskCompletion(let title, let planComplete, _) = msg else {
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
        guard case .inputRequired(let prompt, _) = msg else {
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
        guard case .executionSummary(let p) = msg else {
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
        guard case .promptRequest(let p) = msg else {
            Issue.record("Expected promptRequest, got \(msg)")
            return
        }
        #expect(p.requestId == "req-001")
        #expect(p.promptType == "select")
        #expect(p.promptConfig.message == "Choose an option")
        #expect(p.promptConfig.choices?.count == 2)
        #expect(p.promptConfig.choices?[0].name == "Option A")
        #expect(p.promptConfig.choices?[0].value == "a")
        #expect(p.promptConfig.choices?[1].value == "2.0")  // number coerced to string
        #expect(p.timeoutMs == 30000)
    }

    @Test("Decodes prompt_answered")
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
        guard case .promptAnswered(let p) = msg else {
            Issue.record("Expected promptAnswered, got \(msg)")
            return
        }
        #expect(p.requestId == "req-001")
        #expect(p.promptType == "select")
        #expect(p.source == "terminal")
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
                "timestamp": "2026-02-10T08:00:00Z"
            }
            """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case .reviewResult(let p) = msg else {
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
    }

    @Test("Decodes review_verdict")
    func decodesReviewVerdict() throws {
        let json = """
            {
                "type": "review_verdict",
                "verdict": "NEEDS_FIXES",
                "fixInstructions": "Fix the SQL injection",
                "timestamp": "2026-02-10T08:00:00Z"
            }
            """
        let msg = try JSONDecoder().decode(StructuredMessagePayload.self, from: Data(json.utf8))
        guard case .reviewVerdict(let verdict, let fixInstructions, _) = msg else {
            Issue.record("Expected reviewVerdict, got \(msg)")
            return
        }
        #expect(verdict == "NEEDS_FIXES")
        #expect(fixInstructions == "Fix the SQL injection")
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
        guard case .unknown(let type) = msg else {
            Issue.record("Expected unknown, got \(msg)")
            return
        }
        #expect(type == "some_future_message_type")
    }
}
