import type { DisplayMessage, MonospacedMessageBody } from '$lib/types/session.js';

/**
 * Raw process output (stdout/stderr) arrives in transport-sized chunks, so a
 * single logical line is frequently split across multiple messages. Merge
 * consecutive runs of the same stream (same rawType and origin) into a single
 * message so the rendered text reflects the real line boundaries.
 *
 * Chunks are concatenated verbatim — the chunk boundary itself carries no
 * separator, so joining with an empty string reconstructs the original stream.
 */
export function mergeConsecutiveOutputMessages(messages: DisplayMessage[]): DisplayMessage[] {
  const merged: DisplayMessage[] = [];

  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (last && isMergeableOutput(last) && isMergeableOutput(message) && canMerge(last, message)) {
      // Replace the accumulated message with a copy whose text includes this
      // chunk. Copying keeps the original message objects untouched.
      const body: MonospacedMessageBody = {
        type: 'monospaced',
        text: last.body.text + message.body.text,
      };
      merged[merged.length - 1] = { ...last, body };
    } else {
      merged.push(message);
    }
  }

  return merged;
}

/** A message that represents raw process output eligible for merging. */
function isMergeableOutput(
  message: DisplayMessage
): message is DisplayMessage & { body: MonospacedMessageBody } {
  return (
    (message.rawType === 'stdout' || message.rawType === 'stderr') &&
    message.body.type === 'monospaced'
  );
}

/** Two output messages may merge only if they come from the same stream. */
function canMerge(a: DisplayMessage, b: DisplayMessage): boolean {
  return a.rawType === b.rawType && a.origin === b.origin;
}
