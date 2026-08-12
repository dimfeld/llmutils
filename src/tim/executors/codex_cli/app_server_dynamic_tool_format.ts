import type { FormattedCodexMessage } from './format.js';
import { toCodexJsonSafeValue } from './app_server_dynamic_tools.js';

const CODEX_DYNAMIC_TOOL_DISPLAY_SUMMARY_MAX_LENGTH = 4_096;

function extractTextField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function toJsonSafeValue(value: unknown): unknown {
  try {
    return toCodexJsonSafeValue(value);
  } catch {
    return '[Unreadable]';
  }
}

function stringifyJsonSafe(value: unknown, fallback: string): string {
  try {
    const serialized = JSON.stringify(toJsonSafeValue(value));
    return serialized ?? fallback;
  } catch {
    return fallback;
  }
}

function boundDynamicToolDisplaySummary(value: string, fallback: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return fallback;
  }
  if (normalized.length <= CODEX_DYNAMIC_TOOL_DISPLAY_SUMMARY_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, CODEX_DYNAMIC_TOOL_DISPLAY_SUMMARY_MAX_LENGTH - 1)}…`;
}

function formatDynamicToolName(item: Record<string, unknown>): string {
  const tool = extractTextField(item.tool) ?? 'unknown';
  const namespace = extractTextField(item.namespace);
  return namespace ? `${namespace}.${tool}` : tool;
}

function formatDynamicToolInput(item: Record<string, unknown>): {
  input: unknown;
  inputSummary: string;
} {
  const hasArguments = Object.hasOwn(item, 'arguments') && item.arguments !== undefined;
  const input = hasArguments ? item.arguments : null;
  if (!hasArguments) {
    return {
      input,
      inputSummary: 'Arguments were not provided.',
    };
  }

  const serialized = stringifyJsonSafe(input, 'Arguments were not provided.');
  return {
    input: toJsonSafeValue(input),
    inputSummary: boundDynamicToolDisplaySummary(
      `Arguments: ${serialized}`,
      'Arguments were not provided.'
    ),
  };
}

function getDynamicToolContentItems(item: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(item.contentItems)) {
    return item.contentItems;
  }
  return item.contentItems === null ? null : [];
}

function formatDynamicToolContentSummary(contentItems: unknown[] | null): string {
  if (!contentItems || contentItems.length === 0) {
    return 'No text result was provided.';
  }

  const textItems: string[] = [];
  let omittedItems = 0;
  for (const contentItem of contentItems) {
    if (!contentItem || typeof contentItem !== 'object' || Array.isArray(contentItem)) {
      omittedItems += 1;
      continue;
    }
    const data = contentItem as Record<string, unknown>;
    if (data.type === 'inputText' && typeof data.text === 'string') {
      if (data.text.length > 0) {
        textItems.push(data.text);
      }
      continue;
    }
    omittedItems += 1;
  }

  const lines = textItems.length > 0 ? textItems : ['No text result was provided.'];
  if (omittedItems > 0) {
    lines.push(`(${omittedItems} non-text content item(s) omitted.)`);
  }
  return boundDynamicToolDisplaySummary(lines.join('\n'), 'No text result was provided.');
}

function formatDynamicToolStatus(value: unknown): string {
  return extractTextField(value) ?? 'unknown';
}

function buildDynamicToolResult(item: Record<string, unknown>): Record<string, unknown> {
  const contentItems = getDynamicToolContentItems(item);
  const result: Record<string, unknown> = {
    status: formatDynamicToolStatus(item.status),
    success: typeof item.success === 'boolean' ? item.success : null,
    contentItems: toJsonSafeValue(contentItems),
  };
  if (Object.hasOwn(item, 'result')) {
    result.result = toJsonSafeValue(item.result);
  }
  return result;
}

function formatDynamicToolResultSummary(item: Record<string, unknown>): string {
  const success = typeof item.success === 'boolean' ? String(item.success) : 'unknown';
  return boundDynamicToolDisplaySummary(
    [
      `Status: ${formatDynamicToolStatus(item.status)}`,
      `Success: ${success}`,
      `Result:\n${formatDynamicToolContentSummary(getDynamicToolContentItems(item))}`,
    ].join('\n'),
    'The dynamic tool returned no result.'
  );
}

/** Format a dynamic-tool lifecycle item without expanding inline media data. */
export function formatDynamicToolCall(
  item: Record<string, unknown>,
  method: string,
  timestamp: string
): FormattedCodexMessage {
  const toolName = formatDynamicToolName(item);
  if (method === 'item/started') {
    const { input, inputSummary } = formatDynamicToolInput(item);
    return {
      type: method,
      structured: {
        type: 'llm_tool_use',
        timestamp,
        toolName,
        inputSummary,
        input,
      },
    };
  }

  return {
    type: method,
    structured: {
      type: 'llm_tool_result',
      timestamp,
      toolName,
      resultSummary: formatDynamicToolResultSummary(item),
      result: buildDynamicToolResult(item),
    },
  };
}
