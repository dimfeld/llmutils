import * as z from 'zod/v4';

import {
  finishAgentArgumentsSchema,
  listAgentsArgumentsSchema,
  sendAgentMessageArgumentsSchema,
  startAgentArgumentsSchema,
  stopAgentArgumentsSchema,
  type FinishAgentResult,
  type ListAgentsResult,
  type SendAgentMessageResult,
  type StartAgentResult,
  type StopAgentResult,
} from '../../agent_messaging/contracts.js';
import {
  AgentManagerError,
  type AgentCallerIdentity,
  type AgentIdentity,
} from '../../agent_messaging/agent_manager_types.js';
import { debugLog } from '../../../logging.js';
import {
  codexDynamicToolCallParamsSchema,
  createCodexDynamicToolFailureResult,
  createCodexDynamicToolSuccessResult,
  serializeCodexDynamicToolResult,
  type CodexDynamicToolCallHandler,
  type CodexDynamicToolCallParams,
  type CodexDynamicToolDefinition,
  type CodexDynamicToolProvider,
  validateCodexDynamicToolCaller,
  validateCodexDynamicToolProvider,
} from './app_server_dynamic_tools.js';

export const CODEX_AGENT_TOOL_NAMES = [
  'StartAgent',
  'ListAgents',
  'SendAgentMessage',
  'StopAgent',
  'FinishAgent',
] as const;
export type CodexAgentToolName = (typeof CODEX_AGENT_TOOL_NAMES)[number];

export const CODEX_ORCHESTRATOR_TOOL_NAMES = [
  'StartAgent',
  'ListAgents',
  'SendAgentMessage',
  'StopAgent',
] as const satisfies readonly CodexAgentToolName[];

export const CODEX_SUBAGENT_TOOL_NAMES = [
  'ListAgents',
  'SendAgentMessage',
  'FinishAgent',
] as const satisfies readonly CodexAgentToolName[];

export interface CodexAgentToolDispatcher {
  startAgent(caller: AgentCallerIdentity, request: unknown): Promise<StartAgentResult>;
  listAgents(caller: AgentCallerIdentity): ListAgentsResult | Promise<ListAgentsResult>;
  sendAgentMessage(caller: AgentCallerIdentity, request: unknown): Promise<SendAgentMessageResult>;
  stopAgent(caller: AgentCallerIdentity, request: unknown): Promise<StopAgentResult>;
  finishAgent(caller: AgentCallerIdentity, request: unknown): Promise<FinishAgentResult>;
}

/** Trusted parent-bound context used to create one Codex dynamic-tool provider. */
export interface CodexAgentToolContext {
  readonly caller: AgentIdentity;
  readonly dispatcher: CodexAgentToolDispatcher;
}

export const CODEX_AGENT_ARGUMENT_SCHEMAS = {
  StartAgent: startAgentArgumentsSchema,
  ListAgents: listAgentsArgumentsSchema,
  SendAgentMessage: sendAgentMessageArgumentsSchema,
  StopAgent: stopAgentArgumentsSchema,
  FinishAgent: finishAgentArgumentsSchema,
} as const;

export type CodexAgentArgumentSchema = (typeof CODEX_AGENT_ARGUMENT_SCHEMAS)[CodexAgentToolName];

const CODEX_AGENT_TOOL_DESCRIPTIONS: Record<CodexAgentToolName, string> = {
  StartAgent: 'Start a named subagent with a task and initial message.',
  ListAgents: 'List the active agents and their current states.',
  SendAgentMessage: 'Send a message to an active agent by name.',
  StopAgent: 'Gracefully or forcibly stop an active subagent by name.',
  FinishAgent: 'Finish your current subagent work and provide an optional final status.',
};

const CODEX_AGENT_ARGUMENT_KEYS: Record<CodexAgentToolName, readonly string[]> = {
  StartAgent: ['name', 'type', 'executor', 'initialMessage'],
  ListAgents: [],
  SendAgentMessage: ['name', 'message'],
  StopAgent: ['name', 'message', 'force'],
  FinishAgent: ['message'],
};

export function getCodexAgentToolNames(role: AgentIdentity['role']): readonly CodexAgentToolName[] {
  return role === 'orchestrator' ? CODEX_ORCHESTRATOR_TOOL_NAMES : CODEX_SUBAGENT_TOOL_NAMES;
}

export function getCodexAgentArgumentSchema(
  toolName: CodexAgentToolName
): CodexAgentArgumentSchema {
  return CODEX_AGENT_ARGUMENT_SCHEMAS[toolName];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCodexAgentToolContext(context: CodexAgentToolContext): void {
  if (!isRecord(context)) throw new TypeError('Codex agent tool context must be an object');
  validateCodexDynamicToolCaller(context.caller);
  if (!isRecord(context.dispatcher)) {
    throw new TypeError('Codex agent tool dispatcher must be an object');
  }
  for (const method of [
    'startAgent',
    'listAgents',
    'sendAgentMessage',
    'stopAgent',
    'finishAgent',
  ]) {
    if (typeof context.dispatcher[method] !== 'function') {
      throw new TypeError(`Codex agent tool dispatcher ${method} must be a function`);
    }
  }
}

function freezeJsonValue(value: unknown): unknown {
  if (!isRecord(value) && !Array.isArray(value)) return value;
  if (Object.isFrozen(value)) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    freezeJsonValue(child);
  }
  return Object.freeze(value);
}

function createDefinition(toolName: CodexAgentToolName): CodexDynamicToolDefinition {
  const inputSchema = z.toJSONSchema(getCodexAgentArgumentSchema(toolName), {
    target: 'draft-7',
    io: 'input',
  });
  if (!isRecord(inputSchema)) {
    throw new TypeError(`Generated JSON schema for ${toolName} is not an object`);
  }
  freezeJsonValue(inputSchema);
  return Object.freeze({
    type: 'function' as const,
    name: toolName,
    description: CODEX_AGENT_TOOL_DESCRIPTIONS[toolName],
    inputSchema,
  });
}

function createDefinitions(role: AgentIdentity['role']): readonly CodexDynamicToolDefinition[] {
  return Object.freeze(getCodexAgentToolNames(role).map(createDefinition));
}

function callerIdentityFromAgent(identity: AgentIdentity): AgentCallerIdentity {
  return { id: identity.id, role: identity.role };
}

function formatEnvelopeFailure(value: unknown): string {
  if (!isRecord(value)) return 'Dynamic tool call is invalid: parameters must be an object.';

  const missing: string[] = [];
  for (const key of ['threadId', 'turnId', 'callId', 'tool', 'arguments']) {
    if (!Object.hasOwn(value, key)) missing.push(key);
  }
  if (missing.length > 0) {
    return `Dynamic tool call is invalid: missing ${missing.join(', ')}.`;
  }
  if (typeof value.threadId !== 'string' || value.threadId.length === 0) {
    return 'Dynamic tool call is invalid: threadId must be a nonempty string.';
  }
  if (typeof value.turnId !== 'string' || value.turnId.length === 0) {
    return 'Dynamic tool call is invalid: turnId must be a nonempty string.';
  }
  if (typeof value.callId !== 'string' || value.callId.length === 0) {
    return 'Dynamic tool call is invalid: callId must be a nonempty string.';
  }
  if (typeof value.tool !== 'string' || value.tool.length === 0) {
    return 'Dynamic tool call is invalid: tool must be a nonempty string.';
  }
  if (
    value.namespace !== undefined &&
    value.namespace !== null &&
    typeof value.namespace !== 'string'
  ) {
    return `Dynamic tool call for ${value.tool} is invalid: namespace must be a string or null.`;
  }
  return `Arguments for ${value.tool} are invalid: arguments must be JSON.`;
}

function formatArgumentFailure(toolName: string, value: unknown): string {
  if (!isRecord(value)) return `Arguments for ${toolName} are invalid: expected an object.`;
  if (Object.hasOwn(value, 'target') && toolName === 'FinishAgent') {
    return 'Arguments for FinishAgent are invalid: FinishAgent does not accept a target.';
  }
  const allowedKeys = CODEX_AGENT_ARGUMENT_KEYS[toolName as CodexAgentToolName];
  const unexpectedKey =
    allowedKeys === undefined
      ? undefined
      : Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unexpectedKey === 'source') {
    return `Arguments for ${toolName} are invalid: source is not accepted from the model.`;
  }
  if (unexpectedKey === 'role' || unexpectedKey === 'caller' || unexpectedKey === 'callerId') {
    return `Arguments for ${toolName} are invalid: ${unexpectedKey} is trusted and cannot be supplied.`;
  }
  if (unexpectedKey !== undefined) {
    return `Arguments for ${toolName} are invalid: ${unexpectedKey} is not accepted.`;
  }
  return `Arguments for ${toolName} are invalid.`;
}

function formatManagerFailure(toolName: string, error: AgentManagerError): string {
  switch (error.code) {
    case 'invalid_request':
      return `Agent tool ${toolName} request was rejected.`;
    case 'manager_closed':
      return `Agent tool ${toolName} is unavailable because the agent manager is closed.`;
    case 'not_authorized':
      return `Agent tool ${toolName} is not authorized for this caller.`;
    case 'invalid_name':
      return `Agent tool ${toolName} rejected the target agent name.`;
    case 'reserved_name':
      return `Agent tool ${toolName} rejected the reserved agent name.`;
    case 'name_in_use':
      return `Agent tool ${toolName} rejected the request because that agent name is already in use.`;
    case 'name_generation_exhausted':
      return `Agent tool ${toolName} could not generate an available agent name.`;
    case 'identity_generation_exhausted':
      return `Agent tool ${toolName} could not allocate an agent identity.`;
    case 'agent_limit_reached':
      return `Agent tool ${toolName} could not start an agent because the session limit was reached.`;
    case 'unknown_sender':
      return `Agent tool ${toolName} rejected the request because the caller is not active.`;
    case 'unknown_target':
      return `Agent tool ${toolName} failed: Unknown or inactive target agent.`;
    case 'target_not_accepting_messages':
      return `Agent tool ${toolName} rejected the request because the target is not accepting messages.`;
    case 'unknown_agent':
      return `Agent tool ${toolName} could not find the requested agent.`;
    case 'finish_not_available':
      return `Agent tool ${toolName} is not available for the current agent turn.`;
    case 'invalid_options':
    case 'launch_failed':
    case 'transport_error':
    case 'root_registration_failed':
    case 'force_failed':
      return `Agent tool ${toolName} could not complete the request.`;
    default:
      return `Agent tool ${toolName} could not complete the request.`;
  }
}

function createBoundHandler(context: CodexAgentToolContext): CodexDynamicToolCallHandler {
  const allowedTools = new Set<string>(getCodexAgentToolNames(context.caller.role));
  const knownTools = new Set<string>(CODEX_AGENT_TOOL_NAMES);
  const caller = callerIdentityFromAgent(context.caller);

  return async (
    rawParams: unknown
  ): Promise<ReturnType<typeof createCodexDynamicToolFailureResult>> => {
    const parsedParams = codexDynamicToolCallParamsSchema.safeParse(rawParams);
    if (!parsedParams.success) {
      return createCodexDynamicToolFailureResult(formatEnvelopeFailure(rawParams));
    }
    const params = parsedParams.data as CodexDynamicToolCallParams;
    const toolName = params.tool;
    if (
      params.namespace !== undefined &&
      params.namespace !== null &&
      params.namespace.length > 0
    ) {
      return createCodexDynamicToolFailureResult(
        `Agent tool ${toolName} is top-level and does not accept namespace ${params.namespace}.`
      );
    }
    if (!allowedTools.has(toolName)) {
      if (!knownTools.has(toolName)) {
        return createCodexDynamicToolFailureResult(`Unknown agent tool ${toolName}.`);
      }
      return createCodexDynamicToolFailureResult(
        `Agent tool ${toolName} is not allowed for ${context.caller.role} callers.`
      );
    }

    const argumentSchema = getCodexAgentArgumentSchema(toolName as CodexAgentToolName);
    const parsedArguments = argumentSchema.safeParse(params.arguments);
    if (!parsedArguments.success) {
      return createCodexDynamicToolFailureResult(formatArgumentFailure(toolName, params.arguments));
    }

    try {
      let result: unknown;
      switch (toolName) {
        case 'StartAgent':
          result = await context.dispatcher.startAgent(caller, parsedArguments.data);
          break;
        case 'ListAgents':
          result = await context.dispatcher.listAgents(caller);
          break;
        case 'SendAgentMessage':
          result = await context.dispatcher.sendAgentMessage(caller, parsedArguments.data);
          break;
        case 'StopAgent':
          result = await context.dispatcher.stopAgent(caller, parsedArguments.data);
          break;
        case 'FinishAgent':
          result = await context.dispatcher.finishAgent(caller, parsedArguments.data);
          break;
        default: {
          return createCodexDynamicToolFailureResult(`Unknown agent tool ${toolName}.`);
        }
      }
      return createCodexDynamicToolSuccessResult(result);
    } catch (error) {
      if (error instanceof AgentManagerError) {
        return createCodexDynamicToolFailureResult(formatManagerFailure(toolName, error));
      }
      debugLog(`Unexpected Codex agent tool failure in ${toolName}:`, error);
      return createCodexDynamicToolFailureResult(
        `Agent tool ${toolName} failed unexpectedly. Try the request again.`
      );
    }
  };
}

/** Validate that a provider contains exactly the built-in role tool set. */
export function validateCodexAgentToolProvider(provider: CodexDynamicToolProvider): void {
  validateCodexDynamicToolProvider(provider);
  const expected = new Set<string>(getCodexAgentToolNames(provider.caller.role));
  if (provider.definitions.length !== expected.size) {
    throw new TypeError(`Codex agent definitions do not match the ${provider.caller.role} role`);
  }
  const names = new Set<string>();
  for (const definition of provider.definitions) {
    if (
      definition.type !== 'function' ||
      !expected.has(definition.name) ||
      names.has(definition.name)
    ) {
      throw new TypeError(`Codex agent definitions do not match the ${provider.caller.role} role`);
    }
    names.add(definition.name);
  }
  if (names.size !== expected.size) {
    throw new TypeError(`Codex agent definitions do not match the ${provider.caller.role} role`);
  }

  const expectedDefinitions = new Map(
    createDefinitions(provider.caller.role).map((definition) => [definition.name, definition])
  );
  for (const definition of provider.definitions) {
    const expectedDefinition = expectedDefinitions.get(definition.name);
    if (
      expectedDefinition === undefined ||
      serializeCodexDynamicToolResult(definition) !==
        serializeCodexDynamicToolResult(expectedDefinition)
    ) {
      throw new TypeError(`Codex agent definitions do not match the ${provider.caller.role} role`);
    }
  }
}

/** Create one trusted, role-authorized Codex dynamic-tool provider. */
export function createCodexAgentToolProvider(
  context: CodexAgentToolContext
): CodexDynamicToolProvider {
  validateCodexAgentToolContext(context);
  const boundContext: CodexAgentToolContext = {
    caller: Object.freeze({ ...context.caller }),
    dispatcher: context.dispatcher,
  };
  const provider: CodexDynamicToolProvider = {
    caller: boundContext.caller,
    definitions: createDefinitions(context.caller.role),
    handler: createBoundHandler(boundContext),
  };
  validateCodexAgentToolProvider(provider);
  return Object.freeze(provider);
}
