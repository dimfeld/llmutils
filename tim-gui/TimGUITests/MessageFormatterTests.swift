import Foundation
import Testing

@testable import TimGUI

@Suite("MessageFormatter")
struct MessageFormatterTests {
    // MARK: - Args messages

    @Test("Formats log args message")
    func formatsLogArgs() {
        let msg = MessageFormatter.format(
            tunnelMessage: .args(type: "log", args: ["Starting", "build", "process"]),
            seq: 1
        )
        #expect(msg.text == "Starting build process")
        #expect(msg.category == .log)
        #expect(msg.seq == 1)
    }

    @Test("Formats error args message as error category")
    func formatsErrorArgs() {
        let msg = MessageFormatter.format(
            tunnelMessage: .args(type: "error", args: ["Something", "failed"]),
            seq: 2
        )
        #expect(msg.text == "Something failed")
        #expect(msg.category == .error)
    }

    @Test("Formats warn args message as error category")
    func formatsWarnArgs() {
        let msg = MessageFormatter.format(
            tunnelMessage: .args(type: "warn", args: ["Watch out"]),
            seq: 3
        )
        #expect(msg.text == "Watch out")
        #expect(msg.category == .error)
    }

    @Test("Formats debug args message as log category")
    func formatsDebugArgs() {
        let msg = MessageFormatter.format(
            tunnelMessage: .args(type: "debug", args: ["debug info"]),
            seq: 4
        )
        #expect(msg.text == "debug info")
        #expect(msg.category == .log)
    }

    // MARK: - Data messages

    @Test("Formats stdout data message")
    func formatsStdout() {
        let msg = MessageFormatter.format(
            tunnelMessage: .data(type: "stdout", data: "hello output"),
            seq: 5
        )
        #expect(msg.text == "hello output")
        #expect(msg.category == .log)
    }

    @Test("Formats stderr data message as error category")
    func formatsStderr() {
        let msg = MessageFormatter.format(
            tunnelMessage: .data(type: "stderr", data: "error output"),
            seq: 6
        )
        #expect(msg.text == "error output")
        #expect(msg.category == .error)
    }

    // MARK: - Structured messages

    @Test("Formats agent_session_start as lifecycle")
    func formatsAgentSessionStart() {
        let payload = AgentSessionStartPayload(
            executor: "claude", mode: "agent", planId: 42,
            sessionId: nil, threadId: nil, tools: nil, mcpServers: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .agentSessionStart(payload)),
            seq: 10
        )
        #expect(msg.category == .lifecycle)
        #expect(msg.text.contains("Starting"))
        #expect(msg.text.contains("Executor: claude"))
        #expect(msg.text.contains("Mode: agent"))
        #expect(msg.text.contains("Plan: 42"))
    }

    @Test("Formats agent_session_end as lifecycle")
    func formatsAgentSessionEnd() {
        let payload = AgentSessionEndPayload(
            success: true, sessionId: nil, threadId: nil,
            durationMs: 45000, costUsd: 1.25, turns: 12, summary: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .agentSessionEnd(payload)),
            seq: 11
        )
        #expect(msg.category == .lifecycle)
        #expect(msg.text.contains("Done"))
        #expect(msg.text.contains("Success: yes"))
        #expect(msg.text.contains("Duration: 45s"))
        #expect(msg.text.contains("Cost: $1.25"))
    }

    @Test("Formats agent_session_end failure")
    func formatsAgentSessionEndFailure() {
        let payload = AgentSessionEndPayload(
            success: false, sessionId: nil, threadId: nil,
            durationMs: nil, costUsd: nil, turns: nil, summary: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .agentSessionEnd(payload)),
            seq: 12
        )
        #expect(msg.text.contains("Success: no"))
    }

    @Test("Formats llm_tool_use as toolUse")
    func formatsLlmToolUse() {
        let payload = LlmToolUsePayload(
            toolName: "Read", inputSummary: "Reading file.ts", timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmToolUse(payload)),
            seq: 20
        )
        #expect(msg.category == .toolUse)
        #expect(msg.text.contains("Invoke Tool: Read"))
        #expect(msg.text.contains("Reading file.ts"))
    }

    @Test("Formats llm_tool_result as toolUse")
    func formatsLlmToolResult() {
        let payload = LlmToolResultPayload(
            toolName: "Read", resultSummary: "File contents here", isError: false, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmToolResult(payload)),
            seq: 21
        )
        #expect(msg.category == .toolUse)
        #expect(msg.text.contains("Tool Result: Read"))
        #expect(msg.text.contains("File contents here"))
    }

    @Test("Formats file_write as fileChange")
    func formatsFileWrite() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .fileWrite(
                path: "/tmp/project/new.ts", lineCount: 42, timestamp: nil)),
            seq: 30
        )
        #expect(msg.category == .fileChange)
        #expect(msg.text.contains("Write"))
        #expect(msg.text.contains("/tmp/project/new.ts"))
        #expect(msg.text.contains("42 lines"))
    }

    @Test("Formats file_edit as fileChange")
    func formatsFileEdit() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .fileEdit(
                path: "src/main.ts", diff: "+new line\n-old line", timestamp: nil)),
            seq: 31
        )
        #expect(msg.category == .fileChange)
        #expect(msg.text.contains("Edit"))
        #expect(msg.text.contains("src/main.ts"))
        #expect(msg.text.contains("+new line"))
    }

    @Test("Formats command_exec as command")
    func formatsCommandExec() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .commandExec(
                command: "npm test", cwd: "/tmp/project", timestamp: nil)),
            seq: 40
        )
        #expect(msg.category == .command)
        #expect(msg.text.contains("Exec Begin"))
        #expect(msg.text.contains("npm test"))
    }

    @Test("Formats command_result as command")
    func formatsCommandResult() {
        let payload = CommandResultPayload(
            command: "npm test", cwd: nil, exitCode: 0, stdout: "All passed",
            stderr: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .commandResult(payload)),
            seq: 41
        )
        #expect(msg.category == .command)
        #expect(msg.text.contains("Exec Finished"))
        #expect(msg.text.contains("All passed"))
    }

    @Test("Formats command_result with nonzero exit code")
    func formatsCommandResultFailure() {
        let payload = CommandResultPayload(
            command: "npm test", cwd: nil, exitCode: 1, stdout: nil,
            stderr: "Test failed", timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .commandResult(payload)),
            seq: 42
        )
        #expect(msg.text.contains("Exit Code: 1"))
        #expect(msg.text.contains("Test failed"))
    }

    @Test("Formats workflow_progress as progress")
    func formatsWorkflowProgress() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .workflowProgress(
                message: "Building project", phase: "build", timestamp: nil)),
            seq: 50
        )
        #expect(msg.category == .progress)
        #expect(msg.text.contains("[build]"))
        #expect(msg.text.contains("Building project"))
    }

    @Test("Formats workflow_progress without phase")
    func formatsWorkflowProgressNoPhase() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .workflowProgress(
                message: "Building project", phase: nil, timestamp: nil)),
            seq: 51
        )
        #expect(msg.text == "Building project")
    }

    @Test("Formats failure_report as error")
    func formatsFailureReport() {
        let payload = FailureReportPayload(
            summary: "Build failed", requirements: "Must compile",
            problems: "Syntax error", solutions: "Fix semicolon",
            sourceAgent: "claude", timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .failureReport(payload)),
            seq: 60
        )
        #expect(msg.category == .error)
        #expect(msg.text.contains("FAILED: Build failed"))
        #expect(msg.text.contains("Requirements:"))
        #expect(msg.text.contains("Problems:"))
        #expect(msg.text.contains("Possible solutions:"))
    }

    @Test("Formats token_usage as log")
    func formatsTokenUsage() {
        let payload = TokenUsagePayload(
            inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200,
            reasoningTokens: nil, totalTokens: 1200, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .tokenUsage(payload)),
            seq: 70
        )
        #expect(msg.category == .log)
        #expect(msg.text.contains("input=1000"))
        #expect(msg.text.contains("cached=500"))
        #expect(msg.text.contains("output=200"))
        #expect(msg.text.contains("total=1200"))
    }

    @Test("Formats input_required as progress")
    func formatsInputRequired() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .inputRequired(
                prompt: "Enter your key", timestamp: nil)),
            seq: 80
        )
        #expect(msg.category == .progress)
        #expect(msg.text.contains("Input required: Enter your key"))
    }

    @Test("Formats task_completion as lifecycle")
    func formatsTaskCompletion() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .taskCompletion(
                taskTitle: "Add tests", planComplete: true, timestamp: nil)),
            seq: 90
        )
        #expect(msg.category == .lifecycle)
        #expect(msg.text.contains("Task complete: Add tests"))
        #expect(msg.text.contains("plan complete"))
    }

    @Test("Formats plan_discovery as lifecycle")
    func formatsPlanDiscovery() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .planDiscovery(
                planId: 169, title: "WebSocket support", timestamp: nil)),
            seq: 100
        )
        #expect(msg.category == .lifecycle)
        #expect(msg.text.contains("Found ready plan: 169 - WebSocket support"))
    }

    @Test("Formats unknown as log")
    func formatsUnknown() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .unknown(type: "future_type")),
            seq: 110
        )
        #expect(msg.category == .log)
        #expect(msg.text.contains("Unknown message type: future_type"))
    }

    @Test("Formats todo_update as progress with status indicators")
    func formatsTodoUpdate() {
        let items = [
            TodoUpdateItem(label: "Done task", status: "completed"),
            TodoUpdateItem(label: "Current task", status: "in_progress"),
            TodoUpdateItem(label: "Waiting task", status: "pending"),
            TodoUpdateItem(label: "Stuck task", status: "blocked"),
        ]
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .todoUpdate(items: items, timestamp: nil)),
            seq: 120
        )
        #expect(msg.category == .progress)
        #expect(msg.text.contains("[x] Done task"))
        #expect(msg.text.contains("[>] Current task"))
        #expect(msg.text.contains("[ ] Waiting task"))
        #expect(msg.text.contains("[!] Stuck task"))
    }

    @Test("Formats llm_thinking as llmOutput")
    func formatsLlmThinking() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmThinking(
                text: "Let me think about this...", timestamp: nil)),
            seq: 130
        )
        #expect(msg.category == .llmOutput)
        #expect(msg.text.contains("Thinking"))
        #expect(msg.text.contains("Let me think about this..."))
    }

    @Test("Formats llm_response as llmOutput")
    func formatsLlmResponse() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmResponse(
                text: "Here is my answer", isUserRequest: false, timestamp: nil)),
            seq: 131
        )
        #expect(msg.category == .llmOutput)
        #expect(msg.text.contains("Model Response"))
        #expect(msg.text.contains("Here is my answer"))
    }

    @Test("Formats llm_response with isUserRequest as User header")
    func formatsLlmResponseUserRequest() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .llmResponse(
                text: "User said something", isUserRequest: true, timestamp: nil)),
            seq: 132
        )
        #expect(msg.text.contains("User"))
        #expect(!msg.text.contains("Model Response"))
    }

    @Test("Formats file_change_summary with indicators")
    func formatsFileChangeSummary() {
        let changes = [
            FileChangeItem(path: "src/new.ts", kind: "added"),
            FileChangeItem(path: "src/main.ts", kind: "updated"),
            FileChangeItem(path: "src/old.ts", kind: "removed"),
        ]
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .fileChangeSummary(
                changes: changes, timestamp: nil)),
            seq: 140
        )
        #expect(msg.category == .fileChange)
        #expect(msg.text.contains("+ src/new.ts"))
        #expect(msg.text.contains("~ src/main.ts"))
        #expect(msg.text.contains("- src/old.ts"))
    }

    @Test("Formats agent_iteration_start")
    func formatsAgentIterationStart() {
        let payload = AgentIterationStartPayload(
            iterationNumber: 3, taskTitle: "Build feature",
            taskDescription: nil, timestamp: nil)
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .agentIterationStart(payload)),
            seq: 150
        )
        #expect(msg.category == .lifecycle)
        #expect(msg.text.contains("Iteration 3"))
        #expect(msg.text.contains("Build feature"))
    }

    @Test("Formats workspace_info as log")
    func formatsWorkspaceInfo() {
        let msg = MessageFormatter.format(
            tunnelMessage: .structured(message: .workspaceInfo(
                path: "/tmp/project", planFile: "tasks/42.plan.md",
                workspaceId: nil, timestamp: nil)),
            seq: 160
        )
        #expect(msg.category == .log)
        #expect(msg.text.contains("/tmp/project"))
        #expect(msg.text.contains("Plan: tasks/42.plan.md"))
    }
}
