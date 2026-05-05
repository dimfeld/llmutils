import { describe, expect, test } from 'vitest';
import { httpCatchUp } from './client.js';

describe('sync HTTP fallback client', () => {
  test('returns retryable failures for unreachable servers', async () => {
    const result = await httpCatchUp('http://127.0.0.1:9', 'token', 'persistent-a', 0);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toBeInstanceOf(Error);
    }
  });
});
