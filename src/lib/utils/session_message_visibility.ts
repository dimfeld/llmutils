import type { DisplayMessage } from '$lib/types/session.js';
import { getTimAgentToolPresentation } from './message_formatting.js';

export function filterSessionMessages(
  messages: DisplayMessage[],
  showLifecycleOutput: boolean,
  showToolCalls: boolean
): DisplayMessage[] {
  return messages.filter((message) => {
    if (
      message.body.type === 'structured' &&
      (message.body.message.type === 'llm_tool_use' ||
        message.body.message.type === 'llm_tool_result')
    ) {
      if (getTimAgentToolPresentation(message.body.message) !== null) return true;
      if (!showToolCalls) return false;
    }
    return showLifecycleOutput || message.origin !== 'lifecycle';
  });
}
