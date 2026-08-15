import * as z from 'zod/v4';

import {
  agentAddressSchema,
  agentExecutorSchema,
  agentIdSchema,
  agentNameSchema,
  agentTypeSchema,
} from '../../agent_messaging/contracts.js';
import type { AgentIdentity } from '../../agent_messaging/agent_manager_types.js';

/** JSON values accepted by the Codex app-server protocol. */
export type CodexJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CodexJsonValue[]
  | { readonly [key: string]: CodexJsonValue };

export const CODEX_DYNAMIC_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export const CODEX_DYNAMIC_TOOL_NAME_MAX_LENGTH = 128;
export const CODEX_DYNAMIC_TOOL_RESULT_TEXT_MAX_LENGTH = 16_384;
export const CODEX_DYNAMIC_TOOL_ERROR_TEXT_MAX_LENGTH = 2_048;
export const CODEX_DYNAMIC_TOOLS_COMPATIBILITY_ERROR_MESSAGE =
  'Codex app-server does not support experimental dynamic tools. Update Codex CLI or disable experimental.agentMessaging.';
export const CODEX_DYNAMIC_TOOLS_APP_SERVER_REQUIRED_ERROR_MESSAGE =
  'Codex dynamic tools require Codex app-server mode; enable CODEX_USE_APP_SERVER or disable experimental agent tools.';

export class CodexDynamicToolsCompatibilityError extends Error {
  constructor(cause: unknown) {
    super(CODEX_DYNAMIC_TOOLS_COMPATIBILITY_ERROR_MESSAGE, { cause });
    this.name = 'CodexDynamicToolsCompatibilityError';
  }
}

export interface CodexDynamicToolFunctionDefinition {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly deferLoading?: boolean;
  readonly [key: string]: unknown;
}

export interface CodexDynamicToolNamespaceDefinition {
  readonly type: 'namespace';
  readonly name: string;
  readonly description: string;
  readonly tools: readonly CodexDynamicToolFunctionDefinition[];
  readonly [key: string]: unknown;
}

export type CodexDynamicToolDefinition =
  | CodexDynamicToolFunctionDefinition
  | CodexDynamicToolNamespaceDefinition;

export interface CodexDynamicToolCallParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly namespace?: string | null;
  readonly tool: string;
  /** JSON-safe on the wire; the selected Tim schema validates its shape later. */
  readonly arguments: unknown;
  readonly [key: string]: unknown;
}

export interface CodexDynamicToolInputTextContentItem {
  readonly type: 'inputText';
  readonly text: string;
  readonly [key: string]: unknown;
}

export interface CodexDynamicToolInputImageContentItem {
  readonly type: 'inputImage';
  readonly imageUrl: string;
  readonly [key: string]: unknown;
}

export interface CodexDynamicToolInputAudioContentItem {
  readonly type: 'inputAudio';
  readonly audioUrl: string;
  readonly [key: string]: unknown;
}

/** A future content item is retained at the formatting boundary. */
export interface CodexDynamicToolUnknownContentItem {
  readonly type: string;
  readonly [key: string]: unknown;
}

export type CodexDynamicToolContentItem =
  | CodexDynamicToolInputTextContentItem
  | CodexDynamicToolInputImageContentItem
  | CodexDynamicToolInputAudioContentItem
  | CodexDynamicToolUnknownContentItem;

export interface CodexDynamicToolCallResult {
  readonly contentItems: readonly CodexDynamicToolContentItem[];
  readonly success: boolean;
  readonly [key: string]: unknown;
}

export type CodexDynamicToolCallStatus = 'inProgress' | 'completed' | 'failed' | (string & {});

/** Tolerant shape for dynamicToolCall thread items emitted by app-server. */
export interface CodexDynamicToolCallItem {
  readonly type: 'dynamicToolCall';
  readonly id: string;
  readonly namespace?: string | null;
  readonly tool: string;
  readonly arguments: CodexJsonValue;
  readonly status: CodexDynamicToolCallStatus;
  readonly contentItems?: readonly CodexDynamicToolContentItem[] | null;
  readonly success?: boolean | null;
  readonly [key: string]: unknown;
}

export interface CodexDynamicToolProvider {
  /** Trusted identity captured when the provider is installed. */
  readonly caller: AgentIdentity;
  readonly definitions: readonly CodexDynamicToolDefinition[];
  readonly handler: CodexDynamicToolCallHandler;
}

export type CodexDynamicToolCallHandler = (
  params: unknown
) => CodexDynamicToolCallResult | Promise<CodexDynamicToolCallResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Return whether a value can be represented without JSON.stringify surprises. */
export function isCodexJsonValue(
  value: unknown,
  seen = new WeakSet<object>()
): value is CodexJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);

  let valid: boolean;
  if (Array.isArray(value)) {
    valid = value.every((entry) => isCodexJsonValue(entry, seen));
  } else if (isPlainRecord(value)) {
    valid = Object.values(value).every((entry) => isCodexJsonValue(entry, seen));
  } else {
    valid = false;
  }

  seen.delete(value);
  return valid;
}

const jsonValueSchema = z.custom<CodexJsonValue>(
  (value: unknown): value is CodexJsonValue => isCodexJsonValue(value),
  'Value must be JSON serializable'
);
const jsonObjectSchema = z.custom<Record<string, unknown>>(
  (value: unknown): value is Record<string, unknown> =>
    isPlainRecord(value) && isCodexJsonValue(value),
  'Input schema must be a JSON object'
);
const nonEmptyStringSchema = z.string().min(1);

export const codexDynamicToolFunctionDefinitionSchema = z
  .object({
    type: z.literal('function'),
    name: nonEmptyStringSchema,
    description: z.string(),
    inputSchema: jsonObjectSchema,
    deferLoading: z.boolean().optional(),
  })
  .passthrough();

export const codexDynamicToolNamespaceDefinitionSchema = z
  .object({
    type: z.literal('namespace'),
    name: nonEmptyStringSchema,
    description: z.string(),
    tools: z.array(codexDynamicToolFunctionDefinitionSchema).min(1),
  })
  .passthrough();

export const codexDynamicToolDefinitionSchema = z.union([
  codexDynamicToolFunctionDefinitionSchema,
  codexDynamicToolNamespaceDefinitionSchema,
]);

export const codexDynamicToolCallParamsSchema = z
  .object({
    threadId: nonEmptyStringSchema,
    turnId: nonEmptyStringSchema,
    callId: nonEmptyStringSchema,
    namespace: z.string().nullable().optional(),
    tool: nonEmptyStringSchema,
    arguments: jsonValueSchema,
  })
  .passthrough();

function isContentItem(value: unknown): value is CodexDynamicToolContentItem {
  if (!isPlainRecord(value) || !isCodexJsonValue(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'inputText') return typeof value.text === 'string';
  if (value.type === 'inputImage') return typeof value.imageUrl === 'string';
  if (value.type === 'inputAudio') return typeof value.audioUrl === 'string';
  return value.type.length > 0;
}

export const codexDynamicToolContentItemSchema = z.custom<CodexDynamicToolContentItem>(
  (value: unknown): value is CodexDynamicToolContentItem => isContentItem(value),
  'Dynamic tool content item is invalid'
);

export const codexDynamicToolCallResultSchema = z
  .object({
    contentItems: z.array(codexDynamicToolContentItemSchema),
    success: z.boolean(),
  })
  .passthrough();

export const codexDynamicToolCallItemSchema = z
  .object({
    type: z.literal('dynamicToolCall'),
    id: nonEmptyStringSchema,
    namespace: z.string().nullable().optional(),
    tool: nonEmptyStringSchema,
    arguments: jsonValueSchema,
    status: nonEmptyStringSchema,
    contentItems: z.array(codexDynamicToolContentItemSchema).nullable().optional(),
    success: z.boolean().nullable().optional(),
  })
  .passthrough();

export function parseCodexDynamicToolCallParams(value: unknown): CodexDynamicToolCallParams {
  return codexDynamicToolCallParamsSchema.parse(value) as CodexDynamicToolCallParams;
}

export function parseCodexDynamicToolContentItem(value: unknown): CodexDynamicToolContentItem {
  return codexDynamicToolContentItemSchema.parse(value);
}

export function parseCodexDynamicToolCallResult(value: unknown): CodexDynamicToolCallResult {
  return codexDynamicToolCallResultSchema.parse(value) as CodexDynamicToolCallResult;
}

export function parseCodexDynamicToolCallItem(value: unknown): CodexDynamicToolCallItem {
  return codexDynamicToolCallItemSchema.parse(value) as CodexDynamicToolCallItem;
}

function validateDynamicToolName(name: unknown, label: string): asserts name is string {
  if (
    typeof name !== 'string' ||
    name.length < 1 ||
    name.length > CODEX_DYNAMIC_TOOL_NAME_MAX_LENGTH ||
    !CODEX_DYNAMIC_TOOL_NAME_PATTERN.test(name)
  ) {
    throw new TypeError(
      `${label} must contain 1-${CODEX_DYNAMIC_TOOL_NAME_MAX_LENGTH} ASCII letters, digits, underscores, or hyphens`
    );
  }
}

/** Validate the app-server definition invariants needed by Tim. */
export function validateCodexDynamicToolDefinitions(
  value: unknown
): asserts value is readonly CodexDynamicToolDefinition[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('Codex dynamic tool definitions must be a nonempty array');
  }

  const names = new Set<string>();
  const visit = (definition: unknown, label: string): void => {
    const parsed = codexDynamicToolDefinitionSchema.safeParse(definition);
    if (!parsed.success) {
      throw new TypeError(`${label} is not a valid Codex dynamic tool definition`);
    }

    validateDynamicToolName(parsed.data.name, `${label}.name`);
    if (names.has(parsed.data.name)) {
      throw new TypeError(`Codex dynamic tool names must be unique: ${parsed.data.name}`);
    }
    names.add(parsed.data.name);

    if (parsed.data.type === 'namespace') {
      parsed.data.tools.forEach((tool, index) => visit(tool, `${label}.tools[${index}]`));
    }
  };

  value.forEach((definition, index) => visit(definition, `definitions[${index}]`));
}

export function validateCodexDynamicToolCaller(value: unknown): asserts value is AgentIdentity {
  if (!isRecord(value)) throw new TypeError('Codex dynamic tool caller must be an object');
  if (!agentIdSchema.safeParse(value.id).success) {
    throw new TypeError('Codex dynamic tool caller ID is invalid');
  }
  if (value.role !== 'orchestrator' && value.role !== 'subagent') {
    throw new TypeError('Codex dynamic tool caller role is invalid');
  }
  if (!agentExecutorSchema.safeParse(value.executor).success) {
    throw new TypeError('Codex dynamic tool caller executor is invalid');
  }
  if (value.role === 'orchestrator') {
    if (value.name !== 'orchestrator' || !agentAddressSchema.safeParse(value.name).success) {
      throw new TypeError('Codex orchestrator caller identity is invalid');
    }
    return;
  }
  if (!agentNameSchema.safeParse(value.name).success) {
    throw new TypeError('Codex subagent caller name is invalid');
  }
  if (!agentTypeSchema.safeParse(value.type).success) {
    throw new TypeError('Codex subagent caller type is invalid');
  }
}

/** Validate one cohesive provider before it is handed to an app-server runner. */
export function validateCodexDynamicToolProvider(
  value: unknown
): asserts value is CodexDynamicToolProvider {
  if (!isRecord(value)) throw new TypeError('Codex dynamic tool provider must be an object');
  validateCodexDynamicToolCaller(value.caller);
  validateCodexDynamicToolDefinitions(value.definitions);
  if (typeof value.handler !== 'function') {
    throw new TypeError('Codex dynamic tool provider handler must be callable');
  }
}

export function toCodexJsonSafeValue(value: unknown, seen = new WeakSet<object>()): CodexJsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  let result: CodexJsonValue;
  if (Array.isArray(value)) {
    result = value.map((entry) => toCodexJsonSafeValue(entry, seen));
  } else {
    const record = value as Record<string, unknown>;
    const objectResult: Record<string, CodexJsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      try {
        objectResult[key] = toCodexJsonSafeValue(record[key], seen);
      } catch {
        objectResult[key] = '[Unreadable]';
      }
    }
    result = objectResult;
  }

  seen.delete(value);
  return result;
}

function boundText(value: string, maxLength: number, fallback: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) return fallback;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

/** Serialize manager results with sorted keys and safe handling of cycles. */
export function serializeCodexDynamicToolResult(value: unknown): string {
  const serialized = JSON.stringify(toCodexJsonSafeValue(value));
  return serialized === undefined ? 'null' : serialized;
}

export function createCodexDynamicToolTextResult(
  success: boolean,
  text: string,
  fallback = success ? 'The agent tool returned no result.' : 'The agent tool request failed.'
): CodexDynamicToolCallResult {
  return {
    contentItems: [
      {
        type: 'inputText',
        text: boundText(text, CODEX_DYNAMIC_TOOL_RESULT_TEXT_MAX_LENGTH, fallback),
      },
    ],
    success,
  };
}

export function createCodexDynamicToolSuccessResult(value: unknown): CodexDynamicToolCallResult {
  return createCodexDynamicToolTextResult(true, serializeCodexDynamicToolResult(value));
}

export function createCodexDynamicToolFailureResult(message: string): CodexDynamicToolCallResult {
  return createCodexDynamicToolTextResult(
    false,
    boundText(message, CODEX_DYNAMIC_TOOL_ERROR_TEXT_MAX_LENGTH, 'The agent tool request failed.'),
    'The agent tool request failed.'
  );
}

export function boundCodexDynamicToolErrorText(message: string): string {
  return boundText(
    message,
    CODEX_DYNAMIC_TOOL_ERROR_TEXT_MAX_LENGTH,
    'The agent tool request failed.'
  );
}
