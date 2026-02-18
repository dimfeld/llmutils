import Foundation
import Observation

// MARK: - MessageCategory

enum MessageCategory: Sendable {
    case lifecycle
    case llmOutput
    case toolUse
    case fileChange
    case command
    case progress
    case error
    case log
    case userInput
}

// MARK: - PromptResponseValue

enum PromptResponseValue: Sendable, Encodable, Equatable {
    case bool(Bool)
    case string(String)
    case int(Int)
    case double(Double)
    case array([PromptResponseValue])
    case object([String: PromptResponseValue])

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .bool(v):
            try container.encode(v)
        case let .string(v):
            try container.encode(v)
        case let .int(v):
            try container.encode(v)
        case let .double(v):
            try container.encode(v)
        case let .array(v):
            try container.encode(v)
        case let .object(v):
            try container.encode(v)
        }
    }
}

// MARK: - OutgoingMessage

enum OutgoingMessage: Encodable {
    case userInput(content: String)
    case promptResponse(requestId: String, value: PromptResponseValue)

    enum CodingKeys: String, CodingKey {
        case type
        case content
        case requestId
        case value
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .userInput(content):
            try container.encode("user_input", forKey: .type)
            try container.encode(content, forKey: .content)
        case let .promptResponse(requestId, value):
            try container.encode("prompt_response", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(value, forKey: .value)
        }
    }
}

// MARK: - MessageContentBody

enum MessageContentBody: Sendable {
    case text(String)
    case monospaced(String)
    case todoList([TodoDisplayItem])
    case fileChanges([FileChangeDisplayItem])
    case keyValuePairs([KeyValuePair])
}

struct TodoDisplayItem: Sendable, Equatable {
    let label: String
    let status: TodoStatus
}

enum TodoStatus: Sendable {
    case completed, inProgress, pending, blocked, unknown
}

struct FileChangeDisplayItem: Sendable, Equatable {
    let path: String
    let kind: FileChangeKind
}

enum FileChangeKind: Sendable {
    case added, updated, removed, unknown
}

struct KeyValuePair: Sendable, Equatable {
    let key: String
    let value: String
}

// MARK: - SessionMessage

struct SessionMessage: Identifiable, Sendable {
    let id: UUID
    let seq: Int
    let title: String?
    let body: MessageContentBody?
    let category: MessageCategory
    let timestamp: Date?

    init(seq: Int, title: String?, body: MessageContentBody?, category: MessageCategory, timestamp: Date? = nil) {
        self.id = UUID()
        self.seq = seq
        self.title = title
        self.body = body
        self.category = category
        self.timestamp = timestamp
    }

    /// Convenience initializer for backward compatibility (tests, previews).
    init(seq: Int, text: String, category: MessageCategory, timestamp: Date? = nil) {
        self.init(seq: seq, title: nil, body: .text(text), category: category, timestamp: timestamp)
    }

    /// Flat text representation for backward-compatible test assertions.
    var text: String {
        var parts: [String] = []
        if let title { parts.append(title) }
        if let body {
            switch body {
            case let .text(s), let .monospaced(s):
                parts.append(s)
            case let .todoList(items):
                for item in items {
                    let indicator = switch item.status {
                    case .completed: "[x]"
                    case .inProgress: "[>]"
                    case .blocked: "[!]"
                    case .pending: "[ ]"
                    case .unknown: "[?]"
                    }
                    parts.append("\(indicator) \(item.label)")
                }
            case let .fileChanges(items):
                for item in items {
                    let indicator = switch item.kind {
                    case .added: "+"
                    case .updated: "~"
                    case .removed: "-"
                    case .unknown: "?"
                    }
                    parts.append("\(indicator) \(item.path)")
                }
            case let .keyValuePairs(pairs):
                for pair in pairs {
                    parts.append("\(pair.key): \(pair.value)")
                }
            }
        }
        return parts.joined(separator: "\n")
    }
}

// MARK: - SessionItem

@MainActor
@Observable
final class SessionItem: Identifiable {
    let id: UUID
    var connectionId: UUID
    var command: String
    var planId: Int?
    var planTitle: String?
    var workspacePath: String?
    var gitRemote: String?
    let connectedAt: Date
    var isActive: Bool
    var messages: [SessionMessage]
    var forceScrollToBottomVersion: Int
    var terminal: TerminalPayload?
    var pendingPrompt: PromptRequestPayload?
    var hasUnreadNotification: Bool
    var notificationMessage: String?
    var displayTitle: String {
        let trimmedTitle = self.planTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmedTitle, !trimmedTitle.isEmpty {
            return trimmedTitle
        }
        return self.command
    }

    init(
        id: UUID,
        connectionId: UUID,
        command: String,
        planId: Int?,
        planTitle: String?,
        workspacePath: String?,
        gitRemote: String?,
        connectedAt: Date,
        isActive: Bool,
        messages: [SessionMessage],
        forceScrollToBottomVersion: Int = 0,
        terminal: TerminalPayload? = nil,
        pendingPrompt: PromptRequestPayload? = nil,
        hasUnreadNotification: Bool = false,
        notificationMessage: String? = nil)
    {
        self.id = id
        self.connectionId = connectionId
        self.command = command
        self.planId = planId
        self.planTitle = planTitle
        self.workspacePath = workspacePath
        self.gitRemote = gitRemote
        self.connectedAt = connectedAt
        self.isActive = isActive
        self.messages = messages
        self.forceScrollToBottomVersion = forceScrollToBottomVersion
        self.terminal = terminal
        self.pendingPrompt = pendingPrompt
        self.hasUnreadNotification = hasUnreadNotification
        self.notificationMessage = notificationMessage
    }
}

// MARK: - HeadlessMessage

enum HeadlessMessage: Sendable {
    case sessionInfo(SessionInfoPayload)
    case output(seq: Int, message: TunnelMessage)
    case replayStart
    case replayEnd
    case unknown(type: String)
}

struct SessionInfoPayload: Sendable {
    let command: String
    let planId: Int?
    let planTitle: String?
    let workspacePath: String?
    let gitRemote: String?
    let terminal: TerminalPayload?
}

extension HeadlessMessage: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type
        case seq
        case message
        case command
        case planId
        case planTitle
        case workspacePath
        case gitRemote
        case terminalPaneId
        case terminalType
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "session_info":
            let command = try container.decode(String.self, forKey: .command)
            let planId = try container.decodeIfPresent(Int.self, forKey: .planId)
            let planTitle = try container.decodeIfPresent(String.self, forKey: .planTitle)
            let workspacePath = try container.decodeIfPresent(String.self, forKey: .workspacePath)
            let gitRemote = try container.decodeIfPresent(String.self, forKey: .gitRemote)
            let terminalPaneId = try container.decodeIfPresent(String.self, forKey: .terminalPaneId)
            let terminalType = try container.decodeIfPresent(String.self, forKey: .terminalType)
            let terminal: TerminalPayload? = terminalPaneId.map { paneId in
                TerminalPayload(type: terminalType ?? "unknown", paneId: paneId)
            }
            self = .sessionInfo(SessionInfoPayload(
                command: command, planId: planId, planTitle: planTitle,
                workspacePath: workspacePath, gitRemote: gitRemote,
                terminal: terminal))
        case "output":
            let seq = try container.decode(Int.self, forKey: .seq)
            let message = try container.decode(TunnelMessage.self, forKey: .message)
            self = .output(seq: seq, message: message)
        case "replay_start":
            self = .replayStart
        case "replay_end":
            self = .replayEnd
        default:
            self = .unknown(type: type)
        }
    }
}

// MARK: - TunnelMessage

enum TunnelMessage: Sendable {
    case args(type: String, args: [String])
    case data(type: String, data: String)
    case structured(message: StructuredMessagePayload)
    case unknown(type: String)
}

extension TunnelMessage: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type
        case args
        case data
        case message
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "log", "error", "warn", "debug":
            let args = try container.decode([String].self, forKey: .args)
            self = .args(type: type, args: args)
        case "stdout", "stderr":
            let data = try container.decode(String.self, forKey: .data)
            self = .data(type: type, data: data)
        case "structured":
            let message = try container.decode(StructuredMessagePayload.self, forKey: .message)
            self = .structured(message: message)
        default:
            self = .unknown(type: type)
        }
    }
}

// MARK: - StructuredMessagePayload

enum StructuredMessagePayload: Sendable {
    case agentSessionStart(AgentSessionStartPayload)
    case agentSessionEnd(AgentSessionEndPayload)
    case agentIterationStart(AgentIterationStartPayload)
    case agentStepStart(AgentStepStartPayload)
    case agentStepEnd(AgentStepEndPayload)
    case llmThinking(text: String, timestamp: String?)
    case llmResponse(text: String, isUserRequest: Bool?, timestamp: String?)
    case llmToolUse(LlmToolUsePayload)
    case llmToolResult(LlmToolResultPayload)
    case llmStatus(status: String, detail: String?, timestamp: String?)
    case todoUpdate(items: [TodoUpdateItem], timestamp: String?)
    case fileWrite(path: String, lineCount: Int, timestamp: String?)
    case fileEdit(path: String, diff: String, timestamp: String?)
    case fileChangeSummary(changes: [FileChangeItem], timestamp: String?)
    case commandExec(command: String, cwd: String?, timestamp: String?)
    case commandResult(CommandResultPayload)
    case reviewStart(executor: String?, planId: Int?, timestamp: String?)
    case reviewResult(ReviewResultPayload)
    case reviewVerdict(verdict: String, fixInstructions: String?, timestamp: String?)
    case workflowProgress(message: String, phase: String?, timestamp: String?)
    case failureReport(FailureReportPayload)
    case taskCompletion(taskTitle: String?, planComplete: Bool, timestamp: String?)
    case executionSummary(ExecutionSummaryPayload)
    case tokenUsage(TokenUsagePayload)
    case inputRequired(prompt: String?, timestamp: String?)
    case promptRequest(PromptRequestPayload)
    case promptAnswered(PromptAnsweredPayload)
    case planDiscovery(planId: Int, title: String, timestamp: String?)
    case userTerminalInput(content: String, source: UserTerminalInputSource?, timestamp: String?)
    case workspaceInfo(path: String, planFile: String?, workspaceId: String?, timestamp: String?)
    case unknown(type: String)
}

// MARK: - Structured Message Payload Structs

enum UserTerminalInputSource: String, Sendable, Decodable {
    case terminal
    case gui
}

struct AgentSessionStartPayload: Sendable {
    let executor: String?
    let mode: String?
    let planId: Int?
    let sessionId: String?
    let threadId: String?
    let tools: [String]?
    let mcpServers: [String]?
    let timestamp: String?
}

struct AgentSessionEndPayload: Sendable {
    let success: Bool
    let sessionId: String?
    let threadId: String?
    let durationMs: Double?
    let costUsd: Double?
    let turns: Int?
    let summary: String?
    let timestamp: String?
}

struct AgentIterationStartPayload: Sendable {
    let iterationNumber: Int
    let taskTitle: String?
    let taskDescription: String?
    let timestamp: String?
}

struct AgentStepStartPayload: Sendable {
    let phase: String
    let executor: String?
    let stepNumber: Int?
    let attempt: Int?
    let message: String?
    let timestamp: String?
}

struct AgentStepEndPayload: Sendable {
    let phase: String
    let success: Bool
    let summary: String?
    let timestamp: String?
}

struct LlmToolUsePayload: Sendable {
    let toolName: String
    let inputSummary: String?
    let input: String?
    let timestamp: String?
}

struct LlmToolResultPayload: Sendable {
    let toolName: String
    let resultSummary: String?
    let result: String?
    let timestamp: String?
}

struct TodoUpdateItem: Sendable, Decodable {
    let label: String
    let status: String

    enum CodingKeys: String, CodingKey {
        case label
        case status
    }
}

struct FileChangeItem: Sendable, Decodable {
    let path: String
    let kind: String

    enum CodingKeys: String, CodingKey {
        case path
        case kind
    }
}

struct CommandResultPayload: Sendable {
    let command: String?
    let cwd: String?
    let exitCode: Int
    let stdout: String?
    let stderr: String?
    let timestamp: String?
}

struct ReviewIssueItem: Sendable, Decodable {
    let severity: String?
    let category: String?
    let content: String?
    let file: String?
    let line: String?
    let suggestion: String?

    enum CodingKeys: String, CodingKey {
        case severity
        case category
        case content
        case file
        case line
        case suggestion
    }
}

struct ReviewResultPayload: Sendable {
    let issues: [ReviewIssueItem]
    let recommendations: [String]
    let actionItems: [String]
    let timestamp: String?
}

struct FailureReportPayload: Sendable {
    let summary: String
    let requirements: String?
    let problems: String?
    let solutions: String?
    let sourceAgent: String?
    let timestamp: String?
}

struct ExecutionSummaryPayload: Sendable {
    // The summary is complex; store as a dictionary for basic display
    let planId: String?
    let planTitle: String?
    let mode: String?
    let durationMs: Double?
    let totalSteps: Int?
    let failedSteps: Int?
    let changedFiles: [String]?
    let errors: [String]?
    let timestamp: String?
}

struct TokenUsagePayload: Sendable {
    let inputTokens: Int?
    let cachedInputTokens: Int?
    let outputTokens: Int?
    let reasoningTokens: Int?
    let totalTokens: Int?
    let timestamp: String?
}

struct PromptChoiceConfigPayload: Sendable, Decodable {
    let name: String
    let value: PromptResponseValue?
    let description: String?
    let checked: Bool?

    enum CodingKeys: String, CodingKey {
        case name
        case value
        case description
        case checked
    }

    init(
        name: String,
        value: PromptResponseValue? = nil,
        description: String? = nil,
        checked: Bool? = nil)
    {
        self.name = name
        self.value = value
        self.description = description
        self.checked = checked
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.name = try container.decode(String.self, forKey: .name)
        // Decode value preserving its original JSON type.
        // Try Bool first since JSON booleans can also decode as numbers.
        if let b = try? container.decode(Bool.self, forKey: .value) {
            self.value = .bool(b)
        } else if let n = try? container.decode(Int.self, forKey: .value) {
            self.value = .int(n)
        } else if let n = try? container.decode(Double.self, forKey: .value) {
            self.value = .double(n)
        } else if let s = try? container.decode(String.self, forKey: .value) {
            self.value = .string(s)
        } else {
            self.value = nil
        }
        self.description = try container.decodeIfPresent(String.self, forKey: .description)
        self.checked = try container.decodeIfPresent(Bool.self, forKey: .checked)
    }
}

struct PromptConfigPayload: Sendable, Decodable {
    let message: String
    let defaultValue: PromptResponseValue?
    let choices: [PromptChoiceConfigPayload]?
    let pageSize: Int?
    let validationHint: String?
    let command: String?

    enum CodingKeys: String, CodingKey {
        case message
        case defaultValue = "default"
        case choices
        case pageSize
        case validationHint
        case command
    }

    init(
        message: String,
        defaultValue: PromptResponseValue? = nil,
        choices: [PromptChoiceConfigPayload]? = nil,
        pageSize: Int? = nil,
        validationHint: String? = nil,
        command: String? = nil)
    {
        self.message = message
        self.defaultValue = defaultValue
        self.choices = choices
        self.pageSize = pageSize
        self.validationHint = validationHint
        self.command = command
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.message = try container.decode(String.self, forKey: .message)
        // Decode default preserving its original JSON type.
        // Try Bool first since JSON booleans can also decode as numbers.
        if let b = try? container.decode(Bool.self, forKey: .defaultValue) {
            self.defaultValue = .bool(b)
        } else if let n = try? container.decode(Int.self, forKey: .defaultValue) {
            self.defaultValue = .int(n)
        } else if let n = try? container.decode(Double.self, forKey: .defaultValue) {
            self.defaultValue = .double(n)
        } else if let s = try? container.decode(String.self, forKey: .defaultValue) {
            self.defaultValue = .string(s)
        } else {
            self.defaultValue = nil
        }
        self.choices = try container.decodeIfPresent([PromptChoiceConfigPayload].self, forKey: .choices)
        self.pageSize = try container.decodeIfPresent(Int.self, forKey: .pageSize)
        self.validationHint = try container.decodeIfPresent(String.self, forKey: .validationHint)
        self.command = try container.decodeIfPresent(String.self, forKey: .command)
    }
}

struct PromptRequestPayload: Sendable {
    let requestId: String
    let promptType: String
    let promptConfig: PromptConfigPayload
    let timeoutMs: Int?
    let timestamp: String?
}

struct PromptAnsweredPayload: Sendable {
    let requestId: String
    let promptType: String
    let source: String
    let value: String?
    let timestamp: String?
}

// MARK: - RawJSONString helper

/// Decodes any JSON value into a Swift Any for re-serialization via JSONSerialization.
private struct AnyJSON: Decodable {
    let value: Any

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self.value = NSNull()
        } else if let b = try? container.decode(Bool.self) {
            self.value = b
        } else if let n = try? container.decode(Double.self) {
            self.value = n
        } else if let s = try? container.decode(String.self) {
            self.value = s
        } else if let arr = try? container.decode([AnyJSON].self) {
            self.value = arr.map(\.value)
        } else if let dict = try? container.decode([String: AnyJSON].self) {
            self.value = dict.mapValues { $0.value }
        } else {
            throw DecodingError.typeMismatch(
                Any.self,
                .init(
                    codingPath: decoder.codingPath,
                    debugDescription: "Unsupported JSON type"))
        }
    }
}

/// Decodes any JSON value (string, number, bool, object, array) into a String representation.
private struct RawJSONString: Decodable, Sendable {
    let stringValue: String

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let s = try? container.decode(String.self) {
            self.stringValue = s
        } else if let n = try? container.decode(Double.self) {
            if n == n.rounded(), abs(n) < 1e15 {
                self.stringValue = String(Int(n))
            } else {
                self.stringValue = String(n)
            }
        } else if let b = try? container.decode(Bool.self) {
            self.stringValue = String(b)
        } else {
            // Re-decode as AnyJSON and serialize to JSON string
            let anyValue = try AnyJSON(from: decoder)
            if let data = try? JSONSerialization.data(
                withJSONObject: anyValue.value, options: [.sortedKeys]),
                let str = String(data: data, encoding: .utf8)
            {
                self.stringValue = str
            } else {
                self.stringValue = "<unserializable>"
            }
        }
    }
}

// MARK: - StructuredMessagePayload Decoding

extension StructuredMessagePayload: Decodable {
    private enum ExecutionSummaryCodingKeys: String, CodingKey {
        case planId, planTitle, mode, durationMs, changedFiles, errors, metadata
    }

    private enum MetadataCodingKeys: String, CodingKey {
        case totalSteps, failedSteps
    }

    private enum CodingKeys: String, CodingKey {
        case type
        case timestamp
        /// agent_session_start
        case executor, mode, planId, sessionId, threadId, tools, mcpServers
        /// agent_session_end
        case success, durationMs, costUsd, turns, summary
        /// agent_iteration_start
        case iterationNumber, taskTitle, taskDescription
        /// agent_step_start/end
        case phase, stepNumber, attempt, message
        /// llm_thinking/response
        case text, isUserRequest
        /// llm_tool_use/result
        case toolName, inputSummary, resultSummary, input, result
        /// todo_update
        case items
        /// file_write/edit
        case path, lineCount, diff
        /// file_change_summary
        case changes
        /// command_exec/result
        case command, cwd, exitCode, stdout, stderr
        // review
        case issues, recommendations, actionItems
        case verdict, fixInstructions
        /// workflow
        /// failure_report
        case requirements, problems, solutions, sourceAgent
        /// task_completion
        case planComplete
        /// execution_summary
        case planTitle
        /// token_usage
        case inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens
        /// input_required
        case prompt
        /// prompt_request
        case requestId, promptType, promptConfig, timeoutMs
        /// prompt_answered
        case source, value
        /// plan_discovery
        case title
        /// workspace_info
        case workspaceId, planFile
        /// llm_status
        case status, detail
        /// user_terminal_input
        case content
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        let timestamp = try container.decodeIfPresent(String.self, forKey: .timestamp)

        switch type {
        case "agent_session_start":
            self = try .agentSessionStart(AgentSessionStartPayload(
                executor: container.decodeIfPresent(String.self, forKey: .executor),
                mode: container.decodeIfPresent(String.self, forKey: .mode),
                planId: container.decodeIfPresent(Int.self, forKey: .planId),
                sessionId: container.decodeIfPresent(String.self, forKey: .sessionId),
                threadId: container.decodeIfPresent(String.self, forKey: .threadId),
                tools: container.decodeIfPresent([String].self, forKey: .tools),
                mcpServers: container.decodeIfPresent([String].self, forKey: .mcpServers),
                timestamp: timestamp))

        case "agent_session_end":
            self = try .agentSessionEnd(AgentSessionEndPayload(
                success: container.decode(Bool.self, forKey: .success),
                sessionId: container.decodeIfPresent(String.self, forKey: .sessionId),
                threadId: container.decodeIfPresent(String.self, forKey: .threadId),
                durationMs: container.decodeIfPresent(Double.self, forKey: .durationMs),
                costUsd: container.decodeIfPresent(Double.self, forKey: .costUsd),
                turns: container.decodeIfPresent(Int.self, forKey: .turns),
                summary: container.decodeIfPresent(String.self, forKey: .summary),
                timestamp: timestamp))

        case "agent_iteration_start":
            self = try .agentIterationStart(AgentIterationStartPayload(
                iterationNumber: container.decode(Int.self, forKey: .iterationNumber),
                taskTitle: container.decodeIfPresent(String.self, forKey: .taskTitle),
                taskDescription: container.decodeIfPresent(String.self, forKey: .taskDescription),
                timestamp: timestamp))

        case "agent_step_start":
            self = try .agentStepStart(AgentStepStartPayload(
                phase: container.decode(String.self, forKey: .phase),
                executor: container.decodeIfPresent(String.self, forKey: .executor),
                stepNumber: container.decodeIfPresent(Int.self, forKey: .stepNumber),
                attempt: container.decodeIfPresent(Int.self, forKey: .attempt),
                message: container.decodeIfPresent(String.self, forKey: .message),
                timestamp: timestamp))

        case "agent_step_end":
            self = try .agentStepEnd(AgentStepEndPayload(
                phase: container.decode(String.self, forKey: .phase),
                success: container.decode(Bool.self, forKey: .success),
                summary: container.decodeIfPresent(String.self, forKey: .summary),
                timestamp: timestamp))

        case "llm_thinking":
            self = try .llmThinking(
                text: container.decode(String.self, forKey: .text),
                timestamp: timestamp)

        case "llm_response":
            self = try .llmResponse(
                text: container.decode(String.self, forKey: .text),
                isUserRequest: container.decodeIfPresent(Bool.self, forKey: .isUserRequest),
                timestamp: timestamp)

        case "llm_tool_use":
            self = try .llmToolUse(LlmToolUsePayload(
                toolName: container.decode(String.self, forKey: .toolName),
                inputSummary: container.decodeIfPresent(String.self, forKey: .inputSummary),
                input: (try? container.decodeIfPresent(RawJSONString.self, forKey: .input))?.stringValue,
                timestamp: timestamp))

        case "llm_tool_result":
            self = try .llmToolResult(LlmToolResultPayload(
                toolName: container.decode(String.self, forKey: .toolName),
                resultSummary: container.decodeIfPresent(String.self, forKey: .resultSummary),
                result: (try? container.decodeIfPresent(RawJSONString.self, forKey: .result))?.stringValue,
                timestamp: timestamp))

        case "llm_status":
            self = try .llmStatus(
                status: container.decode(String.self, forKey: .status),
                detail: container.decodeIfPresent(String.self, forKey: .detail),
                timestamp: timestamp)

        case "todo_update":
            self = try .todoUpdate(
                items: container.decode([TodoUpdateItem].self, forKey: .items),
                timestamp: timestamp)

        case "file_write":
            self = try .fileWrite(
                path: container.decode(String.self, forKey: .path),
                lineCount: container.decode(Int.self, forKey: .lineCount),
                timestamp: timestamp)

        case "file_edit":
            self = try .fileEdit(
                path: container.decode(String.self, forKey: .path),
                diff: container.decode(String.self, forKey: .diff),
                timestamp: timestamp)

        case "file_change_summary":
            self = try .fileChangeSummary(
                changes: container.decode([FileChangeItem].self, forKey: .changes),
                timestamp: timestamp)

        case "command_exec":
            self = try .commandExec(
                command: container.decode(String.self, forKey: .command),
                cwd: container.decodeIfPresent(String.self, forKey: .cwd),
                timestamp: timestamp)

        case "command_result":
            self = try .commandResult(CommandResultPayload(
                command: container.decodeIfPresent(String.self, forKey: .command),
                cwd: container.decodeIfPresent(String.self, forKey: .cwd),
                exitCode: container.decode(Int.self, forKey: .exitCode),
                stdout: container.decodeIfPresent(String.self, forKey: .stdout),
                stderr: container.decodeIfPresent(String.self, forKey: .stderr),
                timestamp: timestamp))

        case "review_start":
            self = try .reviewStart(
                executor: container.decodeIfPresent(String.self, forKey: .executor),
                planId: container.decodeIfPresent(Int.self, forKey: .planId),
                timestamp: timestamp)

        case "review_result":
            self = .reviewResult(ReviewResultPayload(
                issues: (try? container.decode([ReviewIssueItem].self, forKey: .issues)) ?? [],
                recommendations: (try? container.decode([String].self, forKey: .recommendations)) ?? [],
                actionItems: (try? container.decode([String].self, forKey: .actionItems)) ?? [],
                timestamp: timestamp))

        case "review_verdict":
            self = try .reviewVerdict(
                verdict: container.decode(String.self, forKey: .verdict),
                fixInstructions: container.decodeIfPresent(String.self, forKey: .fixInstructions),
                timestamp: timestamp)

        case "workflow_progress":
            self = try .workflowProgress(
                message: container.decode(String.self, forKey: .message),
                phase: container.decodeIfPresent(String.self, forKey: .phase),
                timestamp: timestamp)

        case "failure_report":
            self = try .failureReport(FailureReportPayload(
                summary: container.decode(String.self, forKey: .summary),
                requirements: container.decodeIfPresent(String.self, forKey: .requirements),
                problems: container.decodeIfPresent(String.self, forKey: .problems),
                solutions: container.decodeIfPresent(String.self, forKey: .solutions),
                sourceAgent: container.decodeIfPresent(String.self, forKey: .sourceAgent),
                timestamp: timestamp))

        case "task_completion":
            self = try .taskCompletion(
                taskTitle: container.decodeIfPresent(String.self, forKey: .taskTitle),
                planComplete: container.decode(Bool.self, forKey: .planComplete),
                timestamp: timestamp)

        case "execution_summary":
            // Decode the nested 'summary' object with the fields we care about
            // The full ExecutionSummary is complex; extract key fields
            let summaryContainer = try container.nestedContainer(
                keyedBy: ExecutionSummaryCodingKeys.self, forKey: .summary)
            var totalSteps: Int?
            var failedSteps: Int?
            if let metadataContainer = try? summaryContainer.nestedContainer(
                keyedBy: MetadataCodingKeys.self, forKey: .metadata)
            {
                totalSteps = try metadataContainer.decodeIfPresent(Int.self, forKey: .totalSteps)
                failedSteps = try metadataContainer.decodeIfPresent(Int.self, forKey: .failedSteps)
            }
            self = try .executionSummary(ExecutionSummaryPayload(
                planId: summaryContainer.decodeIfPresent(String.self, forKey: .planId),
                planTitle: summaryContainer.decodeIfPresent(String.self, forKey: .planTitle),
                mode: summaryContainer.decodeIfPresent(String.self, forKey: .mode),
                durationMs: summaryContainer.decodeIfPresent(Double.self, forKey: .durationMs),
                totalSteps: totalSteps,
                failedSteps: failedSteps,
                changedFiles: summaryContainer.decodeIfPresent([String].self, forKey: .changedFiles),
                errors: summaryContainer.decodeIfPresent([String].self, forKey: .errors),
                timestamp: timestamp))

        case "token_usage":
            self = try .tokenUsage(TokenUsagePayload(
                inputTokens: container.decodeIfPresent(Int.self, forKey: .inputTokens),
                cachedInputTokens: container.decodeIfPresent(Int.self, forKey: .cachedInputTokens),
                outputTokens: container.decodeIfPresent(Int.self, forKey: .outputTokens),
                reasoningTokens: container.decodeIfPresent(Int.self, forKey: .reasoningTokens),
                totalTokens: container.decodeIfPresent(Int.self, forKey: .totalTokens),
                timestamp: timestamp))

        case "input_required":
            self = try .inputRequired(
                prompt: container.decodeIfPresent(String.self, forKey: .prompt),
                timestamp: timestamp)

        case "prompt_request":
            self = try .promptRequest(PromptRequestPayload(
                requestId: container.decode(String.self, forKey: .requestId),
                promptType: container.decode(String.self, forKey: .promptType),
                promptConfig: container.decode(PromptConfigPayload.self, forKey: .promptConfig),
                timeoutMs: container.decodeIfPresent(Int.self, forKey: .timeoutMs),
                timestamp: timestamp))

        case "prompt_answered":
            self = try .promptAnswered(PromptAnsweredPayload(
                requestId: container.decode(String.self, forKey: .requestId),
                promptType: container.decode(String.self, forKey: .promptType),
                source: container.decode(String.self, forKey: .source),
                value: (try? container.decodeIfPresent(RawJSONString.self, forKey: .value))?.stringValue,
                timestamp: timestamp))

        case "plan_discovery":
            self = try .planDiscovery(
                planId: container.decode(Int.self, forKey: .planId),
                title: container.decode(String.self, forKey: .title),
                timestamp: timestamp)

        case "workspace_info":
            self = try .workspaceInfo(
                path: container.decode(String.self, forKey: .path),
                planFile: container.decodeIfPresent(String.self, forKey: .planFile),
                workspaceId: container.decodeIfPresent(String.self, forKey: .workspaceId),
                timestamp: timestamp)

        case "user_terminal_input":
            self = try .userTerminalInput(
                content: container.decode(String.self, forKey: .content),
                source: container.decodeIfPresent(UserTerminalInputSource.self, forKey: .source),
                timestamp: timestamp)

        default:
            self = .unknown(type: type)
        }
    }
}

// MARK: - Message Formatting

private let truncateLineCount = 40

private func truncateLines(_ text: String) -> String {
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
    if lines.count <= truncateLineCount { return text }
    let truncated = lines.count - truncateLineCount
    return lines.prefix(truncateLineCount).joined(separator: "\n") + "\n... (\(truncated) lines truncated)"
}

@MainActor private let isoFormatterWithFractions: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

@MainActor private let isoFormatterWithoutFractions: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

@MainActor
private func parseTimestamp(_ ts: String?) -> Date? {
    guard let ts else { return nil }
    return isoFormatterWithFractions.date(from: ts)
        ?? isoFormatterWithoutFractions.date(from: ts)
}

@MainActor
enum MessageFormatter {
    static func format(tunnelMessage: TunnelMessage, seq: Int) -> SessionMessage {
        switch tunnelMessage {
        case let .args(type, args):
            let text = args.joined(separator: " ")
            let category: MessageCategory = (type == "error" || type == "warn") ? .error : .log
            return SessionMessage(seq: seq, title: nil, body: .text(text), category: category)

        case let .data(type, data):
            let category: MessageCategory = type == "stderr" ? .error : .log
            return SessionMessage(seq: seq, title: nil, body: .text(data), category: category)

        case let .structured(message):
            return self.formatStructured(message, seq: seq)

        case let .unknown(type):
            return SessionMessage(seq: seq, title: nil, body: .text("Unknown message type: \(type)"), category: .log)
        }
    }

    private static func formatStructured(_ msg: StructuredMessagePayload, seq: Int) -> SessionMessage {
        switch msg {
        case let .agentSessionStart(p):
            let pairs = [
                p.executor.map { KeyValuePair(key: "Executor", value: $0) },
                p.mode.map { KeyValuePair(key: "Mode", value: $0) },
                p.planId.map { KeyValuePair(key: "Plan", value: "\($0)") },
            ].compactMap(\.self)
            return SessionMessage(
                seq: seq, title: "Starting",
                body: pairs.isEmpty ? nil : .keyValuePairs(pairs),
                category: .lifecycle, timestamp: parseTimestamp(p.timestamp))

        case let .agentSessionEnd(p):
            var pairs = [KeyValuePair(key: "Success", value: p.success ? "yes" : "no")]
            if let d = p.durationMs { pairs.append(KeyValuePair(key: "Duration", value: "\(Int(d / 1000))s")) }
            if let c = p.costUsd { pairs.append(KeyValuePair(key: "Cost", value: "$\(String(format: "%.2f", c))")) }
            if let t = p.turns { pairs.append(KeyValuePair(key: "Turns", value: "\(t)")) }
            if let s = p.summary { pairs.append(KeyValuePair(key: "Summary", value: s)) }
            return SessionMessage(
                seq: seq, title: "Done",
                body: .keyValuePairs(pairs),
                category: .lifecycle, timestamp: parseTimestamp(p.timestamp))

        case let .agentIterationStart(p):
            var bodyParts: [String] = []
            if let t = p.taskTitle { bodyParts.append(t) }
            if let d = p.taskDescription { bodyParts.append(d) }
            return SessionMessage(
                seq: seq, title: "Iteration \(p.iterationNumber)",
                body: bodyParts.isEmpty ? nil : .text(bodyParts.joined(separator: "\n")),
                category: .lifecycle, timestamp: parseTimestamp(p.timestamp))

        case let .agentStepStart(p):
            return SessionMessage(
                seq: seq, title: "Step Start: \(p.phase)",
                body: p.message.map { .text($0) },
                category: .lifecycle, timestamp: parseTimestamp(p.timestamp))

        case let .agentStepEnd(p):
            let status = p.success ? "✓" : "✗"
            return SessionMessage(
                seq: seq, title: "Step End: \(p.phase) \(status)",
                body: p.summary.map { .text($0) },
                category: p.success ? .lifecycle : .error, timestamp: parseTimestamp(p.timestamp))

        case let .llmThinking(text, ts):
            return SessionMessage(
                seq: seq, title: "Thinking",
                body: .text(text),
                category: .llmOutput, timestamp: parseTimestamp(ts))

        case let .llmResponse(text, isUserRequest, ts):
            let title = (isUserRequest == true) ? "User" : "Model Response"
            return SessionMessage(
                seq: seq, title: title,
                body: .text(text),
                category: .llmOutput, timestamp: parseTimestamp(ts))

        case let .llmToolUse(p):
            let body: MessageContentBody? = (p.inputSummary ?? p.input).map { .monospaced($0) }
            return SessionMessage(
                seq: seq, title: "Invoke Tool: \(p.toolName)",
                body: body,
                category: .toolUse, timestamp: parseTimestamp(p.timestamp))

        case let .llmToolResult(p):
            let content = p.resultSummary ?? p.result
            let body: MessageContentBody? = content.map {
                .monospaced(p.toolName == "Task" ? $0 : truncateLines($0))
            }
            return SessionMessage(
                seq: seq, title: "Tool Result: \(p.toolName)",
                body: body,
                category: .toolUse, timestamp: parseTimestamp(p.timestamp))

        case let .llmStatus(status, detail, ts):
            var text = status
            if let d = detail { text += "\n\(d)" }
            return SessionMessage(
                seq: seq, title: "Status",
                body: .text(text),
                category: .log, timestamp: parseTimestamp(ts))

        case let .todoUpdate(items, ts):
            let displayItems = items.map { item in
                let status: TodoStatus = switch item.status {
                case "completed": .completed
                case "in_progress": .inProgress
                case "blocked": .blocked
                case "pending": .pending
                default: .unknown
                }
                return TodoDisplayItem(label: item.label, status: status)
            }
            return SessionMessage(
                seq: seq, title: "Todo Update",
                body: .todoList(displayItems),
                category: .progress, timestamp: parseTimestamp(ts))

        case let .fileWrite(path, lineCount, ts):
            return SessionMessage(
                seq: seq, title: "Invoke Tool: Write",
                body: .monospaced("\(path) (\(lineCount) lines)"),
                category: .fileChange, timestamp: parseTimestamp(ts))

        case let .fileEdit(path, diff, ts):
            return SessionMessage(
                seq: seq, title: "Invoke Tool: Edit",
                body: .monospaced("\(path)\n\(diff)"),
                category: .fileChange, timestamp: parseTimestamp(ts))

        case let .fileChangeSummary(changes, ts):
            let displayItems = changes.map { change in
                let kind: FileChangeKind = switch change.kind {
                case "added": .added
                case "updated": .updated
                case "removed": .removed
                default: .unknown
                }
                return FileChangeDisplayItem(path: change.path, kind: kind)
            }
            return SessionMessage(
                seq: seq, title: "File Changes",
                body: .fileChanges(displayItems),
                category: .fileChange, timestamp: parseTimestamp(ts))

        case let .commandExec(command, cwd, ts):
            var text = command
            if let cwd { text += "\n\(cwd)" }
            return SessionMessage(
                seq: seq, title: "Exec Begin",
                body: .monospaced(text),
                category: .command, timestamp: parseTimestamp(ts))

        case let .commandResult(p):
            var lines: [String] = []
            if let cmd = p.command { lines.append(cmd) }
            if let cwd = p.cwd { lines.append(cwd) }
            if p.exitCode != 0 { lines.append("Exit Code: \(p.exitCode)") }
            if let out = p.stdout { lines.append(truncateLines(out)) }
            if let err = p.stderr { lines.append(truncateLines(err)) }
            return SessionMessage(
                seq: seq, title: "Exec Finished",
                body: lines.isEmpty ? nil : .monospaced(lines.joined(separator: "\n")),
                category: .command, timestamp: parseTimestamp(p.timestamp))

        case let .reviewStart(executor, _, ts):
            return SessionMessage(
                seq: seq, title: "Executing Review",
                body: .text(executor ?? "unknown executor"),
                category: .lifecycle, timestamp: parseTimestamp(ts))

        case let .reviewResult(p):
            var lines = ["Issues: \(p.issues.count)"]
            if !p.recommendations.isEmpty {
                lines.append("Recommendations: \(p.recommendations.count)")
            }
            if !p.actionItems.isEmpty {
                lines.append("Action items: \(p.actionItems.count)")
            }
            for issue in p.issues {
                var issueLine = "- "
                if let sev = issue.severity { issueLine += "[\(sev)] " }
                if let content = issue.content { issueLine += content }
                if let file = issue.file {
                    issueLine += " (\(file)"
                    if let line = issue.line { issueLine += ":\(line)" }
                    issueLine += ")"
                }
                lines.append(issueLine)
            }
            return SessionMessage(
                seq: seq, title: "Review Result",
                body: .text(lines.joined(separator: "\n")),
                category: .lifecycle, timestamp: parseTimestamp(p.timestamp))

        case let .reviewVerdict(verdict, fixInstructions, ts):
            var text = "Verdict: \(verdict)"
            if let instructions = fixInstructions {
                text += "\n\(instructions)"
            }
            return SessionMessage(
                seq: seq, title: "Review Verdict",
                body: .text(text),
                category: .lifecycle, timestamp: parseTimestamp(ts))

        case let .workflowProgress(message, phase, ts):
            let text = phase.map { "[\($0)] \(message)" } ?? message
            return SessionMessage(
                seq: seq, title: nil,
                body: .text(text),
                category: .progress, timestamp: parseTimestamp(ts))

        case let .failureReport(p):
            var lines = ["FAILED: \(p.summary)"]
            if let r = p.requirements { lines.append("Requirements:\n\(r)") }
            if let pr = p.problems { lines.append("Problems:\n\(pr)") }
            if let s = p.solutions { lines.append("Possible solutions:\n\(s)") }
            if let a = p.sourceAgent { lines.append("Source: \(a)") }
            return SessionMessage(
                seq: seq, title: nil,
                body: .text(lines.joined(separator: "\n")),
                category: .error, timestamp: parseTimestamp(p.timestamp))

        case let .taskCompletion(taskTitle, planComplete, ts):
            let title = taskTitle ?? ""
            let text = planComplete
                ? "Task complete: \(title) (plan complete)".trimmingCharacters(in: .whitespaces)
                : "Task complete: \(title)".trimmingCharacters(in: .whitespaces)
            return SessionMessage(
                seq: seq, title: nil,
                body: .text(text),
                category: .lifecycle, timestamp: parseTimestamp(ts))

        case let .executionSummary(p):
            var pairs: [KeyValuePair] = []
            if let id = p.planId { pairs.append(KeyValuePair(key: "Plan", value: id)) }
            if let title = p.planTitle { pairs.append(KeyValuePair(key: "Title", value: title)) }
            if let mode = p.mode { pairs.append(KeyValuePair(key: "Mode", value: mode)) }
            if let d = p.durationMs { pairs.append(KeyValuePair(key: "Duration", value: "\(Int(d / 1000))s")) }
            if let t = p.totalSteps { pairs.append(KeyValuePair(key: "Steps", value: "\(t)")) }
            if let f = p.failedSteps, f > 0 { pairs.append(KeyValuePair(key: "Failed", value: "\(f)")) }
            if let files = p.changedFiles, !files.isEmpty {
                pairs.append(KeyValuePair(key: "Changed files", value: files.joined(separator: ", ")))
            }
            if let errors = p.errors, !errors.isEmpty {
                pairs.append(KeyValuePair(key: "Errors", value: errors.joined(separator: "; ")))
            }
            return SessionMessage(
                seq: seq, title: "Execution Summary",
                body: pairs.isEmpty ? nil : .keyValuePairs(pairs),
                category: .lifecycle, timestamp: parseTimestamp(p.timestamp))

        case let .tokenUsage(p):
            let parts = [
                p.inputTokens.map { "input=\($0)" },
                p.cachedInputTokens.map { "cached=\($0)" },
                p.outputTokens.map { "output=\($0)" },
                p.reasoningTokens.map { "reasoning=\($0)" },
                p.totalTokens.map { "total=\($0)" },
            ].compactMap(\.self)
            return SessionMessage(
                seq: seq, title: "Usage",
                body: parts.isEmpty ? nil : .text(parts.joined(separator: " ")),
                category: .log, timestamp: parseTimestamp(p.timestamp))

        case let .inputRequired(prompt, ts):
            let text = prompt.map { "Input required: \($0)" } ?? "Input required"
            return SessionMessage(
                seq: seq, title: "Input Required",
                body: .text(text),
                category: .progress, timestamp: parseTimestamp(ts))

        case let .promptRequest(p):
            return SessionMessage(
                seq: seq, title: nil,
                body: .text("Prompt (\(p.promptType)): \(p.promptConfig.message)"),
                category: .progress, timestamp: parseTimestamp(p.timestamp))

        case let .promptAnswered(p):
            return SessionMessage(
                seq: seq, title: nil,
                body: .text("Prompt answered (\(p.promptType)) by \(p.source)"),
                category: .log, timestamp: parseTimestamp(p.timestamp))

        case let .planDiscovery(planId, title, ts):
            return SessionMessage(
                seq: seq, title: "Plan Discovery",
                body: .text("Found ready plan: \(planId) - \(title)"),
                category: .lifecycle, timestamp: parseTimestamp(ts))

        case let .workspaceInfo(path, planFile, _, ts):
            var pairs = [KeyValuePair(key: "Path", value: path)]
            if let pf = planFile { pairs.append(KeyValuePair(key: "Plan", value: pf)) }
            return SessionMessage(
                seq: seq, title: "Workspace",
                body: .keyValuePairs(pairs),
                category: .log, timestamp: parseTimestamp(ts))

        case let .userTerminalInput(content, _, ts):
            return SessionMessage(
                seq: seq, title: "You",
                body: .text(content),
                category: .userInput, timestamp: parseTimestamp(ts))

        case let .unknown(type):
            return SessionMessage(
                seq: seq, title: nil,
                body: .text("Unknown message type: \(type)"),
                category: .log)
        }
    }
}
