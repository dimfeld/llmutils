/**
 * Normalized values shared by Codex app-server notification consumers.
 *
 * Codex has used both snake-case and camel-case fields in different app-server
 * versions. Keep that compatibility handling at this protocol boundary so
 * runners and formatters do not each implement a slightly different parser.
 */
export interface CodexAppServerNotification {
  readonly method: string;
  readonly lowerMethod: string;
  readonly params: Record<string, unknown>;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly turnStatus: string;
  readonly threadStatusType?: string;
  readonly itemType?: string;
  readonly isUserMessageItem: boolean;
}

export function normalizeCodexAppServerNotification(
  method: string,
  params: unknown
): CodexAppServerNotification {
  const payload = isRecord(params) ? params : {};
  const item = isRecord(payload.item) ? payload.item : undefined;
  const turn = isRecord(payload.turn) ? payload.turn : undefined;
  const status = isRecord(payload.status) ? payload.status : undefined;
  const itemType = stringValue(item?.type);

  return {
    method,
    lowerMethod: method.toLowerCase(),
    params: payload,
    threadId: extractThreadId(payload),
    turnId: extractTurnId(payload),
    turnStatus: stringValue(turn?.status) ?? stringValue(payload.status) ?? 'completed',
    threadStatusType: stringValue(status?.type),
    itemType,
    isUserMessageItem: itemType?.toLowerCase() === 'usermessage',
  };
}

export function extractCodexThreadId(params: unknown): string | undefined {
  return normalizeCodexAppServerNotification('', params).threadId;
}

export function extractCodexTurnId(params: unknown): string | undefined {
  return normalizeCodexAppServerNotification('', params).turnId;
}

function extractThreadId(payload: Record<string, unknown>): string | undefined {
  const directId = stringValue(payload.threadId) ?? stringValue(payload.thread_id);
  if (directId !== undefined) return directId;

  const thread = isRecord(payload.thread) ? payload.thread : undefined;
  const nestedThreadId =
    stringValue(thread?.threadId) ?? stringValue(thread?.thread_id) ?? stringValue(thread?.id);
  if (nestedThreadId !== undefined) return nestedThreadId;

  const turn = isRecord(payload.turn) ? payload.turn : undefined;
  const turnThreadId = stringValue(turn?.threadId) ?? stringValue(turn?.thread_id);
  if (turnThreadId !== undefined) return turnThreadId;

  const item = isRecord(payload.item) ? payload.item : undefined;
  return stringValue(item?.threadId) ?? stringValue(item?.thread_id);
}

function extractTurnId(payload: Record<string, unknown>): string | undefined {
  const turn = isRecord(payload.turn) ? payload.turn : undefined;
  if (turn !== undefined) {
    return stringValue(turn.id) ?? stringValue(turn.turnId) ?? stringValue(turn.turn_id);
  }
  return stringValue(payload.turnId) ?? stringValue(payload.turn_id) ?? stringValue(payload.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
