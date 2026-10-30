import type { DisplayMessage, DisplayMessageBody } from '$lib/types/session.js';

/**
 * The transcript view derives some messages on every update (merged output runs and
 * hidden tool call summaries), so they are new objects each time even when nothing
 * changed. Reuse the previous object for a message that has the same id and the same
 * content, so the keyed list does not render those messages again.
 */
export function reuseUnchangedMessages(
  messages: DisplayMessage[],
  previousById: ReadonlyMap<string, DisplayMessage>
): DisplayMessage[] {
  if (previousById.size === 0) return messages;

  let changed = false;
  const result = messages.map((message) => {
    const previous = previousById.get(message.id);
    if (!previous || previous === message || !isSameDisplayMessage(previous, message)) {
      return message;
    }
    changed = true;
    return previous;
  });
  return changed ? result : messages;
}

function isSameDisplayMessage(a: DisplayMessage, b: DisplayMessage): boolean {
  return (
    a.seq === b.seq &&
    a.timestamp === b.timestamp &&
    a.category === b.category &&
    a.bodyType === b.bodyType &&
    a.rawType === b.rawType &&
    a.origin === b.origin &&
    a.agentName === b.agentName &&
    a.triggersNotification === b.triggersNotification &&
    isSameBody(a.body, b.body)
  );
}

function isSameBody(a: DisplayMessageBody, b: DisplayMessageBody): boolean {
  if (a === b) return true;
  // Derived messages only have text bodies. Other bodies are compared by reference.
  if ((a.type === 'text' || a.type === 'monospaced') && a.type === b.type) {
    return a.text === b.text;
  }
  return false;
}
