import { describe, expect, test } from 'vitest';

import {
  computePathSignature,
  constantTimeEquals,
  hasValidBearerToken,
  isValidPathSignature,
} from './security.js';

describe('media-host/security', () => {
  test('constantTimeEquals matches equal strings', () => {
    expect(constantTimeEquals('abc123', 'abc123')).toBe(true);
  });

  test('constantTimeEquals rejects differing values and lengths', () => {
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
  });

  test('hasValidBearerToken validates the bearer token', () => {
    const request = new Request('https://example.com/foo.png', {
      headers: { authorization: 'Bearer shared-secret' },
    });

    expect(hasValidBearerToken(request, 'shared-secret')).toBe(true);
    expect(hasValidBearerToken(request, 'wrong-secret')).toBe(false);
  });

  test('hasValidBearerToken rejects missing or malformed headers', () => {
    expect(hasValidBearerToken(new Request('https://example.com/foo.png'), 'secret')).toBe(false);

    const basic = new Request('https://example.com/foo.png', {
      headers: { authorization: 'Basic shared-secret' },
    });
    expect(hasValidBearerToken(basic, 'shared-secret')).toBe(false);
  });

  test('computePathSignature is deterministic and salted by the secret', () => {
    const a = computePathSignature('images/cat.png', 'salt-one');
    const b = computePathSignature('images/cat.png', 'salt-one');
    const c = computePathSignature('images/cat.png', 'salt-two');

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('computePathSignature differs per path', () => {
    const secret = 'salt';
    expect(computePathSignature('a/cat.png', secret)).not.toBe(
      computePathSignature('b/cat.png', secret)
    );
  });

  test('isValidPathSignature accepts the matching signature only', () => {
    const secret = 'salt';
    const path = 'videos/clip.mp4';
    const signature = computePathSignature(path, secret);

    expect(isValidPathSignature(path, secret, signature)).toBe(true);
    expect(isValidPathSignature(path, secret, signature.replace(/.$/, '0'))).toBe(false);
    // A signature for a different path must not grant access to this one.
    expect(
      isValidPathSignature(path, secret, computePathSignature('videos/other.mp4', secret))
    ).toBe(false);
  });

  test('isValidPathSignature rejects missing signatures', () => {
    expect(isValidPathSignature('a.png', 'salt', null)).toBe(false);
    expect(isValidPathSignature('a.png', 'salt', undefined)).toBe(false);
    expect(isValidPathSignature('a.png', 'salt', '')).toBe(false);
  });
});
