import type { StructuredMessage } from '../../../logging/structured_messages.ts';

export interface FormattedCodexMessage {
  // Structured message payload(s) for headless consumers
  structured?: StructuredMessage | StructuredMessage[];
  // A simplified type label for routing/logic
  type: string;
  // If this line carries or finalizes the agent message, include it here
  agentMessage?: string;
  // Codex thread/session identifiers surfaced in the stream
  threadId?: string;
  sessionId?: string;
  // The "last token count" from a `token_count` message
  lastTokenCount?: number;
  // Failure detection info for agent messages
  failed?: boolean;
}
