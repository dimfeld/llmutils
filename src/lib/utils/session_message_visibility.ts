import type { DisplayMessage } from '$lib/types/session.js';
import { getTimAgentToolPresentation } from './message_formatting.js';

export function filterSessionMessages(
  messages: DisplayMessage[],
  showLifecycleOutput: boolean,
  showToolCalls: boolean
): DisplayMessage[] {
  return messages.filter((message) => {
    if (message.body.type === 'structured') {
      const structured = message.body.message;
      if (structured.type === 'llm_tool_use' || structured.type === 'llm_tool_result') {
        if (getTimAgentToolPresentation(structured) !== null) return true;
        if (!showToolCalls) return false;
      } else if (
        !showToolCalls &&
        (structured.type === 'command_exec' ||
          structured.type === 'command_result' ||
          structured.type === 'file_write' ||
          structured.type === 'file_edit' ||
          structured.type === 'file_change_summary')
      ) {
        return false;
      }
    }
    return showLifecycleOutput || message.origin !== 'lifecycle';
  });
}
