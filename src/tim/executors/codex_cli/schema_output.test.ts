import { describe, expect, test } from 'vitest';
import { validateJsonOutputAgainstSchema } from './schema_output.js';

describe('validateJsonOutputAgainstSchema', () => {
  const schema = {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string' },
    },
    additionalProperties: false,
  };

  test('accepts JSON that matches the schema', () => {
    expect(validateJsonOutputAgainstSchema('{"status":"ok"}', schema)).toEqual({ valid: true });
  });

  test('rejects output that is not JSON', () => {
    const result = validateJsonOutputAgainstSchema('not json', schema);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('not valid JSON');
  });

  test('rejects JSON that does not match the schema', () => {
    const result = validateJsonOutputAgainstSchema('{"status":404}', schema);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('must be string');
  });
});
