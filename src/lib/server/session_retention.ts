import type { DisplayMessage, SessionData } from './session_manager.js';

const KIB = 1024;
const MIB = 1024 * KIB;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface SessionMessageLimits {
  maxMessages: number;
  maxBytes: number;
}

export interface InactiveSessionRetentionPolicy extends SessionMessageLimits {
  ttlMs: number;
}

export interface SessionRetentionConfig {
  maxInactiveSessions: number;
  maxInactiveBytes: number;
}

export interface SessionRetentionConfigInput {
  maxInactiveSessions?: number;
  maxInactiveBytes?: number;
}

export interface CompactSessionMessagesResult {
  messages: DisplayMessage[];
  changed: boolean;
  removedCount: number;
}

export const ACTIVE_SESSION_MESSAGE_LIMITS: SessionMessageLimits = {
  maxMessages: 5000,
  maxBytes: 10 * MIB,
};

export const DEFAULT_SESSION_RETENTION_CONFIG: SessionRetentionConfig = {
  maxInactiveSessions: 200,
  maxInactiveBytes: 64 * MIB,
};

const AGENT_COMMANDS = new Set(['agent', 'agent-multi', 'chat', 'autoreview']);
const MEDIUM_COMMANDS = new Set(['generate', 'pr-fix', 'rebase']);
const SHORT_COMMANDS = new Set(['proof', 'upload-artifacts', 'update-docs', 'finish', 'pr-create']);
const IMPORTANT_RAW_TYPES = new Set([
  'agent_session_start',
  'execution_summary',
  'review_result',
  'failure_report',
]);
const PRUNED_MESSAGE_RAW_TYPE = 'session_history_pruned';

export function resolveSessionRetentionConfig(
  input?: SessionRetentionConfigInput
): SessionRetentionConfig {
  return {
    maxInactiveSessions:
      input?.maxInactiveSessions ?? DEFAULT_SESSION_RETENTION_CONFIG.maxInactiveSessions,
    maxInactiveBytes: input?.maxInactiveBytes ?? DEFAULT_SESSION_RETENTION_CONFIG.maxInactiveBytes,
  };
}

export function getInactiveSessionRetentionPolicy(
  command: string,
  status: SessionData['status']
): InactiveSessionRetentionPolicy {
  if (status === 'notification' || command === 'notification') {
    return {
      ttlMs: DAY_MS,
      maxMessages: 200,
      maxBytes: 512 * KIB,
    };
  }

  if (AGENT_COMMANDS.has(command)) {
    return {
      ttlMs: 7 * DAY_MS,
      maxMessages: 500,
      maxBytes: 2 * MIB,
    };
  }

  if (MEDIUM_COMMANDS.has(command)) {
    return {
      ttlMs: 3 * DAY_MS,
      maxMessages: 250,
      maxBytes: MIB,
    };
  }

  if (command === 'review-guide') {
    return {
      ttlMs: DAY_MS,
      maxMessages: 200,
      maxBytes: MIB,
    };
  }

  if (command === 'review-guide-comment') {
    return {
      ttlMs: 30 * MINUTE_MS,
      maxMessages: 100,
      maxBytes: 512 * KIB,
    };
  }

  if (SHORT_COMMANDS.has(command)) {
    return {
      ttlMs: 6 * HOUR_MS,
      maxMessages: 100,
      maxBytes: 512 * KIB,
    };
  }

  return {
    ttlMs: 3 * DAY_MS,
    maxMessages: 250,
    maxBytes: MIB,
  };
}

export function estimateDisplayMessageBytes(message: DisplayMessage): number {
  try {
    return Buffer.byteLength(JSON.stringify(message), 'utf8');
  } catch {
    return KIB;
  }
}

export function estimateSessionMessageBytes(session: Pick<SessionData, 'messages'>): number {
  return session.messages.reduce(
    (total, message) => total + estimateDisplayMessageBytes(message),
    0
  );
}

export function getSessionLastActivityMs(
  session: Pick<SessionData, 'connectedAt' | 'disconnectedAt' | 'messages'>
): number {
  const latestMessageTimestamp = session.messages.at(-1)?.timestamp;
  const timestamp = session.disconnectedAt ?? latestMessageTimestamp ?? session.connectedAt;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createPrunedMessage(
  connectionId: string,
  removedCount: number,
  timestamp: string,
  seq: number
): DisplayMessage {
  return {
    id: `${connectionId}:history-pruned:${removedCount}:${seq}`,
    seq,
    timestamp,
    category: 'log',
    bodyType: 'text',
    body: {
      type: 'text',
      text: `${removedCount.toLocaleString()} earlier session message${
        removedCount === 1 ? ' was' : 's were'
      } pruned.`,
    },
    rawType: PRUNED_MESSAGE_RAW_TYPE,
  };
}

function findImportantMessageIndexes(messages: DisplayMessage[]): number[] {
  const indexes = new Set<number>();

  for (const rawType of IMPORTANT_RAW_TYPES) {
    if (rawType === 'agent_session_start') {
      const firstIndex = messages.findIndex((message) => message.rawType === rawType);
      if (firstIndex !== -1) {
        indexes.add(firstIndex);
      }
      continue;
    }

    const lastIndex = messages.findLastIndex((message) => message.rawType === rawType);
    if (lastIndex !== -1) {
      indexes.add(lastIndex);
    }
  }

  const lastErrorIndex = messages.findLastIndex((message) => message.category === 'error');
  if (lastErrorIndex !== -1) {
    indexes.add(lastErrorIndex);
  }

  return [...indexes].toSorted((a, b) => a - b);
}

export function compactSessionMessages(
  connectionId: string,
  inputMessages: DisplayMessage[],
  limits: SessionMessageLimits,
  targetRatio = 1
): CompactSessionMessagesResult {
  const inputBytes = inputMessages.reduce(
    (total, message) => total + estimateDisplayMessageBytes(message),
    0
  );

  if (inputMessages.length <= limits.maxMessages && inputBytes <= limits.maxBytes) {
    return {
      messages: inputMessages,
      changed: false,
      removedCount: 0,
    };
  }

  const messages = inputMessages.filter((message) => message.rawType !== PRUNED_MESSAGE_RAW_TYPE);
  const targetMessages = Math.max(1, Math.floor(limits.maxMessages * targetRatio));
  const targetBytes = Math.max(1, Math.floor(limits.maxBytes * targetRatio));
  const markerReserve = 1;
  const selectedIndexes = new Set<number>();
  let selectedBytes = 0;

  const trySelect = (index: number): void => {
    if (selectedIndexes.has(index) || selectedIndexes.size >= targetMessages - markerReserve) {
      return;
    }

    const message = messages[index];
    if (!message) {
      return;
    }

    const messageBytes = estimateDisplayMessageBytes(message);
    if (selectedBytes + messageBytes > targetBytes) {
      return;
    }

    selectedIndexes.add(index);
    selectedBytes += messageBytes;
  };

  for (const index of findImportantMessageIndexes(messages)) {
    trySelect(index);
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    trySelect(index);
  }

  const retained = [...selectedIndexes]
    .toSorted((a, b) => a - b)
    .map((index) => messages[index])
    .filter((message): message is DisplayMessage => message != null);
  const firstRetained = retained[0] ?? messages.at(-1);
  let removedCount = inputMessages.length - retained.length;
  let marker = createPrunedMessage(
    connectionId,
    removedCount,
    firstRetained?.timestamp ?? new Date(0).toISOString(),
    (firstRetained?.seq ?? 0) - 1
  );

  while (retained.length > 0 && selectedBytes + estimateDisplayMessageBytes(marker) > targetBytes) {
    const removed = retained.shift();
    if (removed) {
      selectedBytes -= estimateDisplayMessageBytes(removed);
    }
  }
  removedCount = inputMessages.length - retained.length;
  marker = createPrunedMessage(
    connectionId,
    removedCount,
    retained[0]?.timestamp ?? firstRetained?.timestamp ?? new Date(0).toISOString(),
    (retained[0]?.seq ?? firstRetained?.seq ?? 0) - 1
  );

  return {
    messages: [marker, ...retained],
    changed: true,
    removedCount,
  };
}
