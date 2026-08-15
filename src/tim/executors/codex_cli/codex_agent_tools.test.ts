import { describe, expect, test, vi } from 'vitest';
import * as z from 'zod/v4';

import {
  AgentManagerError,
  type AgentIdentity,
} from '../../agent_messaging/agent_manager_types.js';
import {
  CODEX_ORCHESTRATOR_TOOL_NAMES,
  CODEX_SUBAGENT_TOOL_NAMES,
  CODEX_AGENT_ARGUMENT_SCHEMAS,
  createCodexAgentToolProvider,
  getCodexAgentToolNames,
  validateCodexAgentToolProvider,
  type CodexAgentToolContext,
  type CodexAgentToolName,
} from './codex_agent_tools.js';

function identity(role: AgentIdentity['role']): AgentIdentity {
  return role === 'orchestrator'
    ? {
        id: 'root-id' as never,
        name: 'orchestrator' as never,
        role: 'orchestrator',
        executor: 'codex-cli',
      }
    : {
        id: 'worker-id' as never,
        name: 'worker-a' as never,
        role: 'subagent',
        type: 'tester',
        executor: 'codex-cli',
      };
}

function createContext(role: AgentIdentity['role']): {
  readonly context: CodexAgentToolContext;
  readonly calls: Record<string, ReturnType<typeof vi.fn>>;
} {
  const calls = {
    startAgent: vi.fn(async () => ({
      name: 'worker-b',
      id: 'worker-b-id',
      type: 'tester',
      executor: 'codex-cli',
      state: 'starting',
    })),
    listAgents: vi.fn(async () => ({ agents: [] })),
    sendAgentMessage: vi.fn(async () => ({
      name: 'worker-a',
      messageId: 'message-id',
      delivery: 'steered',
    })),
    stopAgent: vi.fn(async () => ({ name: 'worker-a', mode: 'forced', state: 'stopping' })),
    finishAgent: vi.fn(async () => ({ state: 'finishing' })),
  };
  return {
    context: { caller: identity(role), dispatcher: calls },
    calls,
  };
}

function call(tool: CodexAgentToolName, args: unknown): Record<string, unknown> {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    callId: `call-${tool}`,
    tool,
    arguments: args,
  };
}

const validArguments: Record<CodexAgentToolName, unknown> = {
  StartAgent: {
    type: 'tester',
    executor: 'codex-cli',
    initialMessage: 'Run the tests.',
  },
  ListAgents: {},
  SendAgentMessage: { name: 'orchestrator', message: 'The tests are ready.' },
  StopAgent: { name: 'worker-a' },
  FinishAgent: { message: 'Done.' },
};

describe('Codex role-bound agent tool provider', () => {
  test.each([
    ['orchestrator', CODEX_ORCHESTRATOR_TOOL_NAMES, ['FinishAgent']],
    ['subagent', CODEX_SUBAGENT_TOOL_NAMES, ['StartAgent', 'StopAgent']],
  ] as const)('advertises the exact %s role tool set', (role, expected, forbidden) => {
    const { context } = createContext(role);
    const provider = createCodexAgentToolProvider(context);
    expect(provider.definitions.map((definition) => definition.name)).toEqual(expected);
    expect(getCodexAgentToolNames(role)).toEqual(expected);
    expect(provider.definitions.every((definition) => definition.type === 'function')).toBe(true);
    expect(provider.definitions.map((definition) => definition.name)).not.toEqual(
      expect.arrayContaining(forbidden)
    );
    expect(provider.definitions[0]?.inputSchema).toMatchObject({ type: 'object' });
    for (const definition of provider.definitions) {
      expect(definition.inputSchema.additionalProperties).toBe(false);
    }
    expect(() => validateCodexAgentToolProvider(provider)).not.toThrow();

    for (const definition of provider.definitions) {
      const schema = CODEX_AGENT_ARGUMENT_SCHEMAS[definition.name];
      expect(definition.inputSchema).toEqual(
        z.toJSONSchema(schema, { target: 'draft-7', io: 'input' })
      );
    }
  });

  test.each([
    ['orchestrator', CODEX_ORCHESTRATOR_TOOL_NAMES],
    ['subagent', CODEX_SUBAGENT_TOOL_NAMES],
  ] as const)('dispatches each authorized %s tool with trusted identity', async (role, allowed) => {
    const { context, calls } = createContext(role);
    const provider = createCodexAgentToolProvider(context);
    for (const toolName of allowed) {
      const result = await provider.handler(call(toolName, validArguments[toolName]));
      expect(result.success).toBe(true);
      expect(result.contentItems).toHaveLength(1);
      expect(result.contentItems[0]?.type).toBe('inputText');
    }

    const caller = { id: context.caller.id, role: context.caller.role };
    expect(calls.listAgents).toHaveBeenCalledWith(caller);
    if (role === 'orchestrator') {
      expect(calls.startAgent).toHaveBeenCalledWith(caller, validArguments.StartAgent);
      expect(calls.sendAgentMessage).toHaveBeenCalledWith(caller, validArguments.SendAgentMessage);
      expect(calls.stopAgent).toHaveBeenCalledWith(caller, validArguments.StopAgent);
    } else {
      expect(calls.sendAgentMessage).toHaveBeenCalledWith(caller, validArguments.SendAgentMessage);
      expect(calls.finishAgent).toHaveBeenCalledWith(caller, validArguments.FinishAgent);
    }
  });

  test.each([
    ['orchestrator', 'FinishAgent', { message: 'not allowed' }],
    ['subagent', 'StartAgent', validArguments.StartAgent],
    ['subagent', 'StopAgent', validArguments.StopAgent],
  ] as const)('rejects fabricated %s call to %s before dispatch', async (role, toolName, args) => {
    const { context, calls } = createContext(role);
    const provider = createCodexAgentToolProvider(context);
    const result = await provider.handler(call(toolName, args));
    expect(result).toEqual({
      contentItems: [
        {
          type: 'inputText',
          text: `Agent tool ${toolName} is not allowed for ${role} callers.`,
        },
      ],
      success: false,
    });
    expect(Object.values(calls).every((mock) => mock.mock.calls.length === 0)).toBe(true);
  });

  test('rejects unknown tools, namespaces, malformed arguments, and spoofing fields', async () => {
    const { context, calls } = createContext('subagent');
    const provider = createCodexAgentToolProvider(context);

    const cases = [
      [
        { ...call('ListAgents', {}), tool: 'UnknownTool' },
        undefined,
        'Unknown agent tool UnknownTool.',
      ],
      [{ ...call('ListAgents', {}), namespace: 'tim' }, undefined, 'does not accept namespace tim'],
      [
        call('SendAgentMessage', { name: 'orchestrator', message: 'hello', source: 'forged' }),
        undefined,
        'source is not accepted',
      ],
      [call('FinishAgent', { target: 'worker-a' }), undefined, 'does not accept a target'],
      [
        call('SendAgentMessage', { name: 'orchestrator', message: 'hello', callerId: 'forged' }),
        undefined,
        'invalid',
      ],
    ] as const;

    for (const [params, _unused, expectedText] of cases) {
      const result = await provider.handler(params);
      expect(result.success).toBe(false);
      expect(result.contentItems[0]?.text).toContain(expectedText);
    }
    expect(calls.sendAgentMessage).not.toHaveBeenCalled();
    expect(calls.finishAgent).not.toHaveBeenCalled();
  });

  test('rejects every malformed envelope before dispatch', async () => {
    const { context, calls } = createContext('orchestrator');
    const provider = createCodexAgentToolProvider(context);
    const malformedCalls: unknown[] = [
      null,
      {},
      { ...call('ListAgents', {}), threadId: '' },
      { ...call('ListAgents', {}), turnId: '' },
      { ...call('ListAgents', {}), callId: '' },
      { ...call('ListAgents', {}), tool: '' },
      { ...call('ListAgents', {}), namespace: 1 },
      { ...call('ListAgents', {}), arguments: undefined },
      { ...call('ListAgents', {}), arguments: () => undefined },
      { ...call('ListAgents', {}), arguments: { self: undefined } },
    ];

    for (const params of malformedCalls) {
      const result = await provider.handler(params);
      expect(result.success).toBe(false);
      expect(result.contentItems).toHaveLength(1);
      expect(result.contentItems[0]?.type).toBe('inputText');
      expect(result.contentItems[0]?.text).not.toContain('ZodError');
    }
    expect(Object.values(calls).every((mock) => mock.mock.calls.length === 0)).toBe(true);
  });

  test('accepts the UTF-8 message limit and rejects the next byte', async () => {
    const { context, calls } = createContext('subagent');
    const provider = createCodexAgentToolProvider(context);
    const atLimit = '🙂'.repeat(16_384);
    const overLimit = `${atLimit}a`;

    const accepted = await provider.handler(
      call('SendAgentMessage', { name: 'orchestrator', message: atLimit })
    );
    expect(accepted.success).toBe(true);
    expect(calls.sendAgentMessage).toHaveBeenCalledTimes(1);

    const rejected = await provider.handler(
      call('SendAgentMessage', { name: 'orchestrator', message: overLimit })
    );
    expect(rejected.success).toBe(false);
    expect(rejected.contentItems[0]?.text).toContain('invalid');
    expect(calls.sendAgentMessage).toHaveBeenCalledTimes(1);
  });

  test('accepts an empty namespace as top-level compatibility syntax', async () => {
    const { context } = createContext('subagent');
    const provider = createCodexAgentToolProvider(context);
    const result = await provider.handler({ ...call('ListAgents', {}), namespace: '' });
    expect(result.success).toBe(true);
  });

  test('returns safe manager failures and a bounded generic unexpected failure', async () => {
    const { context, calls } = createContext('orchestrator');
    calls.sendAgentMessage.mockRejectedValueOnce(
      new AgentManagerError('unknown_target', 'Unknown or inactive target agent: worker-a')
    );
    calls.stopAgent.mockRejectedValueOnce(
      new Error('secret stack /private/session/socket-path and environment-value')
    );
    calls.startAgent.mockRejectedValueOnce(
      new AgentManagerError('launch_failed', 'provider socket /private/session/socket-path')
    );
    const provider = createCodexAgentToolProvider(context);

    const expectedFailure = await provider.handler(
      call('SendAgentMessage', validArguments.SendAgentMessage)
    );
    expect(expectedFailure).toMatchObject({ success: false });
    expect(expectedFailure.contentItems[0]?.text).toContain('Unknown or inactive target agent');
    expect(expectedFailure.contentItems[0]?.text).not.toContain('stack');

    calls.sendAgentMessage.mockRejectedValueOnce(
      new AgentManagerError(
        'unknown_target',
        'secret stack /private/session/socket-path trusted-caller-id'
      )
    );
    const leakedManagerFailure = await provider.handler(
      call('SendAgentMessage', validArguments.SendAgentMessage)
    );
    expect(leakedManagerFailure.success).toBe(false);
    expect(leakedManagerFailure.contentItems[0]?.text).not.toContain('secret stack');
    expect(leakedManagerFailure.contentItems[0]?.text).not.toContain('/private/session');
    expect(leakedManagerFailure.contentItems[0]?.text).not.toContain('trusted-caller-id');

    const unexpectedFailure = await provider.handler(call('StopAgent', validArguments.StopAgent));
    expect(unexpectedFailure).toEqual({
      contentItems: [
        {
          type: 'inputText',
          text: 'Agent tool StopAgent failed unexpectedly. Try the request again.',
        },
      ],
      success: false,
    });
    expect(unexpectedFailure.contentItems[0]?.text).not.toContain('/private/session');

    const launchFailure = await provider.handler(call('StartAgent', validArguments.StartAgent));
    expect(launchFailure.contentItems[0]).toEqual({
      type: 'inputText',
      text: 'Agent tool StartAgent could not complete the request.',
    });
  });

  test.each([
    'invalid_options',
    'invalid_request',
    'manager_closed',
    'not_authorized',
    'invalid_name',
    'reserved_name',
    'name_in_use',
    'name_generation_exhausted',
    'identity_generation_exhausted',
    'agent_limit_reached',
    'launch_failed',
    'unknown_sender',
    'unknown_target',
    'target_not_accepting_messages',
    'transport_error',
    'root_registration_failed',
    'unknown_agent',
    'finish_not_available',
    'force_failed',
  ] as const)('keeps %s manager failures model-safe', async (code) => {
    const { context, calls } = createContext('subagent');
    calls.listAgents.mockRejectedValueOnce(
      new AgentManagerError(
        code,
        'SECRET /private/session/socket-path stack trace trusted-caller-id'
      )
    );
    const provider = createCodexAgentToolProvider(context);
    const result = await provider.handler(call('ListAgents', {}));
    const text = result.contentItems[0]?.type === 'inputText' ? result.contentItems[0].text : '';
    expect(result.success).toBe(false);
    expect(text).toContain('Agent tool ListAgents');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('/private/session');
    expect(text).not.toContain('stack trace');
    expect(text).not.toContain('trusted-caller-id');
    expect(text.length).toBeLessThanOrEqual(2_048);
  });

  test('serializes a provider result safely when it contains cycles and unsupported values', async () => {
    const { context, calls } = createContext('subagent');
    const circular: Record<string, unknown> = {
      callback: () => undefined,
      missing: undefined,
      bigint: BigInt(7),
    };
    circular.self = circular;
    calls.listAgents.mockResolvedValueOnce(circular as never);
    const provider = createCodexAgentToolProvider(context);

    const result = await provider.handler(call('ListAgents', {}));
    expect(result.success).toBe(true);
    expect(result.contentItems[0]).toEqual({
      type: 'inputText',
      text: '{"bigint":"7","callback":null,"missing":null,"self":"[Circular]"}',
    });
  });

  test('rejects tampered role definitions, including deferred or extra fields', () => {
    const { context } = createContext('orchestrator');
    const provider = createCodexAgentToolProvider(context);
    const listDefinition = provider.definitions.find(
      (definition) => definition.name === 'ListAgents'
    );
    expect(listDefinition).toBeDefined();

    expect(() =>
      validateCodexAgentToolProvider({
        ...provider,
        definitions: provider.definitions.map((definition) =>
          definition.name === 'ListAgents' ? { ...definition, deferLoading: true } : definition
        ),
      })
    ).toThrow('do not match');
    expect(() =>
      validateCodexAgentToolProvider({
        ...provider,
        definitions: provider.definitions.map((definition) =>
          definition.name === 'ListAgents'
            ? { ...definition, futureField: 'not part of the built-in definition' }
            : definition
        ),
      })
    ).toThrow('do not match');
  });

  test('uses canonical strict schemas and rejects model identity fields', async () => {
    const { context, calls } = createContext('orchestrator');
    const provider = createCodexAgentToolProvider(context);
    const start = provider.definitions.find((definition) => definition.name === 'StartAgent');
    expect(start?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string' },
        executor: { type: 'string' },
        initialMessage: { type: 'string' },
      },
    });

    const result = await provider.handler(
      call('StartAgent', { ...validArguments.StartAgent, caller: 'forged' })
    );
    expect(result.success).toBe(false);
    expect(result.contentItems[0]?.text).toContain('caller is trusted');
    expect(calls.startAgent).not.toHaveBeenCalled();
  });
});
