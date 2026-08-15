import { describe, expect, test } from 'vitest';

import {
  CODEX_DYNAMIC_TOOL_NAME_MAX_LENGTH,
  codexDynamicToolCallItemSchema,
  codexDynamicToolCallParamsSchema,
  codexDynamicToolCallResultSchema,
  codexDynamicToolContentItemSchema,
  createCodexDynamicToolFailureResult,
  createCodexDynamicToolSuccessResult,
  createCodexDynamicToolTextResult,
  parseCodexDynamicToolCallParams,
  parseCodexDynamicToolContentItem,
  serializeCodexDynamicToolResult,
  validateCodexDynamicToolDefinitions,
  validateCodexDynamicToolProvider,
  type CodexDynamicToolProvider,
} from './app_server_dynamic_tools.js';

const functionDefinition = {
  type: 'function' as const,
  name: 'ListAgents',
  description: 'List active agents.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  futureField: { enabled: true },
};

describe('Codex dynamic-tool transport contracts', () => {
  test('accepts top-level and namespace definitions while preserving unknown fields', () => {
    const namespace = {
      type: 'namespace' as const,
      name: 'tim',
      description: 'Tim tools.',
      tools: [
        {
          ...functionDefinition,
          name: 'ListNamespacedAgents',
        },
      ],
      futureNamespaceField: 'kept',
    };

    validateCodexDynamicToolDefinitions([functionDefinition, namespace]);
    expect(namespace.futureNamespaceField).toBe('kept');
  });

  test.each([
    ['empty definitions', []],
    ['duplicate names', [functionDefinition, functionDefinition]],
    ['invalid name characters', [{ ...functionDefinition, name: 'List Agents' }]],
    [
      'name too long',
      [{ ...functionDefinition, name: 'a'.repeat(CODEX_DYNAMIC_TOOL_NAME_MAX_LENGTH + 1) }],
    ],
    ['non-object input schema', [{ ...functionDefinition, inputSchema: [] }]],
    ['empty namespace tools', [{ type: 'namespace', name: 'tim', description: 'Tim', tools: [] }]],
  ])('rejects %s', (_label, definitions) => {
    expect(() => validateCodexDynamicToolDefinitions(definitions)).toThrow();
  });

  test('parses required call fields with omitted and null namespaces', () => {
    const omitted = parseCodexDynamicToolCallParams({
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      tool: 'ListAgents',
      arguments: {},
      futureField: { retained: true },
    });
    expect(omitted.namespace).toBeUndefined();
    expect(omitted.futureField).toEqual({ retained: true });

    expect(
      parseCodexDynamicToolCallParams({
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: null,
        tool: 'ListAgents',
        arguments: null,
      }).namespace
    ).toBeNull();
  });

  test.each([
    ['missing thread ID', { turnId: 'turn', callId: 'call', tool: 'ListAgents', arguments: {} }],
    ['missing turn ID', { threadId: 'thread', callId: 'call', tool: 'ListAgents', arguments: {} }],
    ['missing call ID', { threadId: 'thread', turnId: 'turn', tool: 'ListAgents', arguments: {} }],
    ['missing tool', { threadId: 'thread', turnId: 'turn', callId: 'call', arguments: {} }],
    [
      'missing arguments',
      { threadId: 'thread', turnId: 'turn', callId: 'call', tool: 'ListAgents' },
    ],
    [
      'invalid namespace',
      {
        threadId: 'thread',
        turnId: 'turn',
        callId: 'call',
        namespace: 42,
        tool: 'ListAgents',
        arguments: {},
      },
    ],
    [
      'non-JSON arguments',
      {
        threadId: 'thread',
        turnId: 'turn',
        callId: 'call',
        tool: 'ListAgents',
        arguments: BigInt(1),
      },
    ],
  ])('rejects %s in call envelopes', (_label, params) => {
    expect(codexDynamicToolCallParamsSchema.safeParse(params).success).toBe(false);
    expect(() => parseCodexDynamicToolCallParams(params)).toThrow();
  });

  test('accepts documented and future content item variants', () => {
    expect(parseCodexDynamicToolContentItem({ type: 'inputText', text: 'done' })).toEqual({
      type: 'inputText',
      text: 'done',
    });
    expect(
      parseCodexDynamicToolContentItem({ type: 'inputImage', imageUrl: 'data:image/png' })
    ).toEqual({
      type: 'inputImage',
      imageUrl: 'data:image/png',
    });
    expect(
      parseCodexDynamicToolContentItem({ type: 'inputAudio', audioUrl: 'data:audio/wav' })
    ).toEqual({
      type: 'inputAudio',
      audioUrl: 'data:audio/wav',
    });
    expect(parseCodexDynamicToolContentItem({ type: 'futureContent', value: 1 })).toEqual({
      type: 'futureContent',
      value: 1,
    });
    expect(codexDynamicToolContentItemSchema.safeParse({ type: 'inputText' }).success).toBe(false);
    expect(
      codexDynamicToolContentItemSchema.safeParse({ type: 'inputImage', imageUrl: 4 }).success
    ).toBe(false);
  });

  test('parses tolerant results and dynamicToolCall items', () => {
    const result = codexDynamicToolCallResultSchema.parse({
      contentItems: [{ type: 'inputText', text: 'ok', future: true }],
      success: true,
      futureResultField: 'kept',
    });
    expect(result).toMatchObject({ success: true, futureResultField: 'kept' });

    const item = codexDynamicToolCallItemSchema.parse({
      type: 'dynamicToolCall',
      id: 'item-1',
      namespace: null,
      tool: 'ListAgents',
      arguments: {},
      status: 'futureStatus',
      contentItems: null,
      success: null,
      futureItemField: 'kept',
    });
    expect(item).toMatchObject({ status: 'futureStatus', futureItemField: 'kept' });
  });

  test('validates provider cohesion and trusted caller context', () => {
    const validProvider: CodexDynamicToolProvider = {
      caller: {
        id: 'root-id' as never,
        name: 'orchestrator' as never,
        role: 'orchestrator',
        executor: 'codex-cli',
      },
      definitions: [functionDefinition],
      handler: async () => ({ contentItems: [{ type: 'inputText', text: 'ok' }], success: true }),
    };
    expect(() => validateCodexDynamicToolProvider(validProvider)).not.toThrow();

    expect(() => validateCodexDynamicToolProvider({ ...validProvider, definitions: [] })).toThrow(
      'nonempty'
    );
    expect(() =>
      validateCodexDynamicToolProvider({ ...validProvider, handler: undefined })
    ).toThrow('callable');
    expect(() =>
      validateCodexDynamicToolProvider({
        ...validProvider,
        caller: { ...validProvider.caller, name: 'worker' },
      })
    ).toThrow('orchestrator caller identity');
  });

  test('serializes results deterministically and safely', () => {
    const circular: Record<string, unknown> = { z: undefined, a: 1, fn: () => undefined };
    circular.self = circular;
    expect(serializeCodexDynamicToolResult(circular)).toBe(
      '{"a":1,"fn":null,"self":"[Circular]","z":null}'
    );
    expect(serializeCodexDynamicToolResult({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');

    const success = createCodexDynamicToolSuccessResult({ ok: true });
    const failure = createCodexDynamicToolFailureResult('Bad request');
    const fallback = createCodexDynamicToolTextResult(false, '');
    for (const result of [success, failure, fallback]) {
      expect(result.success).toBeTypeOf('boolean');
      expect(result.contentItems.length).toBeGreaterThan(0);
      expect(result.contentItems[0]?.type).toBe('inputText');
    }
    expect(failure.contentItems[0]).toEqual({ type: 'inputText', text: 'Bad request' });
    expect(fallback.contentItems[0]).toEqual({
      type: 'inputText',
      text: 'The agent tool request failed.',
    });
  });
});
