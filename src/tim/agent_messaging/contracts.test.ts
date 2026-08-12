import { describe, expect, test } from 'vitest';
import {
  AGENT_EXECUTORS,
  AGENT_LIFECYCLE_STATES,
  AGENT_RUNTIME_ROLES,
  AGENT_TYPES,
  MAX_AGENT_MESSAGE_BYTES,
  MAX_AGENT_NAME_LENGTH,
  MAX_PENDING_MESSAGES_PER_RECIPIENT,
  MAX_SUBAGENTS_PER_SESSION,
  NONTERMINAL_AGENT_LIFECYCLE_STATES,
  ORCHESTRATOR_AGENT_NAME,
  SEND_AGENT_MESSAGE_ACKNOWLEDGEMENTS,
  STOP_AGENT_ACKNOWLEDGEMENTS,
  TERMINAL_AGENT_LIFECYCLE_STATES,
  agentAddressSchema,
  agentExecutorSchema,
  agentIdSchema,
  agentLifecycleStateSchema,
  agentMessageContentSchema,
  agentNameSchema,
  agentRuntimeRoleSchema,
  agentSummarySchema,
  agentTypeSchema,
  finishAgentArgumentsSchema,
  finishAgentResultSchema,
  isNonterminalAgentLifecycleState,
  isTerminalAgentLifecycleState,
  listAgentsArgumentsSchema,
  listAgentsResultSchema,
  sendAgentMessageArgumentsSchema,
  sendAgentMessageAcknowledgementSchema,
  sendAgentMessageResultSchema,
  startAgentArgumentsSchema,
  startAgentResultSchema,
  stopAgentArgumentsSchema,
  stopAgentAcknowledgementSchema,
  stopAgentResultSchema,
  utf8ByteLength,
} from './contracts.js';

describe('agent messaging enum contracts', () => {
  test('defines the exact agent types, executors, roles, states, and acknowledgements', () => {
    expect(AGENT_TYPES).toEqual(['implementer', 'tester', 'tdd-tests', 'reviewer']);
    expect(AGENT_EXECUTORS).toEqual(['claude-code', 'codex-cli']);
    expect(AGENT_RUNTIME_ROLES).toEqual(['orchestrator', 'subagent']);
    expect(AGENT_LIFECYCLE_STATES).toEqual([
      'starting',
      'running-active',
      'running-idle',
      'finishing',
      'stopping',
      'exited',
      'failed',
    ]);
    expect(NONTERMINAL_AGENT_LIFECYCLE_STATES).toEqual([
      'starting',
      'running-active',
      'running-idle',
      'finishing',
      'stopping',
    ]);
    expect(TERMINAL_AGENT_LIFECYCLE_STATES).toEqual(['exited', 'failed']);
    expect(SEND_AGENT_MESSAGE_ACKNOWLEDGEMENTS).toEqual(['steered', 'queued', 'started-idle-turn']);
    expect(STOP_AGENT_ACKNOWLEDGEMENTS).toEqual([
      'graceful-requested',
      'forced',
      'already-stopping',
    ]);

    for (const acknowledgement of SEND_AGENT_MESSAGE_ACKNOWLEDGEMENTS) {
      expect(sendAgentMessageAcknowledgementSchema.parse(acknowledgement)).toBe(acknowledgement);
    }
    for (const acknowledgement of STOP_AGENT_ACKNOWLEDGEMENTS) {
      expect(stopAgentAcknowledgementSchema.parse(acknowledgement)).toBe(acknowledgement);
    }
    for (const value of ['immediate', '', null, 1]) {
      expect(sendAgentMessageAcknowledgementSchema.safeParse(value).success).toBe(false);
      expect(stopAgentAcknowledgementSchema.safeParse(value).success).toBe(false);
    }
  });

  test('exposes the exact limits and classifies lifecycle states', () => {
    expect(MAX_AGENT_NAME_LENGTH).toBe(48);
    expect(MAX_SUBAGENTS_PER_SESSION).toBe(8);
    expect(MAX_AGENT_MESSAGE_BYTES).toBe(65_536);
    expect(MAX_PENDING_MESSAGES_PER_RECIPIENT).toBe(100);

    for (const state of NONTERMINAL_AGENT_LIFECYCLE_STATES) {
      expect(isNonterminalAgentLifecycleState(state)).toBe(true);
      expect(isTerminalAgentLifecycleState(state)).toBe(false);
    }
    for (const state of TERMINAL_AGENT_LIFECYCLE_STATES) {
      expect(isTerminalAgentLifecycleState(state)).toBe(true);
      expect(isNonterminalAgentLifecycleState(state)).toBe(false);
    }
    for (const value of [undefined, null, '', 'running', 'unknown']) {
      expect(isTerminalAgentLifecycleState(value)).toBe(false);
      expect(isNonterminalAgentLifecycleState(value)).toBe(false);
    }
  });

  test('rejects unknown enum values', () => {
    for (const value of ['worker', '', 1, null]) {
      expect(agentTypeSchema.safeParse(value).success).toBe(false);
      expect(agentExecutorSchema.safeParse(value).success).toBe(false);
      expect(agentRuntimeRoleSchema.safeParse(value).success).toBe(false);
      expect(agentLifecycleStateSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('agent messaging names and messages', () => {
  test('accepts valid names at the grammar boundaries', () => {
    const fortyEightCharacters = 'a'.repeat(MAX_AGENT_NAME_LENGTH);
    for (const value of ['a', 'a0', 'a-b', 'a--b', '0', fortyEightCharacters]) {
      expect(agentNameSchema.safeParse(value).success, value).toBe(true);
      expect(agentAddressSchema.safeParse(value).success, value).toBe(true);
    }
    expect(agentAddressSchema.safeParse(ORCHESTRATOR_AGENT_NAME).success).toBe(true);
    expect(agentNameSchema.safeParse(ORCHESTRATOR_AGENT_NAME).success).toBe(false);
  });

  test('rejects invalid custom names and addresses without normalization', () => {
    const invalidNames = [
      '',
      '-agent',
      'agent-',
      '-agent-',
      'Agent',
      'agent_name',
      'agent name',
      'agenté',
      'a'.repeat(MAX_AGENT_NAME_LENGTH + 1),
    ];
    for (const value of invalidNames) {
      expect(agentNameSchema.safeParse(value).success, value).toBe(false);
      expect(agentAddressSchema.safeParse(value).success, value).toBe(false);
    }
  });

  test('validates opaque IDs as non-empty strings', () => {
    expect(agentIdSchema.safeParse('opaque-id').success).toBe(true);
    expect(agentIdSchema.safeParse('').success).toBe(false);
    expect(agentIdSchema.safeParse(undefined).success).toBe(false);
  });

  test('counts UTF-8 bytes and accepts the exact message boundary', () => {
    const asciiAtLimit = 'a'.repeat(MAX_AGENT_MESSAGE_BYTES);
    const emojiAtLimit = '🚀'.repeat(MAX_AGENT_MESSAGE_BYTES / 4);
    const twoByteAtLimit = 'é'.repeat(MAX_AGENT_MESSAGE_BYTES / 2);
    const threeByteAtLimit = '€'.repeat(MAX_AGENT_MESSAGE_BYTES / 3);

    expect(utf8ByteLength(asciiAtLimit)).toBe(MAX_AGENT_MESSAGE_BYTES);
    expect(utf8ByteLength(emojiAtLimit)).toBe(MAX_AGENT_MESSAGE_BYTES);
    expect(utf8ByteLength(twoByteAtLimit)).toBe(MAX_AGENT_MESSAGE_BYTES);
    expect(utf8ByteLength(threeByteAtLimit)).toBe(65_535);
    expect(agentMessageContentSchema.safeParse(asciiAtLimit).success).toBe(true);
    expect(agentMessageContentSchema.safeParse(emojiAtLimit).success).toBe(true);
    expect(agentMessageContentSchema.safeParse(twoByteAtLimit).success).toBe(true);
    expect(agentMessageContentSchema.safeParse(`${threeByteAtLimit}a`).success).toBe(true);
  });

  test('rejects one byte above the UTF-8 message boundary without truncation', () => {
    const oversizedAscii = 'a'.repeat(MAX_AGENT_MESSAGE_BYTES + 1);
    const oversizedEmoji = `${'🚀'.repeat(MAX_AGENT_MESSAGE_BYTES / 4)}a`;
    const oversizedTwoByte = `${'é'.repeat(MAX_AGENT_MESSAGE_BYTES / 2)}a`;

    expect(utf8ByteLength(oversizedAscii)).toBe(MAX_AGENT_MESSAGE_BYTES + 1);
    expect(utf8ByteLength(oversizedEmoji)).toBe(MAX_AGENT_MESSAGE_BYTES + 1);
    expect(utf8ByteLength(oversizedTwoByte)).toBe(MAX_AGENT_MESSAGE_BYTES + 1);
    expect(agentMessageContentSchema.safeParse(oversizedAscii).success).toBe(false);
    expect(agentMessageContentSchema.safeParse(oversizedEmoji).success).toBe(false);
    expect(agentMessageContentSchema.safeParse(oversizedTwoByte).success).toBe(false);
    expect(() => agentMessageContentSchema.parse(oversizedAscii)).toThrow(
      `${MAX_AGENT_MESSAGE_BYTES} UTF-8 bytes`
    );
  });
});

describe('agent messaging tool argument contracts', () => {
  test('validates StartTimAgent arguments and rejects model-supplied identity fields', () => {
    const args = {
      name: 'api-worker',
      type: 'implementer',
      executor: 'claude-code',
      initialMessage: 'Implement the API changes.',
    } as const;
    expect(startAgentArgumentsSchema.parse(args)).toEqual(args);

    for (const field of ['source', 'sourceName', 'caller', 'role']) {
      expect(startAgentArgumentsSchema.safeParse({ ...args, [field]: 'spoofed' }).success).toBe(
        false
      );
    }
    expect(
      startAgentArgumentsSchema.safeParse({ ...args, name: ORCHESTRATOR_AGENT_NAME }).success
    ).toBe(false);
    expect(startAgentArgumentsSchema.safeParse({ ...args, type: 'orchestrator' }).success).toBe(
      false
    );
    expect(
      startAgentArgumentsSchema.parse({
        type: 'tester',
        executor: 'codex-cli',
        initialMessage: 'Use the existing test fixtures.',
      })
    ).toEqual({
      type: 'tester',
      executor: 'codex-cli',
      initialMessage: 'Use the existing test fixtures.',
    });
  });

  test('requires an empty strict ListTimAgents argument object', () => {
    expect(listAgentsArgumentsSchema.parse({})).toEqual({});
    expect(listAgentsArgumentsSchema.safeParse({ source: 'spoofed' }).success).toBe(false);
  });

  test('validates SendTimAgentMessage arguments without a source field', () => {
    const args = { name: ORCHESTRATOR_AGENT_NAME, message: 'Status update.' } as const;
    expect(sendAgentMessageArgumentsSchema.parse(args)).toEqual(args);
    for (const field of ['source', 'sourceName', 'sourceId', 'caller', 'role']) {
      expect(
        sendAgentMessageArgumentsSchema.safeParse({ ...args, [field]: 'spoofed' }).success
      ).toBe(false);
    }
  });

  test('validates StopTimAgent arguments without caller authorization fields', () => {
    const args = { name: 'api-worker', message: 'Please report status.', force: true } as const;
    expect(stopAgentArgumentsSchema.parse(args)).toEqual(args);
    expect(stopAgentArgumentsSchema.safeParse({ name: ORCHESTRATOR_AGENT_NAME }).success).toBe(
      false
    );
    expect(stopAgentArgumentsSchema.parse({ name: 'api-worker' })).toEqual({ name: 'api-worker' });
    for (const field of ['source', 'sourceName', 'caller', 'role']) {
      expect(stopAgentArgumentsSchema.safeParse({ ...args, [field]: 'spoofed' }).success).toBe(
        false
      );
    }
  });

  test('validates self-only FinishTimAgent arguments without a target', () => {
    expect(finishAgentArgumentsSchema.parse({})).toEqual({});
    expect(finishAgentArgumentsSchema.parse({ message: 'Done.' })).toEqual({ message: 'Done.' });
    for (const field of ['target', 'name', 'source', 'sourceName', 'caller', 'role']) {
      expect(finishAgentArgumentsSchema.safeParse({ [field]: 'spoofed' }).success).toBe(false);
    }
  });

  test('rejects unknown properties on every strict argument schema', () => {
    const validArguments = [
      {
        schema: startAgentArgumentsSchema,
        value: {
          type: 'implementer',
          executor: 'claude-code',
          initialMessage: 'Start work.',
        },
      },
      { schema: listAgentsArgumentsSchema, value: {} },
      {
        schema: sendAgentMessageArgumentsSchema,
        value: { name: ORCHESTRATOR_AGENT_NAME, message: 'Status.' },
      },
      { schema: stopAgentArgumentsSchema, value: { name: 'api-worker' } },
      { schema: finishAgentArgumentsSchema, value: {} },
    ] as const;

    for (const { schema, value } of validArguments) {
      expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false);
    }
  });
});

describe('agent messaging tool result contracts', () => {
  test('validates StartTimAgent and SendTimAgentMessage results', () => {
    expect(
      startAgentResultSchema.parse({
        name: 'api-worker',
        id: 'opaque-id',
        type: 'tester',
        executor: 'codex-cli',
        state: 'starting',
      })
    ).toEqual({
      name: 'api-worker',
      id: 'opaque-id',
      type: 'tester',
      executor: 'codex-cli',
      state: 'starting',
    });
    expect(
      startAgentResultSchema.safeParse({
        name: 'api-worker',
        id: 'opaque-id',
        type: 'tester',
        executor: 'codex-cli',
        state: 'exited',
      }).success
    ).toBe(false);
    expect(
      sendAgentMessageResultSchema.parse({
        name: ORCHESTRATOR_AGENT_NAME,
        messageId: 'message-id',
        delivery: 'steered',
      })
    ).toEqual({ name: ORCHESTRATOR_AGENT_NAME, messageId: 'message-id', delivery: 'steered' });
    expect(
      sendAgentMessageResultSchema.safeParse({
        name: 'api-worker',
        delivery: 'queued',
      }).success
    ).toBe(false);
  });

  test('validates the role-discriminated ListTimAgents result', () => {
    const result = {
      agents: [
        {
          name: ORCHESTRATOR_AGENT_NAME,
          id: 'root-id',
          role: 'orchestrator',
          executor: 'claude-code',
          state: 'running-active',
        },
        {
          name: 'api-worker',
          id: 'worker-id',
          role: 'subagent',
          type: 'reviewer',
          executor: 'codex-cli',
          state: 'running-idle',
        },
      ],
    } as const;
    expect(listAgentsResultSchema.parse(result)).toEqual(result);
    expect(
      agentSummarySchema.safeParse({
        name: ORCHESTRATOR_AGENT_NAME,
        id: 'root-id',
        role: 'orchestrator',
        type: 'reviewer',
        executor: 'claude-code',
        state: 'running-active',
      }).success
    ).toBe(false);
    expect(
      agentSummarySchema.safeParse({
        name: 'api-worker',
        id: 'worker-id',
        role: 'subagent',
        executor: 'codex-cli',
        state: 'running-idle',
      }).success
    ).toBe(false);
    expect(
      agentSummarySchema.safeParse({
        name: 'api-worker',
        id: 'worker-id',
        role: 'orchestrator',
        executor: 'codex-cli',
        state: 'running-idle',
      }).success
    ).toBe(false);
    expect(
      agentSummarySchema.safeParse({
        name: ORCHESTRATOR_AGENT_NAME,
        id: 'worker-id',
        role: 'subagent',
        type: 'tester',
        executor: 'codex-cli',
        state: 'running-idle',
      }).success
    ).toBe(false);
    expect(listAgentsResultSchema.safeParse({ agents: [], extra: true }).success).toBe(false);
  });

  test('validates StopTimAgent and FinishTimAgent results', () => {
    expect(
      stopAgentResultSchema.parse({
        name: 'api-worker',
        mode: 'already-stopping',
        state: 'stopping',
      })
    ).toEqual({ name: 'api-worker', mode: 'already-stopping', state: 'stopping' });
    expect(
      stopAgentResultSchema.safeParse({
        name: 'api-worker',
        mode: 'forced',
        state: 'not-a-state',
      }).success
    ).toBe(false);
    expect(finishAgentResultSchema.parse({ state: 'finishing' })).toEqual({ state: 'finishing' });
    expect(
      finishAgentResultSchema.safeParse({ state: 'finishing', name: 'api-worker' }).success
    ).toBe(false);
  });

  test('rejects unknown properties on every strict result schema', () => {
    const validResults = [
      {
        schema: startAgentResultSchema,
        value: {
          name: 'api-worker',
          id: 'opaque-id',
          type: 'tester',
          executor: 'codex-cli',
          state: 'starting',
        },
      },
      {
        schema: listAgentsResultSchema,
        value: { agents: [] },
      },
      {
        schema: sendAgentMessageResultSchema,
        value: {
          name: ORCHESTRATOR_AGENT_NAME,
          messageId: 'message-id',
          delivery: 'queued',
        },
      },
      {
        schema: stopAgentResultSchema,
        value: { name: 'api-worker', mode: 'forced', state: 'stopping' },
      },
      {
        schema: finishAgentResultSchema,
        value: { state: 'finishing' },
      },
    ] as const;

    for (const { schema, value } of validResults) {
      expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false);
    }
  });
});
