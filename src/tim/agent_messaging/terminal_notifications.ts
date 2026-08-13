import { ORCHESTRATOR_AGENT_NAME } from './contracts.js';

export type TerminalNotificationCause =
  | 'natural'
  | 'self-finish'
  | 'graceful-stop'
  | 'forced-stop'
  | 'provider-failure';

export interface TerminalOutboundSnapshot {
  readonly target: string;
  readonly content: string;
}

export interface TerminalNotificationInput {
  readonly agentName: string;
  readonly cause: TerminalNotificationCause;
  readonly lastCompletedAssistantMessage?: string;
  readonly finishFallbackMessage?: string;
  readonly lastSuccessfulOutbound?: TerminalOutboundSnapshot;
}

export interface TerminalNotificationDecision {
  readonly suppressed: boolean;
  readonly content?: string;
}

export const NO_COMPLETED_ASSISTANT_MESSAGE = 'No completed assistant message was available.';

export const FORCE_STOP_STALE_CONTEXT_WARNING =
  'Warning: This message can be stale or out of context because the agent was force-stopped.';

function hasNonblankContent(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

export function selectTerminalResult(input: TerminalNotificationInput): string | undefined {
  if (hasNonblankContent(input.lastCompletedAssistantMessage)) {
    return input.lastCompletedAssistantMessage;
  }
  if (input.cause === 'self-finish' && hasNonblankContent(input.finishFallbackMessage)) {
    return input.finishFallbackMessage;
  }
  return undefined;
}

export function shouldSuppressTerminalNotification(input: TerminalNotificationInput): boolean {
  if (
    input.cause === 'forced-stop' ||
    input.cause === 'provider-failure' ||
    !hasNonblankContent(input.lastCompletedAssistantMessage) ||
    input.lastSuccessfulOutbound?.target !== ORCHESTRATOR_AGENT_NAME ||
    !hasNonblankContent(input.lastSuccessfulOutbound.content)
  ) {
    return false;
  }
  return input.lastSuccessfulOutbound.content.trim() === input.lastCompletedAssistantMessage.trim();
}

export function formatTerminalNotification(
  input: TerminalNotificationInput
): TerminalNotificationDecision {
  if (shouldSuppressTerminalNotification(input)) {
    return Object.freeze({ suppressed: true });
  }

  if (input.cause === 'forced-stop') {
    return Object.freeze({
      suppressed: false,
      content: `${input.lastCompletedAssistantMessage ?? NO_COMPLETED_ASSISTANT_MESSAGE}\n\n${FORCE_STOP_STALE_CONTEXT_WARNING}`,
    });
  }

  if (input.cause === 'provider-failure') {
    return Object.freeze({
      suppressed: false,
      content: `Agent ${input.agentName} failed before completing.`,
    });
  }

  const result = selectTerminalResult(input);
  return Object.freeze({
    suppressed: false,
    content:
      result === undefined
        ? `Agent ${input.agentName} completed without a final result.\n\n${NO_COMPLETED_ASSISTANT_MESSAGE}`
        : `Agent ${input.agentName} completed.\n\nFinal result:\n${result}`,
  });
}
