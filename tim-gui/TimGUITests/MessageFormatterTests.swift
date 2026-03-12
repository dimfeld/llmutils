import Foundation
import Testing
@testable import TimGUI

@MainActor
struct MessageFormatterTests {
    // MARK: - Args messages

    @Test
    func `Formats log args message`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .args(type: "log", args: ["Starting", "build", "process"]),
            seq: 1)
        #expect(msg.title == nil)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Starting build process")
        #expect(msg.category == .log)
        #expect(msg.seq == 1)
    }

    @Test
    func `Formats error args message as error category`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .args(type: "error", args: ["Something", "failed"]),
            seq: 2)
        #expect(msg.title == nil)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Something failed")
        #expect(msg.category == .error)
    }

    @Test
    func `Formats warn args message as error category`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .args(type: "warn", args: ["Watch out"]),
            seq: 3)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Watch out")
        #expect(msg.category == .error)
    }

    @Test
    func `Formats debug args message as log category`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .args(type: "debug", args: ["debug info"]),
            seq: 4)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "debug info")
        #expect(msg.category == .log)
    }

    // MARK: - Data messages

    @Test
    func `Formats stdout data message`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .data(type: "stdout", data: "hello output"),
            seq: 5)
        #expect(msg.title == nil)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "hello output")
        #expect(msg.category == .log)
    }

    @Test
    func `Formats stderr data message as error category`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .data(type: "stderr", data: "error output"),
            seq: 6)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "error output")
        #expect(msg.category == .error)
    }

    // MARK: - Structured messages

    @Test
    func `Formats agent_session_start as lifecycle with key-value pairs`() {
        let payload = AgentSessionStartPayload(
            executor: "claude", mode: "agent", planId: 42,
            sessionId: nil, threadId: nil, tools: nil, mcpServers: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .agentSessionStart(payload)),
            seq: 10)
        #expect(msg.category == .lifecycle)
        #expect(msg.title == "Starting")
        #expect(msg.timestamp == nil)
        guard case let .keyValuePairs(pairs) = msg.body else {
            Issue.record("Expected .keyValuePairs body")
            return
        }
        #expect(pairs == [
            KeyValuePair(key: "Executor", value: "claude"),
            KeyValuePair(key: "Mode", value: "agent"),
            KeyValuePair(key: "Plan", value: "42"),
        ])
    }

    @Test
    func `Formats agent_session_start with nil fields omits those pairs`() {
        let payload = AgentSessionStartPayload(
            executor: nil, mode: nil, planId: nil,
            sessionId: nil, threadId: nil, tools: nil, mcpServers: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .agentSessionStart(payload)),
            seq: 10)
        #expect(msg.title == "Starting")
        #expect(msg.body == nil)
    }

    @Test
    func `Formats agent_session_end as lifecycle with key-value pairs`() {
        let payload = AgentSessionEndPayload(
            success: true, sessionId: nil, threadId: nil,
            durationMs: 45000, costUsd: 1.25, turns: 12, summary: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .agentSessionEnd(payload)),
            seq: 11)
        #expect(msg.category == .lifecycle)
        #expect(msg.title == "Turn Done")
        #expect(msg.completionKind == .subtask)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Success: yes, Duration: 45s, Cost: $1.25, Turns: 12")
    }

    @Test
    func `Formats agent_session_end failure`() {
        let payload = AgentSessionEndPayload(
            success: false, sessionId: nil, threadId: nil,
            durationMs: nil, costUsd: nil, turns: nil, summary: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .agentSessionEnd(payload)),
            seq: 12)
        #expect(msg.title == "Turn Done")
        #expect(msg.completionKind == .subtask)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Success: no")
    }

    @Test
    func `Formats llm_tool_use as toolUse with monospaced body`() {
        let payload = LlmToolUsePayload(
            toolName: "Read", inputSummary: "Reading file.ts", input: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmToolUse(payload)),
            seq: 20)
        #expect(msg.category == .toolUse)
        #expect(msg.title == "Invoke Tool: Read")
        guard case let .monospaced(body) = msg.body else {
            Issue.record("Expected .monospaced body")
            return
        }
        #expect(body == "Reading file.ts")
    }

    @Test
    func `Formats llm_tool_result as toolUse with monospaced body`() {
        let payload = LlmToolResultPayload(
            toolName: "Read", resultSummary: "File contents here", result: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmToolResult(payload)),
            seq: 21)
        #expect(msg.category == .toolUse)
        #expect(msg.title == "Tool Result: Read")
        guard case let .monospaced(body) = msg.body else {
            Issue.record("Expected .monospaced body")
            return
        }
        #expect(body == "File contents here")
    }

    @Test
    func `Formats llm_tool_use falls back to input when inputSummary is nil`() {
        let payload = LlmToolUsePayload(
            toolName: "Bash", inputSummary: nil, input: "npm test", timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmToolUse(payload)),
            seq: 22)
        #expect(msg.category == .toolUse)
        #expect(msg.title == "Invoke Tool: Bash")
        guard case let .monospaced(body) = msg.body else {
            Issue.record("Expected .monospaced body")
            return
        }
        #expect(body == "npm test")
    }

    @Test
    func `Formats llm_tool_use prefers inputSummary over input`() {
        let payload = LlmToolUsePayload(
            toolName: "Read", inputSummary: "Reading file.ts", input: "src/file.ts", timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmToolUse(payload)),
            seq: 23)
        guard case let .monospaced(body) = msg.body else {
            Issue.record("Expected .monospaced body")
            return
        }
        #expect(body == "Reading file.ts")
        #expect(!body.contains("src/file.ts"))
    }

    @Test
    func `Formats llm_tool_result falls back to result when resultSummary is nil`() {
        let payload = LlmToolResultPayload(
            toolName: "Bash", resultSummary: nil, result: "All tests passed", timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmToolResult(payload)),
            seq: 24)
        #expect(msg.category == .toolUse)
        #expect(msg.title == "Tool Result: Bash")
        guard case let .monospaced(body) = msg.body else {
            Issue.record("Expected .monospaced body")
            return
        }
        #expect(body == "All tests passed")
    }

    @Test
    func `Formats llm_tool_result prefers resultSummary over result`() {
        let payload = LlmToolResultPayload(
            toolName: "Read", resultSummary: "File contents here", result: "full raw output",
            timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmToolResult(payload)),
            seq: 25)
        guard case let .monospaced(body) = msg.body else {
            Issue.record("Expected .monospaced body")
            return
        }
        #expect(body == "File contents here")
        #expect(!body.contains("full raw output"))
    }

    @Test
    func `Formats user_terminal_input as user message instead of unknown`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(
                message: .userTerminalInput(
                    content: "hello from gui",
                    source: .gui,
                    timestamp: "2026-02-10T08:00:00Z")),
            seq: 26)

        #expect(msg.title == "You")
        #expect(msg.seq == 26)
        #expect(!msg.text.contains("Unknown message type"))
        #expect(msg.category == .userInput)

        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "hello from gui")
    }

    @Test
    func `Formats llm_tool_use with neither inputSummary nor input has nil body`() {
        let payload = LlmToolUsePayload(
            toolName: "Bash", inputSummary: nil, input: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmToolUse(payload)),
            seq: 26)
        #expect(msg.category == .toolUse)
        #expect(msg.title == "Invoke Tool: Bash")
        #expect(msg.body == nil)
    }

    @Test
    func `Formats llm_tool_result with neither resultSummary nor result has nil body`() {
        let payload = LlmToolResultPayload(
            toolName: "Write", resultSummary: nil, result: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmToolResult(payload)),
            seq: 27)
        #expect(msg.category == .toolUse)
        #expect(msg.title == "Tool Result: Write")
        #expect(msg.body == nil)
    }

    @Test
    func `Formats file_write as fileChange with monospaced body`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .fileWrite(
                path: "/tmp/project/new.ts", lineCount: 42, timestamp: nil)),
            seq: 30)
        #expect(msg.category == .fileChange)
        #expect(msg.title == "Invoke Tool: Write")
        guard case let .monospaced(body) = msg.body else {
            Issue.record("Expected .monospaced body")
            return
        }
        #expect(body.contains("/tmp/project/new.ts"))
        #expect(body.contains("42 lines"))
    }

    @Test
    func `Formats file_edit as fileChange with monospaced body`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .fileEdit(
                path: "src/main.ts", diff: "+new line\n-old line", timestamp: nil)),
            seq: 31)
        #expect(msg.category == .fileChange)
        #expect(msg.title == "Invoke Tool: Edit")
        guard case let .monospaced(body) = msg.body else {
            Issue.record("Expected .monospaced body")
            return
        }
        #expect(body.contains("src/main.ts"))
        #expect(body.contains("+new line"))
    }

    @Test
    func `Formats command_exec as command with monospaced body`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .commandExec(
                command: "npm test", cwd: "/tmp/project", timestamp: nil)),
            seq: 40)
        #expect(msg.category == .command)
        #expect(msg.title == "Exec Begin")
        guard case let .monospaced(body) = msg.body else {
            Issue.record("Expected .monospaced body")
            return
        }
        #expect(body.contains("npm test"))
        #expect(body.contains("/tmp/project"))
    }

    @Test
    func `Formats command_result as command with monospaced body`() {
        let payload = CommandResultPayload(
            command: "npm test", cwd: nil, exitCode: 0, stdout: "All passed",
            stderr: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .commandResult(payload)),
            seq: 41)
        #expect(msg.category == .command)
        #expect(msg.title == "Exec Finished")
        guard case let .monospaced(body) = msg.body else {
            Issue.record("Expected .monospaced body")
            return
        }
        #expect(body.contains("All passed"))
    }

    @Test
    func `Formats command_result with nonzero exit code`() {
        let payload = CommandResultPayload(
            command: "npm test", cwd: nil, exitCode: 1, stdout: nil,
            stderr: "Test failed", timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .commandResult(payload)),
            seq: 42)
        guard case let .monospaced(body) = msg.body else {
            Issue.record("Expected .monospaced body")
            return
        }
        #expect(body.contains("Exit Code: 1"))
        #expect(body.contains("Test failed"))
    }

    @Test
    func `Formats workflow_progress as progress with text body and no title`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .workflowProgress(
                message: "Building project", phase: "build", timestamp: nil)),
            seq: 50)
        #expect(msg.category == .progress)
        #expect(msg.title == nil)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body.contains("[build]"))
        #expect(body.contains("Building project"))
    }

    @Test
    func `Formats workflow_progress without phase`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .workflowProgress(
                message: "Building project", phase: nil, timestamp: nil)),
            seq: 51)
        #expect(msg.title == nil)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Building project")
    }

    @Test
    func `Formats failure_report as error with text body and no title`() {
        let payload = FailureReportPayload(
            summary: "Build failed", requirements: "Must compile",
            problems: "Syntax error", solutions: "Fix semicolon",
            sourceAgent: "claude", timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .failureReport(payload)),
            seq: 60)
        #expect(msg.category == .error)
        #expect(msg.title == nil)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body.contains("FAILED: Build failed"))
        #expect(body.contains("Requirements:"))
        #expect(body.contains("Problems:"))
        #expect(body.contains("Possible solutions:"))
    }

    @Test
    func `Formats token_usage as log with text body`() {
        let payload = TokenUsagePayload(
            inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200,
            reasoningTokens: nil, totalTokens: 1200, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .tokenUsage(payload)),
            seq: 70)
        #expect(msg.category == .log)
        #expect(msg.title == "Usage")
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body.contains("input=1000"))
        #expect(body.contains("cached=500"))
        #expect(body.contains("output=200"))
        #expect(body.contains("total=1200"))
        #expect(!body.contains("reasoning="))
    }

    @Test
    func `Formats input_required as progress`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .inputRequired(
                prompt: "Enter your key", timestamp: nil)),
            seq: 80)
        #expect(msg.category == .progress)
        #expect(msg.title == "Input Required")
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Input required: Enter your key")
    }

    @Test
    func `Formats task_completion as lifecycle with text body`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .taskCompletion(
                taskTitle: "Add tests", planComplete: true, timestamp: nil)),
            seq: 90)
        #expect(msg.category == .lifecycle)
        #expect(msg.title == "Turn Done")
        #expect(msg.completionKind == .topLevel)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body.contains("Task complete: Add tests"))
        #expect(body.contains("plan complete"))
    }

    @Test
    func `Formats prompt_answered as log with text body and no title`() {
        let payload = PromptAnsweredPayload(
            requestId: "req-001", promptType: "select", source: "terminal",
            value: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .promptAnswered(payload)),
            seq: 95)
        #expect(msg.category == .log)
        #expect(msg.title == nil)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body.contains("Prompt answered"))
        #expect(body.contains("select"))
        #expect(body.contains("terminal"))
    }

    @Test
    func `Formats prompt_answered with value does not display the value`() {
        let payload = PromptAnsweredPayload(
            requestId: "req-002", promptType: "input", source: "gui",
            value: "user response", timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .promptAnswered(payload)),
            seq: 96)
        #expect(msg.category == .log)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Prompt answered (input) by gui")
        #expect(!body.contains("user response"))
    }

    @Test
    func `Formats plan_discovery as lifecycle with text body`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .planDiscovery(
                planId: 169, title: "WebSocket support", timestamp: nil)),
            seq: 100)
        #expect(msg.category == .lifecycle)
        #expect(msg.title == "Plan Discovery")
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Found ready plan: 169 - WebSocket support")
    }

    @Test
    func `Formats unknown as log with text body`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .unknown(type: "future_type")),
            seq: 110)
        #expect(msg.category == .log)
        #expect(msg.title == nil)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Unknown message type: future_type")
    }

    @Test
    func `Formats unknown tunnel message as log with text body`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .unknown(type: "future_tunnel_type"),
            seq: 111)
        #expect(msg.category == .log)
        #expect(msg.title == nil)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Unknown message type: future_tunnel_type")
    }

    @Test
    func `Formats todo_update as progress with todoList body`() {
        let items = [
            TodoUpdateItem(label: "Done task", status: "completed"),
            TodoUpdateItem(label: "Current task", status: "in_progress"),
            TodoUpdateItem(label: "Waiting task", status: "pending"),
            TodoUpdateItem(label: "Stuck task", status: "blocked"),
        ]
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .todoUpdate(items: items, timestamp: nil)),
            seq: 120)
        #expect(msg.category == .progress)
        #expect(msg.title == "Todo Update")
        guard case let .todoList(displayItems) = msg.body else {
            Issue.record("Expected .todoList body")
            return
        }
        #expect(displayItems == [
            TodoDisplayItem(label: "Done task", status: .completed),
            TodoDisplayItem(label: "Current task", status: .inProgress),
            TodoDisplayItem(label: "Waiting task", status: .pending),
            TodoDisplayItem(label: "Stuck task", status: .blocked),
        ])
    }

    @Test
    func `Formats todo_update with unknown status`() {
        let items = [
            TodoUpdateItem(label: "Mystery task", status: "some_future_status"),
        ]
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .todoUpdate(items: items, timestamp: nil)),
            seq: 121)
        guard case let .todoList(displayItems) = msg.body else {
            Issue.record("Expected .todoList body")
            return
        }
        #expect(displayItems == [TodoDisplayItem(label: "Mystery task", status: .unknown)])
    }

    @Test
    func `Formats llm_thinking as llmOutput with text body`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmThinking(
                text: "Let me think about this...", timestamp: nil)),
            seq: 130)
        #expect(msg.category == .llmOutput)
        #expect(msg.title == "Thinking")
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Let me think about this...")
    }

    @Test
    func `Formats llm_response as llmOutput with text body`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmResponse(
                text: "Here is my answer", isUserRequest: false, timestamp: nil)),
            seq: 131)
        #expect(msg.category == .llmOutput)
        #expect(msg.title == "Model Response")
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Here is my answer")
    }

    @Test
    func `Formats llm_response with isUserRequest as User title`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmResponse(
                text: "User said something", isUserRequest: true, timestamp: nil)),
            seq: 132)
        #expect(msg.title == "User")
    }

    @Test
    func `Formats file_change_summary with fileChanges body`() {
        let changes = [
            FileChangeItem(path: "src/new.ts", kind: "added"),
            FileChangeItem(path: "src/main.ts", kind: "updated"),
            FileChangeItem(path: "src/old.ts", kind: "removed"),
        ]
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .fileChangeSummary(
                changes: changes, timestamp: nil)),
            seq: 140)
        #expect(msg.category == .fileChange)
        #expect(msg.title == "File Changes")
        guard case let .fileChanges(displayItems) = msg.body else {
            Issue.record("Expected .fileChanges body")
            return
        }
        #expect(displayItems == [
            FileChangeDisplayItem(path: "src/new.ts", kind: .added),
            FileChangeDisplayItem(path: "src/main.ts", kind: .updated),
            FileChangeDisplayItem(path: "src/old.ts", kind: .removed),
        ])
    }

    @Test
    func `Formats file_change_summary with unknown kind`() {
        let changes = [
            FileChangeItem(path: "src/weird.ts", kind: "some_future_kind"),
        ]
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .fileChangeSummary(
                changes: changes, timestamp: nil)),
            seq: 141)
        guard case let .fileChanges(displayItems) = msg.body else {
            Issue.record("Expected .fileChanges body")
            return
        }
        #expect(displayItems == [FileChangeDisplayItem(path: "src/weird.ts", kind: .unknown)])
    }

    @Test
    func `Formats agent_iteration_start with text body`() {
        let payload = AgentIterationStartPayload(
            iterationNumber: 3, taskTitle: "Build feature",
            taskDescription: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .agentIterationStart(payload)),
            seq: 150)
        #expect(msg.category == .lifecycle)
        #expect(msg.title == "Iteration 3")
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Build feature")
    }

    @Test
    func `Formats agent_step_end success as lifecycle`() {
        let payload = AgentStepEndPayload(
            phase: "implement", success: true, summary: "Completed successfully", timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .agentStepEnd(payload)),
            seq: 155)
        #expect(msg.category == .lifecycle)
        #expect(msg.title == "Step End: implement ✓")
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Completed successfully")
    }

    @Test
    func `Formats agent_step_end failure as error`() {
        let payload = AgentStepEndPayload(
            phase: "review", success: false, summary: "Tests failed", timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .agentStepEnd(payload)),
            seq: 156)
        #expect(msg.category == .error)
        #expect(msg.title == "Step End: review ✗")
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Tests failed")
    }

    @Test
    func `Formats workspace_info as log with key-value pairs`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .workspaceInfo(
                path: "/tmp/project", planFile: "tasks/42.plan.md",
                workspaceId: nil, timestamp: nil)),
            seq: 160)
        #expect(msg.category == .log)
        #expect(msg.title == "Workspace")
        guard case let .keyValuePairs(pairs) = msg.body else {
            Issue.record("Expected .keyValuePairs body")
            return
        }
        #expect(pairs == [
            KeyValuePair(key: "Path", value: "/tmp/project"),
            KeyValuePair(key: "Plan", value: "tasks/42.plan.md"),
        ])
    }

    // MARK: - Agent step start

    @Test
    func `Formats agent_step_start as lifecycle with text body`() {
        let payload = AgentStepStartPayload(
            phase: "implement", executor: "claude", stepNumber: 2,
            attempt: 1, message: "Starting implementation",
            timestamp: "2025-03-10T08:00:00.000Z")
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .agentStepStart(payload)),
            seq: 153)
        #expect(msg.category == .lifecycle)
        #expect(msg.title == "Step Start: implement")
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Starting implementation")
        #expect(msg.timestamp != nil)
    }

    @Test
    func `Formats agent_step_start without message has nil body`() {
        let payload = AgentStepStartPayload(
            phase: "review", executor: nil, stepNumber: nil,
            attempt: nil, message: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .agentStepStart(payload)),
            seq: 154)
        #expect(msg.category == .lifecycle)
        #expect(msg.title == "Step Start: review")
        #expect(msg.body == nil)
        #expect(msg.timestamp == nil)
    }

    // MARK: - LLM status

    @Test
    func `Formats llm_status as log with text body`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmStatus(
                status: "streaming", detail: "Generating response",
                timestamp: "2025-04-01T12:00:00Z")),
            seq: 170)
        #expect(msg.category == .log)
        #expect(msg.title == "Status")
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "streaming\nGenerating response")
        #expect(msg.timestamp != nil)
    }

    @Test
    func `Formats llm_status without detail`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmStatus(
                status: "idle", detail: nil, timestamp: nil)),
            seq: 171)
        #expect(msg.category == .log)
        #expect(msg.title == "Status")
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "idle")
    }

    @Test
    func `Formats Claude rate-limit status details`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmStatus(
                status: "Rate limit warning (seven_day)",
                detail: "Utilization: 77%\nThreshold: 75%\nUsing overage: no\nResets at: 2026-02-20T22:00:00.000Z",
                timestamp: "2026-02-20T21:00:00Z")),
            seq: 172)
        #expect(msg.category == .log)
        #expect(msg.title == "Status")
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body.contains("Rate limit warning (seven_day)"))
        #expect(body.contains("Utilization: 77%"))
        #expect(body.contains("Resets at: 2026-02-20T22:00:00.000Z"))
    }

    // MARK: - Review start

    @Test
    func `Formats review_start as lifecycle with text body`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .reviewStart(
                executor: "claude", planId: 42,
                timestamp: "2025-05-01T09:30:00Z")),
            seq: 180)
        #expect(msg.category == .lifecycle)
        #expect(msg.title == "Executing Review")
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "claude")
        #expect(msg.timestamp != nil)
    }

    @Test
    func `Formats review_start without executor uses fallback`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .reviewStart(
                executor: nil, planId: nil, timestamp: nil)),
            seq: 181)
        #expect(msg.category == .lifecycle)
        #expect(msg.title == "Executing Review")
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "unknown executor")
    }

    // MARK: - Prompt request

    @Test
    func `Formats prompt_request as progress with text body`() {
        let config = PromptConfigPayload(message: "Choose an option", choices: nil)
        let payload = PromptRequestPayload(
            requestId: "req-100", promptType: "select",
            promptConfig: config, timeoutMs: 30000,
            timestamp: "2025-06-15T16:00:00.500Z")
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .promptRequest(payload)),
            seq: 190)
        #expect(msg.category == .progress)
        #expect(msg.title == nil)
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body == "Prompt (select): Choose an option")
        #expect(msg.timestamp != nil)
    }

    // MARK: - Review messages

    @Test
    func `Formats review_result with issues as lifecycle with text body`() {
        let payload = ReviewResultPayload(
            issues: [
                ReviewIssueItem(
                    severity: "critical", category: "security",
                    content: "SQL injection risk", file: "src/user.ts",
                    line: "42", suggestion: "Use parameterized queries"),
                ReviewIssueItem(
                    severity: "info", category: "performance",
                    content: "N+1 query", file: "src/api.ts",
                    line: "10", suggestion: nil),
            ],
            recommendations: ["Use parameterized queries"],
            actionItems: ["Fix query in user.ts"],
            verdict: "NEEDS_FIXES",
            fixInstructions: nil,
            timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .reviewResult(payload)),
            seq: 200)
        #expect(msg.category == .lifecycle)
        #expect(msg.title == "Review Result")
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body.contains("Issues: 2"))
        #expect(body.contains("Critical:"))
        #expect(body.contains("SQL injection risk"))
        #expect(body.contains("(src/user.ts:42)"))
        #expect(body.contains("Info:"))
        #expect(body.contains("N+1 query"))
    }

    @Test
    func `Formats review_result with no issues`() {
        let payload = ReviewResultPayload(
            issues: [], recommendations: [], actionItems: [],
            verdict: nil, fixInstructions: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .reviewResult(payload)),
            seq: 201)
        #expect(msg.category == .lifecycle)
        #expect(msg.title == "Review Result")
        guard case let .text(body) = msg.body else {
            Issue.record("Expected .text body")
            return
        }
        #expect(body.contains("Issues: 0"))
    }

    // MARK: - Execution summary with key-value pairs

    @Test
    func `Formats execution_summary with key-value pairs`() {
        let payload = ExecutionSummaryPayload(
            planId: "42", planTitle: "Add feature", mode: "agent",
            durationMs: 120_000, totalSteps: 5, failedSteps: 1,
            changedFiles: ["src/main.ts"], errors: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .executionSummary(payload)),
            seq: 210)
        #expect(msg.category == .lifecycle)
        #expect(msg.title == "Execution Summary")
        guard case let .keyValuePairs(pairs) = msg.body else {
            Issue.record("Expected .keyValuePairs body")
            return
        }
        let pairDict = Dictionary(uniqueKeysWithValues: pairs.map { ($0.key, $0.value) })
        #expect(pairDict["Plan"] == "42")
        #expect(pairDict["Title"] == "Add feature")
        #expect(pairDict["Mode"] == "agent")
        #expect(pairDict["Duration"] == "120s")
        #expect(pairDict["Steps"] == "5")
        #expect(pairDict["Failed"] == "1")
        #expect(pairDict["Changed files"] == "src/main.ts")
    }

    @Test
    func `Formats execution_summary without optional fields`() {
        let payload = ExecutionSummaryPayload(
            planId: "42", planTitle: nil, mode: nil,
            durationMs: nil, totalSteps: nil, failedSteps: nil,
            changedFiles: nil, errors: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .executionSummary(payload)),
            seq: 211)
        #expect(msg.category == .lifecycle)
        #expect(msg.title == "Execution Summary")
        guard case let .keyValuePairs(pairs) = msg.body else {
            Issue.record("Expected .keyValuePairs body")
            return
        }
        #expect(pairs == [KeyValuePair(key: "Plan", value: "42")])
    }

    @Test
    func `Formats execution_summary with zero failedSteps omits Failed pair`() {
        let payload = ExecutionSummaryPayload(
            planId: nil, planTitle: nil, mode: nil,
            durationMs: nil, totalSteps: 3, failedSteps: 0,
            changedFiles: nil, errors: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .executionSummary(payload)),
            seq: 212)
        guard case let .keyValuePairs(pairs) = msg.body else {
            Issue.record("Expected .keyValuePairs body")
            return
        }
        let keys = pairs.map(\.key)
        #expect(keys.contains("Steps"))
        #expect(!keys.contains("Failed"))
    }

    // MARK: - Timestamp parsing

    @Test
    func `Parses ISO8601 timestamp with fractional seconds`() throws {
        let payload = AgentSessionStartPayload(
            executor: "claude", mode: "agent", planId: nil,
            sessionId: nil, threadId: nil, tools: nil, mcpServers: nil,
            timestamp: "2025-01-15T10:30:00.123Z")
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .agentSessionStart(payload)),
            seq: 300)
        #expect(msg.timestamp != nil)
        let calendar = Calendar(identifier: .gregorian)
        let components = try calendar.dateComponents(
            in: #require(TimeZone(identifier: "UTC")),
            from: #require(msg.timestamp))
        #expect(components.year == 2025)
        #expect(components.month == 1)
        #expect(components.day == 15)
        #expect(components.hour == 10)
        #expect(components.minute == 30)
    }

    @Test
    func `Parses ISO8601 timestamp without fractional seconds`() throws {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmThinking(
                text: "thinking", timestamp: "2025-06-20T14:00:00Z")),
            seq: 301)
        #expect(msg.timestamp != nil)
        let calendar = Calendar(identifier: .gregorian)
        let components = try calendar.dateComponents(
            in: #require(TimeZone(identifier: "UTC")),
            from: #require(msg.timestamp))
        #expect(components.year == 2025)
        #expect(components.month == 6)
        #expect(components.day == 20)
        #expect(components.hour == 14)
    }

    @Test
    func `Returns nil timestamp when timestamp string is nil`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmThinking(
                text: "thinking", timestamp: nil)),
            seq: 302)
        #expect(msg.timestamp == nil)
    }

    @Test
    func `Returns nil timestamp when timestamp string is invalid`() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmThinking(
                text: "thinking", timestamp: "not-a-date")),
            seq: 303)
        #expect(msg.timestamp == nil)
    }

    // MARK: - Backward-compatible text property

    @Test
    func `Backward-compatible text property reconstructs from structured fields`() {
        let items = [
            TodoUpdateItem(label: "Done", status: "completed"),
            TodoUpdateItem(label: "Pending", status: "pending"),
        ]
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .todoUpdate(items: items, timestamp: nil)),
            seq: 400)
        // The text property should reconstruct from title + body
        #expect(msg.text.contains("Todo Update"))
        #expect(msg.text.contains("[x] Done"))
        #expect(msg.text.contains("[ ] Pending"))
    }
}
