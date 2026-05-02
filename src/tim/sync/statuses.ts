export const QUEUE_ACTIVE_STATUSES = ['queued', 'sending', 'failed_retryable'] as const;
export const QUEUE_FLUSHABLE_STATUSES = ['queued', 'failed_retryable'] as const;
export const QUEUE_TERMINAL_STATUSES = ['acked', 'conflict', 'rejected'] as const;

export type QueueActiveStatus = (typeof QUEUE_ACTIVE_STATUSES)[number];
export type QueueTerminalStatus = (typeof QUEUE_TERMINAL_STATUSES)[number];
export type QueueOperationStatus = QueueActiveStatus | QueueTerminalStatus;

export function sqlPlaceholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

export function isTerminalQueueStatus(status: QueueOperationStatus): boolean {
  return (QUEUE_TERMINAL_STATUSES as readonly string[]).includes(status);
}
