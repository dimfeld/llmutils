import type { DisplayMessage } from '$lib/types/session.js';
import { formatStructuredMessage, getTimAgentToolPresentation } from './message_formatting.js';

export function filterSessionMessages(
  messages: DisplayMessage[],
  showLifecycleOutput: boolean,
  showToolCalls: boolean
): DisplayMessage[] {
  const latestRateLimitIndexes = new Map<string, number>();
  messages.forEach((message, index) => {
    const key = getRateLimitMessageKey(message);
    if (key !== null) latestRateLimitIndexes.set(key, index);
  });

  return messages.filter((message, index) => {
    const rateLimitKey = getRateLimitMessageKey(message);
    if (rateLimitKey !== null && latestRateLimitIndexes.get(rateLimitKey) !== index) {
      return false;
    }

    if (
      !showToolCalls &&
      (message.rawType === 'command_exec' || message.rawType === 'command_result')
    ) {
      return false;
    }

    if (message.body.type === 'structured') {
      const structured = message.body.message;
      if (structured.type === 'llm_tool_use' || structured.type === 'llm_tool_result') {
        if (getTimAgentToolPresentation(structured) !== null) return true;
        if (!showToolCalls) return false;
      } else if (
        !showToolCalls &&
        (structured.type === 'file_write' ||
          structured.type === 'file_edit' ||
          structured.type === 'file_change_summary')
      ) {
        return false;
      }
    }
    return showLifecycleOutput || message.origin !== 'lifecycle';
  });
}

/** Replace hidden tool runs with a count without counting results twice. */
export function summarizeHiddenToolCalls(
  messages: DisplayMessage[],
  showLifecycleOutput: boolean,
  showToolCalls: boolean
): DisplayMessage[] {
  const eligible = filterSessionMessages(messages, showLifecycleOutput, true);
  if (showToolCalls) return eligible;

  const visibleIds = new Set(
    filterSessionMessages(eligible, true, false).map((message) => message.id)
  );
  const summarized: DisplayMessage[] = [];
  let firstHidden: DisplayMessage | undefined;
  let calls = 0;
  let results = 0;

  function flush(): void {
    if (!firstHidden) return;
    const count = calls || results;
    summarized.push({
      ...firstHidden,
      id: `hidden-tools:${firstHidden.id}`,
      category: 'log',
      bodyType: 'text',
      rawType: 'hidden_tool_calls',
      body: { type: 'text', text: `${count} tool ${count === 1 ? 'call' : 'calls'} hidden` },
    });
    firstHidden = undefined;
    calls = 0;
    results = 0;
  }

  for (const message of eligible) {
    if (visibleIds.has(message.id)) {
      flush();
      summarized.push(message);
    } else {
      firstHidden ??= message;
      const type = message.body.type === 'structured' ? message.body.message.type : message.rawType;
      if (type === 'llm_tool_result' || type === 'command_result') results++;
      else calls++;
    }
  }
  flush();
  return summarized;
}

function getRateLimitMessageKey(message: DisplayMessage): string | null {
  if (message.body.type !== 'structured') return null;

  const structured = message.body.message;
  if (structured.type === 'token_usage') {
    const formatted = formatStructuredMessage(structured);
    if (formatted?.type !== 'text') return null;
    const rateLimitLine = formatted.text.split('\n').find((line) => line.startsWith('rateLimits='));
    return rateLimitLine ?? null;
  }

  if (structured.type !== 'llm_status' || !structured.status.startsWith('Rate limit')) {
    return null;
  }

  const { source, status, detail, rateLimitInfo } = structured;
  return JSON.stringify(['llm_status', source, status, detail, rateLimitInfo]);
}
