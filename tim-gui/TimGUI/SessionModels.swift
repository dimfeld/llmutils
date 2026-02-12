import Foundation

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
}

// MARK: - SessionMessage

struct SessionMessage: Identifiable, Sendable {
    let id: UUID
    let seq: Int
    let text: String
    let category: MessageCategory
    let timestamp: Date?

    init(seq: Int, text: String, category: MessageCategory, timestamp: Date? = nil) {
        self.id = UUID()
        self.seq = seq
        self.text = text
        self.category = category
        self.timestamp = timestamp
    }
}

// MARK: - SessionItem

struct SessionItem: Identifiable, Sendable {
    let id: UUID
    let connectionId: UUID
    var command: String
    var planId: Int?
    var planTitle: String?
    var workspacePath: String?
    let connectedAt: Date
    var isActive: Bool
    var messages: [SessionMessage]
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
            self = .sessionInfo(SessionInfoPayload(
                command: command, planId: planId, planTitle: planTitle,
                workspacePath: workspacePath, gitRemote: gitRemote))
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
    case workspaceInfo(path: String, planFile: String?, workspaceId: String?, timestamp: String?)
    case unknown(type: String)
}

// MARK: - Structured Message Payload Structs

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
    let value: String?
    let description: String?
    let checked: Bool?

    enum CodingKeys: String, CodingKey {
        case name
        case value
        case description
        case checked
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.name = try container.decode(String.self, forKey: .name)
        // value can be string, number, or bool - coerce to string
        if let s = try? container.decode(String.self, forKey: .value) {
            self.value = s
        } else if let n = try? container.decode(Double.self, forKey: .value) {
            self.value = String(n)
        } else if let b = try? container.decode(Bool.self, forKey: .value) {
            self.value = String(b)
        } else {
            self.value = nil
        }
        self.description = try container.decodeIfPresent(String.self, forKey: .description)
        self.checked = try container.decodeIfPresent(Bool.self, forKey: .checked)
    }
}

struct PromptConfigPayload: Sendable, Decodable {
    let message: String
    let defaultValue: String?
    let choices: [PromptChoiceConfigPayload]?
    let pageSize: Int?
    let validationHint: String?

    enum CodingKeys: String, CodingKey {
        case message
        case defaultValue = "default"
        case choices
        case pageSize
        case validationHint
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.message = try container.decode(String.self, forKey: .message)
        // default can be string, number, or bool - coerce to string
        if let s = try? container.decode(String.self, forKey: .defaultValue) {
            self.defaultValue = s
        } else if let n = try? container.decode(Double.self, forKey: .defaultValue) {
            self.defaultValue = String(n)
        } else if let b = try? container.decode(Bool.self, forKey: .defaultValue) {
            self.defaultValue = String(b)
        } else {
            self.defaultValue = nil
        }
        self.choices = try container.decodeIfPresent([PromptChoiceConfigPayload].self, forKey: .choices)
        self.pageSize = try container.decodeIfPresent(Int.self, forKey: .pageSize)
        self.validationHint = try container.decodeIfPresent(String.self, forKey: .validationHint)
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
            value = NSNull()
        } else if let b = try? container.decode(Bool.self) {
            value = b
        } else if let n = try? container.decode(Double.self) {
            value = n
        } else if let s = try? container.decode(String.self) {
            value = s
        } else if let arr = try? container.decode([AnyJSON].self) {
            value = arr.map { $0.value }
        } else if let dict = try? container.decode([String: AnyJSON].self) {
            value = dict.mapValues { $0.value }
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
            stringValue = s
        } else if let n = try? container.decode(Double.self) {
            if n == n.rounded() && abs(n) < 1e15 {
                stringValue = String(Int(n))
            } else {
                stringValue = String(n)
            }
        } else if let b = try? container.decode(Bool.self) {
            stringValue = String(b)
        } else {
            // Re-decode as AnyJSON and serialize to JSON string
            let anyValue = try AnyJSON(from: decoder)
            if let data = try? JSONSerialization.data(
                withJSONObject: anyValue.value, options: [.sortedKeys]),
                let str = String(data: data, encoding: .utf8)
            {
                stringValue = str
            } else {
                stringValue = "<unserializable>"
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
        // agent_session_start
        case executor, mode, planId, sessionId, threadId, tools, mcpServers
        // agent_session_end
        case success, durationMs, costUsd, turns, summary
        // agent_iteration_start
        case iterationNumber, taskTitle, taskDescription
        // agent_step_start/end
        case phase, stepNumber, attempt, message
        // llm_thinking/response
        case text, isUserRequest
        // llm_tool_use/result
        case toolName, inputSummary, resultSummary, input, result
        // todo_update
        case items
        // file_write/edit
        case path, lineCount, diff
        // file_change_summary
        case changes
        // command_exec/result
        case command, cwd, exitCode, stdout, stderr
        // review
        case issues, recommendations, actionItems
        case verdict, fixInstructions
        // workflow
        // failure_report
        case requirements, problems, solutions, sourceAgent
        // task_completion
        case planComplete
        // execution_summary
        case planTitle
        // token_usage
        case inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens
        // input_required
        case prompt
        // prompt_request
        case requestId, promptType, promptConfig, timeoutMs
        // prompt_answered
        case source, value
        // plan_discovery
        case title
        // workspace_info
        case workspaceId, planFile
        // llm_status
        case status, detail
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        let timestamp = try container.decodeIfPresent(String.self, forKey: .timestamp)

        switch type {
        case "agent_session_start":
            self = .agentSessionStart(AgentSessionStartPayload(
                executor: try container.decodeIfPresent(String.self, forKey: .executor),
                mode: try container.decodeIfPresent(String.self, forKey: .mode),
                planId: try container.decodeIfPresent(Int.self, forKey: .planId),
                sessionId: try container.decodeIfPresent(String.self, forKey: .sessionId),
                threadId: try container.decodeIfPresent(String.self, forKey: .threadId),
                tools: try container.decodeIfPresent([String].self, forKey: .tools),
                mcpServers: try container.decodeIfPresent([String].self, forKey: .mcpServers),
                timestamp: timestamp))

        case "agent_session_end":
            self = .agentSessionEnd(AgentSessionEndPayload(
                success: try container.decode(Bool.self, forKey: .success),
                sessionId: try container.decodeIfPresent(String.self, forKey: .sessionId),
                threadId: try container.decodeIfPresent(String.self, forKey: .threadId),
                durationMs: try container.decodeIfPresent(Double.self, forKey: .durationMs),
                costUsd: try container.decodeIfPresent(Double.self, forKey: .costUsd),
                turns: try container.decodeIfPresent(Int.self, forKey: .turns),
                summary: try container.decodeIfPresent(String.self, forKey: .summary),
                timestamp: timestamp))

        case "agent_iteration_start":
            self = .agentIterationStart(AgentIterationStartPayload(
                iterationNumber: try container.decode(Int.self, forKey: .iterationNumber),
                taskTitle: try container.decodeIfPresent(String.self, forKey: .taskTitle),
                taskDescription: try container.decodeIfPresent(String.self, forKey: .taskDescription),
                timestamp: timestamp))

        case "agent_step_start":
            self = .agentStepStart(AgentStepStartPayload(
                phase: try container.decode(String.self, forKey: .phase),
                executor: try container.decodeIfPresent(String.self, forKey: .executor),
                stepNumber: try container.decodeIfPresent(Int.self, forKey: .stepNumber),
                attempt: try container.decodeIfPresent(Int.self, forKey: .attempt),
                message: try container.decodeIfPresent(String.self, forKey: .message),
                timestamp: timestamp))

        case "agent_step_end":
            self = .agentStepEnd(AgentStepEndPayload(
                phase: try container.decode(String.self, forKey: .phase),
                success: try container.decode(Bool.self, forKey: .success),
                summary: try container.decodeIfPresent(String.self, forKey: .summary),
                timestamp: timestamp))

        case "llm_thinking":
            self = .llmThinking(
                text: try container.decode(String.self, forKey: .text),
                timestamp: timestamp)

        case "llm_response":
            self = .llmResponse(
                text: try container.decode(String.self, forKey: .text),
                isUserRequest: try container.decodeIfPresent(Bool.self, forKey: .isUserRequest),
                timestamp: timestamp)

        case "llm_tool_use":
            self = .llmToolUse(LlmToolUsePayload(
                toolName: try container.decode(String.self, forKey: .toolName),
                inputSummary: try container.decodeIfPresent(String.self, forKey: .inputSummary),
                input: (try? container.decodeIfPresent(RawJSONString.self, forKey: .input))?.stringValue,
                timestamp: timestamp))

        case "llm_tool_result":
            self = .llmToolResult(LlmToolResultPayload(
                toolName: try container.decode(String.self, forKey: .toolName),
                resultSummary: try container.decodeIfPresent(String.self, forKey: .resultSummary),
                result: (try? container.decodeIfPresent(RawJSONString.self, forKey: .result))?.stringValue,
                timestamp: timestamp))

        case "llm_status":
            self = .llmStatus(
                status: try container.decode(String.self, forKey: .status),
                detail: try container.decodeIfPresent(String.self, forKey: .detail),
                timestamp: timestamp)

        case "todo_update":
            self = .todoUpdate(
                items: try container.decode([TodoUpdateItem].self, forKey: .items),
                timestamp: timestamp)

        case "file_write":
            self = .fileWrite(
                path: try container.decode(String.self, forKey: .path),
                lineCount: try container.decode(Int.self, forKey: .lineCount),
                timestamp: timestamp)

        case "file_edit":
            self = .fileEdit(
                path: try container.decode(String.self, forKey: .path),
                diff: try container.decode(String.self, forKey: .diff),
                timestamp: timestamp)

        case "file_change_summary":
            self = .fileChangeSummary(
                changes: try container.decode([FileChangeItem].self, forKey: .changes),
                timestamp: timestamp)

        case "command_exec":
            self = .commandExec(
                command: try container.decode(String.self, forKey: .command),
                cwd: try container.decodeIfPresent(String.self, forKey: .cwd),
                timestamp: timestamp)

        case "command_result":
            self = .commandResult(CommandResultPayload(
                command: try container.decodeIfPresent(String.self, forKey: .command),
                cwd: try container.decodeIfPresent(String.self, forKey: .cwd),
                exitCode: try container.decode(Int.self, forKey: .exitCode),
                stdout: try container.decodeIfPresent(String.self, forKey: .stdout),
                stderr: try container.decodeIfPresent(String.self, forKey: .stderr),
                timestamp: timestamp))

        case "review_start":
            self = .reviewStart(
                executor: try container.decodeIfPresent(String.self, forKey: .executor),
                planId: try container.decodeIfPresent(Int.self, forKey: .planId),
                timestamp: timestamp)

        case "review_result":
            self = .reviewResult(ReviewResultPayload(
                issues: (try? container.decode([ReviewIssueItem].self, forKey: .issues)) ?? [],
                recommendations: (try? container.decode([String].self, forKey: .recommendations)) ?? [],
                actionItems: (try? container.decode([String].self, forKey: .actionItems)) ?? [],
                timestamp: timestamp))

        case "review_verdict":
            self = .reviewVerdict(
                verdict: try container.decode(String.self, forKey: .verdict),
                fixInstructions: try container.decodeIfPresent(String.self, forKey: .fixInstructions),
                timestamp: timestamp)

        case "workflow_progress":
            self = .workflowProgress(
                message: try container.decode(String.self, forKey: .message),
                phase: try container.decodeIfPresent(String.self, forKey: .phase),
                timestamp: timestamp)

        case "failure_report":
            self = .failureReport(FailureReportPayload(
                summary: try container.decode(String.self, forKey: .summary),
                requirements: try container.decodeIfPresent(String.self, forKey: .requirements),
                problems: try container.decodeIfPresent(String.self, forKey: .problems),
                solutions: try container.decodeIfPresent(String.self, forKey: .solutions),
                sourceAgent: try container.decodeIfPresent(String.self, forKey: .sourceAgent),
                timestamp: timestamp))

        case "task_completion":
            self = .taskCompletion(
                taskTitle: try container.decodeIfPresent(String.self, forKey: .taskTitle),
                planComplete: try container.decode(Bool.self, forKey: .planComplete),
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
            self = .executionSummary(ExecutionSummaryPayload(
                planId: try summaryContainer.decodeIfPresent(String.self, forKey: .planId),
                planTitle: try summaryContainer.decodeIfPresent(String.self, forKey: .planTitle),
                mode: try summaryContainer.decodeIfPresent(String.self, forKey: .mode),
                durationMs: try summaryContainer.decodeIfPresent(Double.self, forKey: .durationMs),
                totalSteps: totalSteps,
                failedSteps: failedSteps,
                changedFiles: try summaryContainer.decodeIfPresent([String].self, forKey: .changedFiles),
                errors: try summaryContainer.decodeIfPresent([String].self, forKey: .errors),
                timestamp: timestamp))

        case "token_usage":
            self = .tokenUsage(TokenUsagePayload(
                inputTokens: try container.decodeIfPresent(Int.self, forKey: .inputTokens),
                cachedInputTokens: try container.decodeIfPresent(Int.self, forKey: .cachedInputTokens),
                outputTokens: try container.decodeIfPresent(Int.self, forKey: .outputTokens),
                reasoningTokens: try container.decodeIfPresent(Int.self, forKey: .reasoningTokens),
                totalTokens: try container.decodeIfPresent(Int.self, forKey: .totalTokens),
                timestamp: timestamp))

        case "input_required":
            self = .inputRequired(
                prompt: try container.decodeIfPresent(String.self, forKey: .prompt),
                timestamp: timestamp)

        case "prompt_request":
            self = .promptRequest(PromptRequestPayload(
                requestId: try container.decode(String.self, forKey: .requestId),
                promptType: try container.decode(String.self, forKey: .promptType),
                promptConfig: try container.decode(PromptConfigPayload.self, forKey: .promptConfig),
                timeoutMs: try container.decodeIfPresent(Int.self, forKey: .timeoutMs),
                timestamp: timestamp))

        case "prompt_answered":
            self = .promptAnswered(PromptAnsweredPayload(
                requestId: try container.decode(String.self, forKey: .requestId),
                promptType: try container.decode(String.self, forKey: .promptType),
                source: try container.decode(String.self, forKey: .source),
                value: (try? container.decodeIfPresent(RawJSONString.self, forKey: .value))?.stringValue,
                timestamp: timestamp))

        case "plan_discovery":
            self = .planDiscovery(
                planId: try container.decode(Int.self, forKey: .planId),
                title: try container.decode(String.self, forKey: .title),
                timestamp: timestamp)

        case "workspace_info":
            self = .workspaceInfo(
                path: try container.decode(String.self, forKey: .path),
                planFile: try container.decodeIfPresent(String.self, forKey: .planFile),
                workspaceId: try container.decodeIfPresent(String.self, forKey: .workspaceId),
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

@MainActor private let timeFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "HH:mm:ss"
    return f
}()

@MainActor
private func formatTimestamp(_ ts: String?) -> String {
    guard let ts else { return "" }
    let date = isoFormatterWithFractions.date(from: ts)
        ?? isoFormatterWithoutFractions.date(from: ts)
    guard let date else { return "" }
    return " [\(timeFormatter.string(from: date))]"
}

@MainActor
private func header(_ title: String, timestamp: String?) -> String {
    "### \(title)\(formatTimestamp(timestamp))"
}

@MainActor
enum MessageFormatter {
    static func format(tunnelMessage: TunnelMessage, seq: Int) -> SessionMessage {
        switch tunnelMessage {
        case .args(let type, let args):
            let text = args.joined(separator: " ")
            let category: MessageCategory = (type == "error" || type == "warn") ? .error : .log
            return SessionMessage(seq: seq, text: text, category: category)

        case .data(let type, let data):
            let category: MessageCategory = type == "stderr" ? .error : .log
            return SessionMessage(seq: seq, text: data, category: category)

        case .structured(let message):
            let (text, category) = formatStructured(message)
            return SessionMessage(seq: seq, text: text, category: category)

        case .unknown(let type):
            return SessionMessage(seq: seq, text: "Unknown message type: \(type)", category: .log)
        }
    }

    private static func formatStructured(_ msg: StructuredMessagePayload) -> (String, MessageCategory) {
        switch msg {
        case .agentSessionStart(let p):
            let details = [
                p.executor.map { "Executor: \($0)" },
                p.mode.map { "Mode: \($0)" },
                p.planId.map { "Plan: \($0)" },
            ].compactMap { $0 }
            let text = ([header("Starting", timestamp: p.timestamp)] + details).joined(separator: "\n")
            return (text, .lifecycle)

        case .agentSessionEnd(let p):
            var lines = [header("Done", timestamp: p.timestamp)]
            var info: [String] = []
            info.append("Success: \(p.success ? "yes" : "no")")
            if let d = p.durationMs { info.append("Duration: \(Int(d / 1000))s") }
            if let c = p.costUsd { info.append("Cost: $\(String(format: "%.2f", c))") }
            if let t = p.turns { info.append("Turns: \(t)") }
            lines.append(info.joined(separator: ", "))
            if let s = p.summary { lines.append(s) }
            return (lines.joined(separator: "\n"), .lifecycle)

        case .agentIterationStart(let p):
            var lines = ["### Iteration \(p.iterationNumber)"]
            if let t = p.taskTitle { lines.append(t) }
            if let d = p.taskDescription { lines.append(d) }
            return (lines.joined(separator: "\n"), .lifecycle)

        case .agentStepStart(let p):
            let phase = "Step Start: \(p.phase)"
            var lines = [header(phase, timestamp: p.timestamp)]
            if let m = p.message { lines.append(m) }
            return (lines.joined(separator: "\n"), .lifecycle)

        case .agentStepEnd(let p):
            let status = p.success ? "✓" : "✗"
            let phase = "Step End: \(p.phase) \(status)"
            var lines = [header(phase, timestamp: p.timestamp)]
            if let s = p.summary { lines.append(s) }
            return (lines.joined(separator: "\n"), p.success ? .lifecycle : .error)

        case .llmThinking(let text, let ts):
            return ("\(header("Thinking", timestamp: ts))\n\(text)", .llmOutput)

        case .llmResponse(let text, let isUserRequest, let ts):
            let title = (isUserRequest == true) ? "User" : "Model Response"
            return ("\(header(title, timestamp: ts))\n\(text)", .llmOutput)

        case .llmToolUse(let p):
            var lines = [header("Invoke Tool: \(p.toolName)", timestamp: p.timestamp)]
            if let s = p.inputSummary ?? p.input { lines.append(s) }
            return (lines.joined(separator: "\n"), .toolUse)

        case .llmToolResult(let p):
            var lines = [header("Tool Result: \(p.toolName)", timestamp: p.timestamp)]
            if let s = p.resultSummary ?? p.result {
                lines.append(p.toolName == "Task" ? s : truncateLines(s))
            }
            return (lines.joined(separator: "\n"), .toolUse)

        case .llmStatus(let status, let detail, let ts):
            var lines = [header("Status", timestamp: ts), status]
            if let d = detail { lines.append(d) }
            return (lines.joined(separator: "\n"), .log)

        case .todoUpdate(let items, let ts):
            var lines = [header("Todo Update", timestamp: ts)]
            for item in items {
                let indicator: String
                switch item.status {
                case "completed": indicator = "[x]"
                case "in_progress": indicator = "[>]"
                case "blocked": indicator = "[!]"
                case "pending": indicator = "[ ]"
                default: indicator = "[?]"
                }
                lines.append("\(indicator) \(item.label)")
            }
            return (lines.joined(separator: "\n"), .progress)

        case .fileWrite(let path, let lineCount, let ts):
            return ("\(header("Invoke Tool: Write", timestamp: ts))\n\(path) (\(lineCount) lines)", .fileChange)

        case .fileEdit(let path, let diff, let ts):
            return ("\(header("Invoke Tool: Edit", timestamp: ts))\n\(path)\n\(diff)", .fileChange)

        case .fileChangeSummary(let changes, let ts):
            var lines = [header("File Changes", timestamp: ts)]
            for change in changes {
                let indicator: String
                switch change.kind {
                case "added": indicator = "+"
                case "updated": indicator = "~"
                case "removed": indicator = "-"
                default: indicator = "?"
                }
                lines.append("\(indicator) \(change.path)")
            }
            return (lines.joined(separator: "\n"), .fileChange)

        case .commandExec(let command, let cwd, let ts):
            var text = "\(header("Exec Begin", timestamp: ts))\n\(command)"
            if let cwd { text += "\n\(cwd)" }
            return (text, .command)

        case .commandResult(let p):
            var lines = ["\(header("Exec Finished", timestamp: p.timestamp))\n\(p.command ?? "")"]
            if let cwd = p.cwd { lines.append(cwd) }
            if p.exitCode != 0 { lines.append("Exit Code: \(p.exitCode)") }
            if let out = p.stdout { lines.append(truncateLines(out)) }
            if let err = p.stderr { lines.append(truncateLines(err)) }
            return (lines.joined(separator: "\n"), .command)

        case .reviewStart(let executor, _, let ts):
            return ("\(header("Executing Review", timestamp: ts))\n\(executor ?? "unknown executor")", .lifecycle)

        case .reviewResult(let p):
            var lines = [header("Review Result", timestamp: p.timestamp)]
            lines.append("Issues: \(p.issues.count)")
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
            return (lines.joined(separator: "\n"), .lifecycle)

        case .reviewVerdict(let verdict, let fixInstructions, let ts):
            var lines = [header("Review Verdict", timestamp: ts)]
            lines.append("Verdict: \(verdict)")
            if let instructions = fixInstructions {
                lines.append(instructions)
            }
            return (lines.joined(separator: "\n"), .lifecycle)

        case .workflowProgress(let message, let phase, _):
            let text = phase.map { "[\($0)] \(message)" } ?? message
            return (text, .progress)

        case .failureReport(let p):
            var lines = ["FAILED: \(p.summary)"]
            if let r = p.requirements { lines.append("Requirements:\n\(r)") }
            if let pr = p.problems { lines.append("Problems:\n\(pr)") }
            if let s = p.solutions { lines.append("Possible solutions:\n\(s)") }
            if let a = p.sourceAgent { lines.append("Source: \(a)") }
            return (lines.joined(separator: "\n"), .error)

        case .taskCompletion(let taskTitle, let planComplete, _):
            let title = taskTitle ?? ""
            let text = planComplete
                ? "Task complete: \(title) (plan complete)".trimmingCharacters(in: .whitespaces)
                : "Task complete: \(title)".trimmingCharacters(in: .whitespaces)
            return (text, .lifecycle)

        case .executionSummary(let p):
            var lines = [header("Execution Summary", timestamp: p.timestamp)]
            if let id = p.planId { lines.append("Plan: \(id)") }
            if let title = p.planTitle { lines.append("Title: \(title)") }
            if let mode = p.mode { lines.append("Mode: \(mode)") }
            if let d = p.durationMs { lines.append("Duration: \(Int(d / 1000))s") }
            if let t = p.totalSteps { lines.append("Steps: \(t)") }
            if let f = p.failedSteps, f > 0 { lines.append("Failed: \(f)") }
            if let files = p.changedFiles, !files.isEmpty {
                lines.append("Changed files: \(files.joined(separator: ", "))")
            }
            if let errors = p.errors, !errors.isEmpty {
                lines.append("Errors: \(errors.joined(separator: "; "))")
            }
            return (lines.joined(separator: "\n"), .lifecycle)

        case .tokenUsage(let p):
            let parts = [
                p.inputTokens.map { "input=\($0)" },
                p.cachedInputTokens.map { "cached=\($0)" },
                p.outputTokens.map { "output=\($0)" },
                p.reasoningTokens.map { "reasoning=\($0)" },
                p.totalTokens.map { "total=\($0)" },
            ].compactMap { $0 }
            let text = parts.isEmpty
                ? header("Usage", timestamp: p.timestamp)
                : "\(header("Usage", timestamp: p.timestamp))\n\(parts.joined(separator: " "))"
            return (text, .log)

        case .inputRequired(let prompt, let ts):
            let text = prompt.map { "Input required: \($0)" } ?? "Input required"
            return ("\(header("Input Required", timestamp: ts))\n\(text)", .progress)

        case .promptRequest(let p):
            return ("Prompt (\(p.promptType)): \(p.promptConfig.message)", .progress)

        case .promptAnswered(let p):
            return ("Prompt answered (\(p.promptType)) by \(p.source)", .log)

        case .planDiscovery(let planId, let title, let ts):
            return ("\(header("Plan Discovery", timestamp: ts))\nFound ready plan: \(planId) - \(title)", .lifecycle)

        case .workspaceInfo(let path, let planFile, _, let ts):
            var text = "\(header("Workspace", timestamp: ts))\n\(path)"
            if let pf = planFile { text += "\nPlan: \(pf)" }
            return (text, .log)

        case .unknown(let type):
            return ("Unknown message type: \(type)", .log)
        }
    }
}
