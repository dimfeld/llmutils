import type { LlmStatusMessage, TokenUsageMessage } from '../../logging/structured_messages.js';

export type RateLimitProvider = 'claude' | 'codex';

export interface RateLimitEntry {
  provider: RateLimitProvider;
  label: string;
  usedPercent: number | null;
  belowThreshold: boolean;
  windowMinutes: number;
  resetsAtMs: number | null;
  updatedAt: string;
}

export interface RateLimitState {
  entries: RateLimitEntry[];
}

const RESETS_AT_TOLERANCE_MS = 30_000;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampPercent(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}

function claudeWindowFromType(rateLimitType?: string): { label: string; windowMinutes: number } {
  switch (rateLimitType) {
    case 'five_hour':
      return { label: '5-hour', windowMinutes: 300 };
    case 'seven_day':
      return { label: '7-day', windowMinutes: 10080 };
    default:
      return { label: rateLimitType ?? 'unknown', windowMinutes: 0 };
  }
}

function codexWindowLabel(windowMinutes: number): string {
  if (windowMinutes === 300) {
    return '5-hour';
  }
  if (windowMinutes === 10080) {
    return '7-day';
  }
  if (windowMinutes >= 60 && windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}-hour`;
  }
  return `${windowMinutes}-minute`;
}

function getMessageTimestampMs(messageTimestamp?: string): number {
  if (!messageTimestamp) {
    return Date.now();
  }

  const parsed = Date.parse(messageTimestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function codexResetsAtMs(resetsInSeconds: number | null, baseTimestampMs: number): number | null {
  if (resetsInSeconds == null) {
    return null;
  }
  return baseTimestampMs + resetsInSeconds * 1000;
}

export function extractClaudeRateLimit(message: LlmStatusMessage): RateLimitEntry[] | null {
  if (message.source !== 'claude' || !message.status.startsWith('Rate limit')) {
    return null;
  }

  const info = message.rateLimitInfo;
  if (!info) {
    return null;
  }

  const { label, windowMinutes } = claudeWindowFromType(info.rateLimitType);
  const utilization = toFiniteNumber(info.utilization);
  const resetsAt = toFiniteNumber(info.resetsAt);
  const timestampMs = getMessageTimestampMs(message.timestamp);

  if (label === 'unknown') {
    console.log('Unknown claude rate limit type', label, info);
  }

  return [
    {
      provider: 'claude',
      label,
      usedPercent: utilization == null ? null : clampPercent(utilization * 100),
      belowThreshold: utilization == null,
      windowMinutes,
      resetsAtMs: resetsAt == null ? null : resetsAt * 1000,
      updatedAt: new Date(timestampMs).toISOString(),
    },
  ];
}

function extractCodexWindow(
  value: unknown,
  timestampMs: number
): Omit<RateLimitEntry, 'provider' | 'updatedAt'> | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const usedPercent = toFiniteNumber(value.used_percent);
  const windowMinutes = toFiniteNumber(value.window_minutes);
  const resetsInSeconds = toFiniteNumber(value.resets_in_seconds);

  if (usedPercent == null || windowMinutes == null) {
    return null;
  }

  return {
    label: codexWindowLabel(windowMinutes),
    usedPercent: clampPercent(usedPercent),
    belowThreshold: false,
    windowMinutes,
    resetsAtMs: codexResetsAtMs(resetsInSeconds, timestampMs),
  };
}

export function extractCodexRateLimit(message: TokenUsageMessage): RateLimitEntry[] | null {
  if (!isObjectRecord(message.rateLimits)) {
    return null;
  }

  const timestampMs = getMessageTimestampMs(message.timestamp);
  const updatedAt = new Date(timestampMs).toISOString();
  const entries: RateLimitEntry[] = [];
  const primary = extractCodexWindow(message.rateLimits.primary, timestampMs);
  if (primary) {
    entries.push({ provider: 'codex', updatedAt, ...primary });
  }

  const secondary = extractCodexWindow(message.rateLimits.secondary, timestampMs);
  if (secondary) {
    entries.push({ provider: 'codex', updatedAt, ...secondary });
  }

  return entries.length > 0 ? entries : null;
}

export class RateLimitStore {
  private readonly entries = new Map<string, RateLimitEntry>();

  update(nextEntries: RateLimitEntry[]): boolean {
    let changed = false;

    for (const entry of nextEntries) {
      const key = `${entry.provider}:${entry.label}`;
      const previous = this.entries.get(key);

      // Monotonic guard: reject entries older than what we already have
      if (previous && entry.updatedAt < previous.updatedAt) {
        continue;
      }

      const entryChanged = !isRateLimitEntryEqual(previous, entry);
      this.entries.set(key, entry);
      if (entryChanged) {
        changed = true;
      }
    }

    return changed;
  }

  getState(): RateLimitState {
    this.pruneExpiredEntries();
    return {
      entries: Array.from(this.entries.values()).sort((a, b) => {
        const providerCmp = a.provider.localeCompare(b.provider);
        if (providerCmp !== 0) {
          return providerCmp;
        }
        return a.windowMinutes - b.windowMinutes;
      }),
    };
  }

  getWorstUsagePercent(): number | null {
    this.pruneExpiredEntries();
    let worst: number | null = null;
    for (const entry of this.entries.values()) {
      if (entry.belowThreshold || entry.usedPercent == null) {
        continue;
      }
      if (worst == null || entry.usedPercent > worst) {
        worst = entry.usedPercent;
      }
    }
    return worst;
  }

  private pruneExpiredEntries(nowMs = Date.now()): void {
    for (const [key, entry] of this.entries.entries()) {
      if (entry.resetsAtMs != null && entry.resetsAtMs <= nowMs) {
        this.entries.delete(key);
      }
    }
  }
}

function isRateLimitEntryEqual(a: RateLimitEntry | undefined, b: RateLimitEntry): boolean {
  if (!a) {
    return false;
  }

  const resetsMatch =
    a.resetsAtMs == null || b.resetsAtMs == null
      ? a.resetsAtMs === b.resetsAtMs
      : Math.abs(a.resetsAtMs - b.resetsAtMs) <= RESETS_AT_TOLERANCE_MS;

  return (
    a.provider === b.provider &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.belowThreshold === b.belowThreshold &&
    a.windowMinutes === b.windowMinutes &&
    resetsMatch
  );
}
