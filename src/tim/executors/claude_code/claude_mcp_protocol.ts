import * as z from 'zod/v4';

import {
  AGENT_ARGUMENT_SCHEMAS,
  AGENT_TOOL_NAMES,
  ORCHESTRATOR_AGENT_TOOL_NAMES,
  SUBAGENT_AGENT_TOOL_NAMES,
  getAgentToolNames,
  type AgentArgumentSchema,
  type AgentToolName,
  type FinishAgentResult,
  type ListAgentsResult,
  type SendAgentMessageResult,
  type StartAgentResult,
  type StopAgentResult,
} from '../../agent_messaging/contracts.js';
import type {
  AgentCallerIdentity,
  AgentIdentity,
} from '../../agent_messaging/agent_manager_types.js';
import type { AgentManager } from '../../agent_messaging/agent_manager.js';
import { END_SESSION_TOOL_NAME } from '../shared/end_session_tool.js';

export const CLAUDE_MCP_SERVER_NAME = 'tim';
export const CLAUDE_APPROVAL_TOOL_NAME = 'approval_prompt';
export const CLAUDE_APPROVAL_MCP_TOOL_ID = `mcp__${CLAUDE_MCP_SERVER_NAME}__${CLAUDE_APPROVAL_TOOL_NAME}`;

export const CLAUDE_AGENT_TOOL_NAMES = AGENT_TOOL_NAMES;
export type ClaudeAgentToolName = AgentToolName;
export const claudeAgentToolNameSchema = z.enum(CLAUDE_AGENT_TOOL_NAMES);

export const CLAUDE_ORCHESTRATOR_TOOL_NAMES = ORCHESTRATOR_AGENT_TOOL_NAMES;
export const CLAUDE_SUBAGENT_TOOL_NAMES = SUBAGENT_AGENT_TOOL_NAMES;

export function getClaudeAgentToolNames(
  role: AgentIdentity['role']
): readonly ClaudeAgentToolName[] {
  return getAgentToolNames(role);
}

export function getClaudeAgentMcpToolId(toolName: ClaudeAgentToolName): string {
  return `mcp__${CLAUDE_MCP_SERVER_NAME}__${toolName}`;
}

/** Full Claude tool id for the session-control `EndTimSession` tool. */
export const CLAUDE_END_SESSION_MCP_TOOL_ID = `mcp__${CLAUDE_MCP_SERVER_NAME}__${END_SESSION_TOOL_NAME}`;

export const claudeRequestIdSchema = z.string().min(1).max(200);
const unknownObjectSchema = z.object({}).passthrough();

export const permissionRequestSchema = z
  .object({
    type: z.literal('permission_request'),
    requestId: claudeRequestIdSchema,
    tool_name: z.string().min(1),
    input: unknownObjectSchema,
  })
  .strict();
export type PermissionRequest = z.infer<typeof permissionRequestSchema>;

export const agentToolRequestSchema = z
  .object({
    type: z.literal('agent_tool_request'),
    requestId: claudeRequestIdSchema,
    tool_name: claudeAgentToolNameSchema,
    input: z.unknown(),
  })
  .strict();
export type AgentToolRequest = z.infer<typeof agentToolRequestSchema>;

/**
 * Session-control tool call. The parent validates `input` again with the shared tool schema
 * and calls its trusted executor-side handler.
 */
export const sessionToolRequestSchema = z
  .object({
    type: z.literal('session_tool_request'),
    requestId: claudeRequestIdSchema,
    tool_name: z.literal(END_SESSION_TOOL_NAME),
    input: z.unknown(),
  })
  .strict();
export type SessionToolRequest = z.infer<typeof sessionToolRequestSchema>;

export const claudeMcpRequestSchema = z.discriminatedUnion('type', [
  permissionRequestSchema,
  agentToolRequestSchema,
  sessionToolRequestSchema,
]);
export type ClaudeMcpRequest = z.infer<typeof claudeMcpRequestSchema>;

export const permissionResponseSchema = z
  .object({
    type: z.literal('permission_response'),
    requestId: claudeRequestIdSchema,
    approved: z.boolean(),
    updatedInput: z.unknown().optional(),
  })
  .strict();
export type PermissionResponse = z.infer<typeof permissionResponseSchema>;

const successfulAgentToolResponseSchema = z
  .object({
    type: z.literal('agent_tool_response'),
    requestId: claudeRequestIdSchema,
    success: z.literal(true),
    result: z.unknown(),
  })
  .strict();
const failedAgentToolResponseSchema = z
  .object({
    type: z.literal('agent_tool_response'),
    requestId: claudeRequestIdSchema,
    success: z.literal(false),
    error: z.string().min(1),
  })
  .strict();
export const agentToolResponseSchema = z.discriminatedUnion('success', [
  successfulAgentToolResponseSchema,
  failedAgentToolResponseSchema,
]);
export type AgentToolResponse = z.infer<typeof agentToolResponseSchema>;

const successfulSessionToolResponseSchema = z
  .object({
    type: z.literal('session_tool_response'),
    requestId: claudeRequestIdSchema,
    success: z.literal(true),
    result: z.string(),
  })
  .strict();
const failedSessionToolResponseSchema = z
  .object({
    type: z.literal('session_tool_response'),
    requestId: claudeRequestIdSchema,
    success: z.literal(false),
    error: z.string().min(1),
  })
  .strict();
export const sessionToolResponseSchema = z.discriminatedUnion('success', [
  successfulSessionToolResponseSchema,
  failedSessionToolResponseSchema,
]);
export type SessionToolResponse = z.infer<typeof sessionToolResponseSchema>;

export const claudeMcpResponseSchema = z.discriminatedUnion('type', [
  permissionResponseSchema,
  agentToolResponseSchema,
  sessionToolResponseSchema,
]);
export type ClaudeMcpResponse = z.infer<typeof claudeMcpResponseSchema>;

export type ClaudeAgentToolResult =
  | StartAgentResult
  | ListAgentsResult
  | SendAgentMessageResult
  | StopAgentResult
  | FinishAgentResult;

/** The manager operations used by the Claude bridge. */
export interface ClaudeAgentToolDispatcher {
  startAgent(caller: AgentCallerIdentity, request: unknown): Promise<StartAgentResult>;
  listAgents(caller: AgentCallerIdentity): ListAgentsResult | Promise<ListAgentsResult>;
  sendAgentMessage(caller: AgentCallerIdentity, request: unknown): Promise<SendAgentMessageResult>;
  stopAgent(caller: AgentCallerIdentity, request: unknown): Promise<StopAgentResult>;
  finishAgent(caller: AgentCallerIdentity, request: unknown): Promise<FinishAgentResult>;
}

/**
 * Trusted data bound by the parent process when one MCP bridge is installed.
 * The child receives only `allowedTools`; it never receives this identity.
 */
export interface ClaudeAgentToolContext {
  readonly caller: AgentIdentity;
  readonly allowedTools: ReadonlySet<ClaudeAgentToolName>;
  readonly dispatcher: ClaudeAgentToolDispatcher;
}

/**
 * Create the adapter used by the socket router for an AgentManager instance.
 * This keeps the Claude transport from reimplementing manager policy.
 */
export function createClaudeAgentToolDispatcher(
  manager: Pick<
    AgentManager,
    'startAgent' | 'listAgents' | 'sendAgentMessage' | 'stopAgent' | 'finishAgent'
  >
): ClaudeAgentToolDispatcher {
  return {
    startAgent: (caller, request) => manager.startAgent(caller, request),
    listAgents: (caller) => manager.listAgents(caller),
    sendAgentMessage: (caller, request) => manager.sendAgentMessage(caller, request),
    stopAgent: (caller, request) => manager.stopAgent(caller, request),
    finishAgent: (caller, request) => manager.finishAgent(caller, request),
  };
}

export interface ClaudePermissionPromptRequest<T> {
  readonly requesterName: string;
  readonly requesterToken: string;
  readonly requestId: string;
  readonly run: (signal: AbortSignal) => Promise<T>;
}

/**
 * Root-owned prompt coordination boundary. The FIFO implementation belongs to
 * the permission-prompt task; the MCP bridge only needs this contract so it
 * can bind cancellation to the originating socket.
 */
export interface ClaudePermissionPromptCoordinator {
  enqueue<T>(request: ClaudePermissionPromptRequest<T>): Promise<T>;
  cancelRequester(requesterToken: string): void;
  dispose(): void | Promise<void>;
}

export const CLAUDE_AGENT_ARGUMENT_SCHEMAS = AGENT_ARGUMENT_SCHEMAS;

export type ClaudeAgentArgumentSchema = AgentArgumentSchema;

export function getClaudeAgentArgumentSchema(
  toolName: ClaudeAgentToolName
): ClaudeAgentArgumentSchema {
  return CLAUDE_AGENT_ARGUMENT_SCHEMAS[toolName];
}

export function callerIdentityFromAgent(identity: AgentIdentity): AgentCallerIdentity {
  return { id: identity.id, role: identity.role };
}
