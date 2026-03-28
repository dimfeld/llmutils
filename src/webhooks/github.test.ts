import { describe, expect, test } from 'bun:test';

import { computeGitHubSignature, isValidGitHubSignature } from './github.js';

describe('webhooks/github signature verification', () => {
  test('computes expected sha256 signature format', () => {
    const signature = computeGitHubSignature('{"hello":"world"}', 'top-secret');
    expect(signature.startsWith('sha256=')).toBe(true);
  });

  test('validates correct signature', () => {
    const payload = JSON.stringify({ action: 'opened' });
    const signature = computeGitHubSignature(payload, 'top-secret');

    expect(isValidGitHubSignature(payload, 'top-secret', signature)).toBe(true);
  });

  test('rejects incorrect signature', () => {
    const payload = JSON.stringify({ action: 'opened' });
    const signature = computeGitHubSignature(payload, 'different-secret');

    expect(isValidGitHubSignature(payload, 'top-secret', signature)).toBe(false);
  });
});
