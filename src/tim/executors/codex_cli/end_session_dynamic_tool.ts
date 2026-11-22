import * as z from 'zod/v4';
import { isRecord } from '../../../common/type_guards.js';
import {
  END_SESSION_TOOL_DESCRIPTION,
  END_SESSION_TOOL_NAME,
  END_SESSION_TOOL_RESULT_TEXT,
  endSessionToolArgumentsSchema,
  type EndSessionToolHandler,
} from '../shared/end_session_tool.js';
import {
  codexDynamicToolCallParamsSchema,
  createCodexDynamicToolFailureResult,
  createCodexDynamicToolTextResult,
  validateCodexDynamicToolProvider,
  type CodexDynamicToolCallResult,
  type CodexDynamicToolDefinition,
  type CodexDynamicToolFunctionDefinition,
  type CodexDynamicToolProvider,
} from './app_server_dynamic_tools.js';
import { debugLog } from '../../../logging.js';

/** Trusted context of the runner-owned session-end provider. */
export interface CodexEndSessionToolContext {
  readonly kind: 'tim-end-session';
}

/** Trusted context of a provider that combines a caller provider with runner-owned tools. */
export interface CodexMergedDynamicToolContext {
  readonly kind: 'tim-merged-dynamic-tools';
  readonly providers: readonly CodexDynamicToolProvider[];
}

/** Build the Codex dynamic tool definition for `EndTimSession`. */
export function createEndSessionToolDefinition(): CodexDynamicToolFunctionDefinition {
  const inputSchema = z.toJSONSchema(endSessionToolArgumentsSchema, {
    target: 'draft-7',
    io: 'input',
  });
  if (!isRecord(inputSchema)) {
    throw new TypeError(`Generated JSON schema for ${END_SESSION_TOOL_NAME} is not an object`);
  }
  return {
    type: 'function',
    name: END_SESSION_TOOL_NAME,
    description: END_SESSION_TOOL_DESCRIPTION,
    inputSchema,
  };
}

/**
 * Create the runner-owned provider for `EndTimSession`. The handler only records the request
 * through `onEndSession`; the runner decides when the session closes.
 */
export function createEndSessionToolProvider(
  onEndSession: EndSessionToolHandler
): CodexDynamicToolProvider<CodexEndSessionToolContext> {
  return {
    context: { kind: 'tim-end-session' },
    definitions: [createEndSessionToolDefinition()],
    handler: async (params: unknown): Promise<CodexDynamicToolCallResult> => {
      const envelope = codexDynamicToolCallParamsSchema.safeParse(params);
      if (!envelope.success) {
        return createCodexDynamicToolFailureResult('The tool call request is invalid.');
      }
      if (envelope.data.tool !== END_SESSION_TOOL_NAME || envelope.data.namespace) {
        return createCodexDynamicToolFailureResult(`Unknown tool: ${envelope.data.tool}`);
      }

      const args = endSessionToolArgumentsSchema.safeParse(envelope.data.arguments);
      if (!args.success) {
        return createCodexDynamicToolFailureResult(
          `Invalid ${END_SESSION_TOOL_NAME} arguments: ${z.prettifyError(args.error)}`
        );
      }

      try {
        await onEndSession(args.data);
      } catch (err) {
        debugLog(`${END_SESSION_TOOL_NAME} handler failed:`, err);
        return createCodexDynamicToolFailureResult('The session could not be marked to end.');
      }
      return createCodexDynamicToolTextResult(true, END_SESSION_TOOL_RESULT_TEXT);
    },
  };
}

function collectTopLevelToolNames(definitions: readonly CodexDynamicToolDefinition[]): Set<string> {
  return new Set(definitions.map((definition) => definition.name));
}

/**
 * Combine several providers into one. Each `item/tool/call` request goes to the provider that
 * defines the top-level tool (or namespace) named in the request. Definition names must be
 * unique across all providers; the merged provider is validated before it is returned.
 */
export function mergeCodexDynamicToolProviders(
  providers: readonly CodexDynamicToolProvider[]
): CodexDynamicToolProvider<CodexMergedDynamicToolContext> {
  const routes = providers.map((provider) => ({
    provider,
    names: collectTopLevelToolNames(provider.definitions),
  }));

  const merged: CodexDynamicToolProvider<CodexMergedDynamicToolContext> = {
    context: { kind: 'tim-merged-dynamic-tools', providers },
    definitions: providers.flatMap((provider) => provider.definitions),
    handler: async (params: unknown): Promise<CodexDynamicToolCallResult> => {
      const record = isRecord(params) ? params : undefined;
      const namespace =
        typeof record?.namespace === 'string' && record.namespace.length > 0
          ? record.namespace
          : undefined;
      const tool = typeof record?.tool === 'string' ? record.tool : undefined;
      const routeName = namespace ?? tool;
      const route =
        routeName === undefined ? undefined : routes.find(({ names }) => names.has(routeName));
      if (!route) {
        // Let the first provider produce its own bounded "unknown tool" failure.
        const fallback = providers[0];
        if (!fallback) {
          return createCodexDynamicToolFailureResult('No dynamic tools are installed.');
        }
        return await fallback.handler(params);
      }
      return await route.provider.handler(params);
    },
  };

  validateCodexDynamicToolProvider(merged);
  return merged;
}
