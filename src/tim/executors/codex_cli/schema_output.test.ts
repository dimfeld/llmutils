import { describe, expect, test } from 'vitest';
import {
  buildOutputSchemaConversionPrompt,
  buildOutputSchemaCorrectionPrompt,
  validateJsonOutputAgainstSchema,
} from './schema_output.js';

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

describe('buildOutputSchemaConversionPrompt', () => {
  test('includes schema and failed output without task-specific wording', () => {
    const prompt = buildOutputSchemaConversionPrompt({
      schema: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string' },
        },
        additionalProperties: false,
      },
      failedOutput: 'Status: ok',
      validationError: 'The final output is not valid JSON',
    });

    expect(prompt).toContain('"status"');
    expect(prompt).toContain('Status: ok');
    expect(prompt).toContain('The final output is not valid JSON');
    expect(prompt).toContain('Do not perform the original task again');
    expect(prompt).not.toContain('review');
    expect(prompt).not.toContain('finding');
    expect(prompt).not.toContain('issue');
  });
});

describe('buildOutputSchemaCorrectionPrompt', () => {
  test('includes the schema and validation error without repeating invalid output', () => {
    const prompt = buildOutputSchemaCorrectionPrompt(
      {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string' },
        },
        additionalProperties: false,
      },
      'The final output is not valid JSON'
    );

    expect(prompt).toContain('"required": [');
    expect(prompt).toContain('"status"');
    expect(prompt).toContain('The final output is not valid JSON');
    expect(prompt).toContain(
      'If the previous output was the intended output, then convert it to JSON'
    );
    expect(prompt).not.toContain('Previous invalid final output');
    expect(prompt).not.toContain('```');
  });
});
