import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { hashToken, verifyNodeToken } from './auth.js';

describe('sync node authentication', () => {
  let originalEnvToken: string | undefined;

  beforeEach(() => {
    originalEnvToken = process.env.TIM_ALLOWED_NODE_TOKEN;
  });

  afterEach(() => {
    if (originalEnvToken === undefined) {
      delete process.env.TIM_ALLOWED_NODE_TOKEN;
    } else {
      process.env.TIM_ALLOWED_NODE_TOKEN = originalEnvToken;
    }
  });

  test('hashToken returns lowercase sha256 hex', () => {
    expect(hashToken('secret')).toBe(
      '2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b'
    );
  });

  test('accepts valid token via tokenHash', () => {
    const result = verifyNodeToken({
      nodeId: 'node-a',
      presentedToken: 'secret',
      allowedNodes: [
        {
          nodeId: 'node-a',
          label: 'Laptop',
          tokenHash: hashToken('secret'),
        },
      ],
    });

    expect(result).toEqual({ ok: true, label: 'Laptop' });
  });

  test('accepts valid token via tokenEnv', () => {
    process.env.TIM_ALLOWED_NODE_TOKEN = 'env-secret';
    const result = verifyNodeToken({
      nodeId: 'node-a',
      presentedToken: 'env-secret',
      allowedNodes: [
        {
          nodeId: 'node-a',
          tokenEnv: 'TIM_ALLOWED_NODE_TOKEN',
        },
      ],
    });

    expect(result).toEqual({ ok: true });
  });

  test('rejects unknown nodeId', () => {
    const result = verifyNodeToken({
      nodeId: 'unknown',
      presentedToken: 'secret',
      allowedNodes: [{ nodeId: 'node-a', tokenHash: hashToken('secret') }],
    });

    expect(result).toEqual({ ok: false, reason: 'unknown_node' });
  });

  test('rejects wrong token', () => {
    const result = verifyNodeToken({
      nodeId: 'node-a',
      presentedToken: 'wrong',
      allowedNodes: [{ nodeId: 'node-a', tokenHash: hashToken('secret') }],
    });

    expect(result).toEqual({ ok: false, reason: 'token_mismatch' });
  });

  test('rejects when tokenEnv is unset', () => {
    delete process.env.TIM_ALLOWED_NODE_TOKEN;
    const result = verifyNodeToken({
      nodeId: 'node-a',
      presentedToken: 'secret',
      allowedNodes: [{ nodeId: 'node-a', tokenEnv: 'TIM_ALLOWED_NODE_TOKEN' }],
    });

    expect(result).toEqual({ ok: false, reason: 'missing_token_env' });
  });

  test('rejects missing presented token (null)', () => {
    const result = verifyNodeToken({
      nodeId: 'node-a',
      presentedToken: null,
      allowedNodes: [{ nodeId: 'node-a', tokenHash: hashToken('secret') }],
    });

    expect(result).toEqual({ ok: false, reason: 'missing_token' });
  });

  test('rejects empty string presented token', () => {
    const result = verifyNodeToken({
      nodeId: 'node-a',
      presentedToken: '',
      allowedNodes: [{ nodeId: 'node-a', tokenHash: hashToken('secret') }],
    });

    expect(result).toEqual({ ok: false, reason: 'missing_token' });
  });

  test('rejects undefined presented token', () => {
    const result = verifyNodeToken({
      nodeId: 'node-a',
      presentedToken: undefined,
      allowedNodes: [{ nodeId: 'node-a', tokenHash: hashToken('secret') }],
    });

    expect(result).toEqual({ ok: false, reason: 'missing_token' });
  });

  test('does not crash when stored tokenHash length differs from presented hash (truncated hash)', () => {
    const result = verifyNodeToken({
      nodeId: 'node-a',
      presentedToken: 'secret',
      allowedNodes: [
        {
          nodeId: 'node-a',
          // Truncated hash (16 chars instead of 64) - simulates a corrupted entry
          tokenHash: hashToken('secret').slice(0, 16) as string & { length: 64 },
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe('token_mismatch');
  });

  test('returns ok without label when allowedNode has no label', () => {
    const result = verifyNodeToken({
      nodeId: 'node-a',
      presentedToken: 'secret',
      allowedNodes: [{ nodeId: 'node-a', tokenHash: hashToken('secret') }],
    });

    expect(result).toEqual({ ok: true });
    expect((result as { ok: true; label?: string }).label).toBeUndefined();
  });

  test('hashToken output is always lowercase hex', () => {
    const hash = hashToken('MixedCase TOKEN 123!');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
