import { describe, expect, test } from 'vitest';

import { constantTimeEquals, hasValidBearerToken, isSecureTransport } from './security.js';

describe('webhooks/security', () => {
  test('constantTimeEquals matches equal strings', () => {
    expect(constantTimeEquals('abc123', 'abc123')).toBe(true);
  });

  test('constantTimeEquals rejects unequal length', () => {
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
  });

  test('hasValidBearerToken validates bearer token', () => {
    const request = new Request('https://example.com/internal/events', {
      headers: {
        authorization: 'Bearer shared-secret',
      },
    });

    expect(hasValidBearerToken(request, 'shared-secret')).toBe(true);
    expect(hasValidBearerToken(request, 'wrong-secret')).toBe(false);
  });

  test('isSecureTransport accepts https', () => {
    const request = new Request('https://api.example.com/internal/events');
    expect(isSecureTransport(request)).toBe(true);
  });

  test('isSecureTransport accepts trusted proxy https header', () => {
    const request = new Request('http://api.example.com/internal/events', {
      headers: {
        'x-forwarded-proto': 'https',
      },
    });
    expect(isSecureTransport(request)).toBe(true);
  });

  test('isSecureTransport accepts localhost for local dev', () => {
    const request = new Request('http://localhost:8787/internal/events');
    expect(isSecureTransport(request)).toBe(true);
  });
});
