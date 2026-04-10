import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { LlmStatusMessage, TokenUsageMessage } from '../../logging/structured_messages.js';
import {
  RateLimitStore,
  extractClaudeRateLimit,
  extractCodexRateLimit,
} from './rate_limit_store.js';

describe('lib/server/rate_limit_store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('extractClaudeRateLimit', () => {
    test('extracts claude usage when utilization is present', () => {
      const message: LlmStatusMessage = {
        type: 'llm_status',
        timestamp: '2026-03-20T12:00:00.000Z',
        source: 'claude',
        status: 'Rate limit warning (seven_day)',
        rateLimitInfo: {
          utilization: 0.77,
          rateLimitType: 'seven_day',
          resetsAt: 1775000000,
        },
      };

      expect(extractClaudeRateLimit(message)).toEqual([
        {
          provider: 'claude',
          label: '7-day',
          usedPercent: 77,
          belowThreshold: false,
          windowMinutes: 10080,
          resetsAtMs: 1775000000000,
          updatedAt: '2026-03-20T12:00:00.000Z',
        },
      ]);
    });

    test('returns below-threshold entry when utilization is omitted', () => {
      const message: LlmStatusMessage = {
        type: 'llm_status',
        timestamp: '2026-03-20T12:00:00.000Z',
        source: 'claude',
        status: 'Rate limit (seven_day)',
        rateLimitInfo: {
          rateLimitType: 'seven_day',
          resetsAt: 1775000000,
        },
      };

      expect(extractClaudeRateLimit(message)).toEqual([
        {
          provider: 'claude',
          label: '7-day',
          usedPercent: null,
          belowThreshold: true,
          windowMinutes: 10080,
          resetsAtMs: 1775000000000,
          updatedAt: '2026-03-20T12:00:00.000Z',
        },
      ]);
    });

    test('returns null for non-rate-limit or malformed messages', () => {
      const notRateLimit: LlmStatusMessage = {
        type: 'llm_status',
        timestamp: '2026-03-20T12:00:00.000Z',
        source: 'claude',
        status: 'Compacting',
        rateLimitInfo: {
          utilization: 0.9,
          rateLimitType: 'seven_day',
        },
      };
      const noInfo: LlmStatusMessage = {
        type: 'llm_status',
        timestamp: '2026-03-20T12:00:00.000Z',
        source: 'claude',
        status: 'Rate limit warning (seven_day)',
      };
      const wrongSource: LlmStatusMessage = {
        type: 'llm_status',
        timestamp: '2026-03-20T12:00:00.000Z',
        source: 'codex',
        status: 'Rate limit warning',
        rateLimitInfo: {
          utilization: 0.8,
          rateLimitType: 'seven_day',
        },
      };

      expect(extractClaudeRateLimit(notRateLimit)).toBeNull();
      expect(extractClaudeRateLimit(noInfo)).toBeNull();
      expect(extractClaudeRateLimit(wrongSource)).toBeNull();
    });

    test('uses message timestamp for updatedAt and falls back to Date.now when timestamp is missing', () => {
      const withTimestamp: LlmStatusMessage = {
        type: 'llm_status',
        timestamp: '2026-03-20T12:34:56.000Z',
        source: 'claude',
        status: 'Rate limit warning (seven_day)',
        rateLimitInfo: {
          utilization: 0.77,
          rateLimitType: 'seven_day',
          resetsAt: 1775000000,
        },
      };
      const withoutTimestamp: LlmStatusMessage = {
        type: 'llm_status',
        source: 'claude',
        status: 'Rate limit warning (seven_day)',
        rateLimitInfo: {
          utilization: 0.5,
          rateLimitType: 'seven_day',
        },
      };

      expect(extractClaudeRateLimit(withTimestamp)?.[0]?.updatedAt).toBe(
        '2026-03-20T12:34:56.000Z'
      );
      expect(extractClaudeRateLimit(withoutTimestamp)?.[0]?.updatedAt).toBe(
        '2026-03-20T12:00:00.000Z'
      );
    });
  });

  describe('extractCodexRateLimit', () => {
    test('extracts primary and secondary rate limits', () => {
      const message: TokenUsageMessage = {
        type: 'token_usage',
        timestamp: '2026-03-20T12:00:00.000Z',
        rateLimits: {
          primary: {
            used_percent: 42,
            window_minutes: 300,
            resets_in_seconds: 600,
          },
          secondary: {
            used_percent: 15,
            window_minutes: 10080,
            resets_in_seconds: 7200,
          },
        },
      };

      expect(extractCodexRateLimit(message)).toEqual([
        {
          provider: 'codex',
          label: '5-hour',
          usedPercent: 42,
          belowThreshold: false,
          windowMinutes: 300,
          resetsAtMs: Date.parse('2026-03-20T12:10:00.000Z'),
          updatedAt: '2026-03-20T12:00:00.000Z',
        },
        {
          provider: 'codex',
          label: '7-day',
          usedPercent: 15,
          belowThreshold: false,
          windowMinutes: 10080,
          resetsAtMs: Date.parse('2026-03-20T14:00:00.000Z'),
          updatedAt: '2026-03-20T12:00:00.000Z',
        },
      ]);
    });

    test('extracts camelCase rate limits from the app-server formatter', () => {
      const message: TokenUsageMessage = {
        type: 'token_usage',
        timestamp: '2026-03-20T12:00:00.000Z',
        rateLimits: {
          codex: {
            limitId: 'codex',
            primary: {
              usedPercent: 42,
              windowDurationMins: 300,
              resetsAt: 1771665600,
            },
            secondary: {
              usedPercent: 15,
              windowDurationMins: 10080,
              resetsInSeconds: 7200,
            },
          },
        },
      };

      expect(extractCodexRateLimit(message)).toEqual([
        expect.objectContaining({
          provider: 'codex',
          label: '5-hour',
          usedPercent: 42,
          windowMinutes: 300,
          resetsAtMs: 1771665600000,
        }),
        expect.objectContaining({
          provider: 'codex',
          label: '7-day',
          usedPercent: 15,
          windowMinutes: 10080,
          resetsAtMs: Date.parse('2026-03-20T14:00:00.000Z'),
        }),
      ]);
    });

    test('returns null for missing or invalid rate limit fields', () => {
      const noRateLimits: TokenUsageMessage = {
        type: 'token_usage',
        timestamp: '2026-03-20T12:00:00.000Z',
      };
      const invalidRateLimits: TokenUsageMessage = {
        type: 'token_usage',
        timestamp: '2026-03-20T12:00:00.000Z',
        rateLimits: {
          primary: {
            used_percent: '42',
            window_minutes: 300,
          },
        },
      };

      expect(extractCodexRateLimit(noRateLimits)).toBeNull();
      expect(extractCodexRateLimit(invalidRateLimits)).toBeNull();
    });

    test('anchors updatedAt and resetsAtMs to message timestamp, with Date.now fallback', () => {
      const withTimestamp: TokenUsageMessage = {
        type: 'token_usage',
        timestamp: '2026-03-20T12:05:00.000Z',
        rateLimits: {
          primary: {
            used_percent: 42,
            window_minutes: 300,
            resets_in_seconds: 600,
          },
        },
      };
      const withoutTimestamp: TokenUsageMessage = {
        type: 'token_usage',
        rateLimits: {
          primary: {
            used_percent: 11,
            window_minutes: 300,
            resets_in_seconds: 120,
          },
        },
      };

      expect(extractCodexRateLimit(withTimestamp)).toEqual([
        expect.objectContaining({
          updatedAt: '2026-03-20T12:05:00.000Z',
          resetsAtMs: Date.parse('2026-03-20T12:15:00.000Z'),
        }),
      ]);
      expect(extractCodexRateLimit(withoutTimestamp)).toEqual([
        expect.objectContaining({
          updatedAt: '2026-03-20T12:00:00.000Z',
          resetsAtMs: Date.parse('2026-03-20T12:02:00.000Z'),
        }),
      ]);
    });
  });

  describe('RateLimitStore', () => {
    test('update returns true for changes and false for semantically identical fresh entries', () => {
      const store = new RateLimitStore();
      const message: TokenUsageMessage = {
        type: 'token_usage',
        timestamp: '2026-03-20T12:00:00.000Z',
        rateLimits: {
          primary: {
            used_percent: 42,
            window_minutes: 300,
            resets_in_seconds: 600,
          },
        },
      };
      const first = extractCodexRateLimit(message);
      const second = extractCodexRateLimit(message);

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first?.[0]).not.toBe(second?.[0]);
      expect(store.update(first ?? [])).toBe(true);
      expect(store.update(second ?? [])).toBe(false);
      expect(
        store.update([
          {
            ...(first?.[0] as NonNullable<typeof first>[number]),
            usedPercent: 43,
          },
        ])
      ).toBe(true);
    });

    test('treats resetsAtMs within 30 seconds as equal and over 30 seconds as changed', () => {
      const store = new RateLimitStore();
      const base = {
        provider: 'codex' as const,
        label: '5-hour',
        usedPercent: 42,
        belowThreshold: false,
        windowMinutes: 300,
        resetsAtMs: Date.parse('2026-03-20T14:00:00.000Z'),
        updatedAt: '2026-03-20T12:00:00.000Z',
      };

      expect(store.update([base])).toBe(true);
      expect(
        store.update([
          {
            ...base,
            updatedAt: '2026-03-20T12:01:00.000Z',
            resetsAtMs: Date.parse('2026-03-20T14:00:29.000Z'),
          },
        ])
      ).toBe(false);
      expect(
        store.update([
          {
            ...base,
            updatedAt: '2026-03-20T12:02:00.000Z',
            resetsAtMs: Date.parse('2026-03-20T14:01:00.000Z'),
          },
        ])
      ).toBe(true);
    });

    test('getState prunes expired entries', () => {
      const store = new RateLimitStore();
      store.update([
        {
          provider: 'claude',
          label: '7-day',
          usedPercent: 77,
          belowThreshold: false,
          windowMinutes: 10080,
          resetsAtMs: Date.parse('2026-03-20T12:10:00.000Z'),
          updatedAt: '2026-03-20T12:00:00.000Z',
        },
        {
          provider: 'codex',
          label: '5-hour',
          usedPercent: 15,
          belowThreshold: false,
          windowMinutes: 300,
          resetsAtMs: Date.parse('2026-03-20T11:59:00.000Z'),
          updatedAt: '2026-03-20T12:00:00.000Z',
        },
      ]);

      expect(store.getState().entries).toEqual([
        expect.objectContaining({
          provider: 'claude',
          label: '7-day',
        }),
      ]);
    });

    test('getWorstUsagePercent ignores below-threshold entries', () => {
      const store = new RateLimitStore();
      store.update([
        {
          provider: 'claude',
          label: '7-day',
          usedPercent: null,
          belowThreshold: true,
          windowMinutes: 10080,
          resetsAtMs: Date.parse('2026-03-21T12:00:00.000Z'),
          updatedAt: '2026-03-20T12:00:00.000Z',
        },
        {
          provider: 'codex',
          label: '5-hour',
          usedPercent: 91,
          belowThreshold: false,
          windowMinutes: 300,
          resetsAtMs: Date.parse('2026-03-20T13:00:00.000Z'),
          updatedAt: '2026-03-20T12:00:00.000Z',
        },
      ]);

      expect(store.getWorstUsagePercent()).toBe(91);
    });

    test('rejects older entries and keeps newer state (monotonic guard)', () => {
      const store = new RateLimitStore();
      const newerEntry = {
        provider: 'codex' as const,
        label: '5-hour',
        usedPercent: 90,
        belowThreshold: false,
        windowMinutes: 300,
        resetsAtMs: Date.parse('2026-03-20T14:00:00.000Z'),
        updatedAt: '2026-03-20T12:05:00.000Z',
      };
      const olderEntry = {
        ...newerEntry,
        usedPercent: 40,
        updatedAt: '2026-03-20T12:00:00.000Z',
      };

      expect(store.update([newerEntry])).toBe(true);
      // Older entry should be rejected
      expect(store.update([olderEntry])).toBe(false);
      // State should still reflect the newer entry
      expect(store.getState().entries[0].usedPercent).toBe(90);
    });

    test('getWorstUsagePercent returns null when only below-threshold or expired entries exist', () => {
      const store = new RateLimitStore();
      store.update([
        {
          provider: 'claude',
          label: '7-day',
          usedPercent: null,
          belowThreshold: true,
          windowMinutes: 10080,
          resetsAtMs: Date.parse('2026-03-21T12:00:00.000Z'),
          updatedAt: '2026-03-20T12:00:00.000Z',
        },
        {
          provider: 'codex',
          label: '5-hour',
          usedPercent: 95,
          belowThreshold: false,
          windowMinutes: 300,
          resetsAtMs: Date.parse('2026-03-20T11:00:00.000Z'),
          updatedAt: '2026-03-20T12:00:00.000Z',
        },
      ]);

      expect(store.getWorstUsagePercent()).toBeNull();
    });
  });
});
