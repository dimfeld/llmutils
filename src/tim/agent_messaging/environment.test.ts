import { describe, expect, test } from 'vitest';
import { timConfigSchema } from '../configSchema.js';
import {
  INTERNAL_AGENT_ENVIRONMENT_VARIABLES,
  TIM_AGENT_ID,
  TIM_AGENT_MESSAGING_DIR,
  TIM_AGENT_NAME,
  TIM_AGENT_ROLE,
  TIM_AGENT_TYPE,
  agentEnvironmentIdentitySchema,
  readAgentEnvironmentIdentity,
  withAgentEnvironmentIdentity,
  type AgentEnvironmentIdentity,
} from './environment.js';
import { ORCHESTRATOR_AGENT_NAME, agentRuntimeRoleSchema } from './contracts.js';
import {
  TIM_ENVIRONMENT_CONTEXT_DEFINITIONS,
  renderBuiltInTimEnvironment,
  RESERVED_TIM_ENVIRONMENT_VARIABLES,
} from '../environment_templates.js';

describe('agent environment identity contract', () => {
  const orchestratorIdentity: AgentEnvironmentIdentity = {
    messagingDirectory: '/tmp/tim-agent-session',
    id: 'root-id',
    name: ORCHESTRATOR_AGENT_NAME,
    role: 'orchestrator',
  };

  test('reuses the canonical runtime role schema', () => {
    expect(agentRuntimeRoleSchema.parse(orchestratorIdentity.role)).toBe('orchestrator');
    expect(agentEnvironmentIdentitySchema.parse(orchestratorIdentity)).toEqual(
      orchestratorIdentity
    );
  });

  test('round-trips an orchestrator identity and removes stale type data', () => {
    const inheritedEnv: Record<string, string | undefined> = {
      KEEP_ME: 'inherited',
      [TIM_AGENT_MESSAGING_DIR]: '/tmp/stale-session',
      [TIM_AGENT_ID]: 'stale-id',
      [TIM_AGENT_NAME]: 'stale-name',
      [TIM_AGENT_TYPE]: 'tester',
      [TIM_AGENT_ROLE]: 'subagent',
      OMIT_ME: undefined,
    };

    const childEnv = withAgentEnvironmentIdentity(inheritedEnv, orchestratorIdentity);

    expect(childEnv).toEqual({
      KEEP_ME: 'inherited',
      [TIM_AGENT_MESSAGING_DIR]: '/tmp/tim-agent-session',
      [TIM_AGENT_ID]: 'root-id',
      [TIM_AGENT_NAME]: ORCHESTRATOR_AGENT_NAME,
      [TIM_AGENT_ROLE]: 'orchestrator',
    });
    expect(readAgentEnvironmentIdentity(childEnv)).toEqual(orchestratorIdentity);
    expect(inheritedEnv[TIM_AGENT_TYPE]).toBe('tester');
    expect(inheritedEnv.OMIT_ME).toBeUndefined();
  });

  test('round-trips every canonical subagent type', () => {
    const agentTypes = ['implementer', 'tester', 'tdd-tests', 'reviewer'] as const;
    for (const type of agentTypes) {
      const identity: AgentEnvironmentIdentity = {
        messagingDirectory: '/tmp/tim-agent-session',
        id: `${type}-id`,
        name: `${type}-worker`,
        type,
        role: 'subagent',
      };
      const childEnv = withAgentEnvironmentIdentity({}, identity);

      expect(readAgentEnvironmentIdentity(childEnv)).toEqual(identity);
      expect(childEnv[TIM_AGENT_TYPE]).toBe(type);
    }
  });

  test('returns undefined only when all internal values are absent', () => {
    expect(readAgentEnvironmentIdentity({})).toBeUndefined();
    for (const variableName of INTERNAL_AGENT_ENVIRONMENT_VARIABLES) {
      expect(() => readAgentEnvironmentIdentity({ [variableName]: 'present' })).toThrow();
    }
    expect(() => readAgentEnvironmentIdentity({ [TIM_AGENT_MESSAGING_DIR]: '' })).toThrow();
  });

  test('rejects incomplete and contradictory identities', () => {
    const invalidEnvironments: Array<Record<string, string>> = [
      {
        [TIM_AGENT_MESSAGING_DIR]: '/tmp/session',
        [TIM_AGENT_ID]: 'root-id',
        [TIM_AGENT_NAME]: ORCHESTRATOR_AGENT_NAME,
        [TIM_AGENT_ROLE]: 'orchestrator',
        [TIM_AGENT_TYPE]: 'tester',
      },
      {
        [TIM_AGENT_MESSAGING_DIR]: '/tmp/session',
        [TIM_AGENT_ID]: 'worker-id',
        [TIM_AGENT_NAME]: 'worker',
        [TIM_AGENT_ROLE]: 'subagent',
      },
      {
        [TIM_AGENT_MESSAGING_DIR]: '/tmp/session',
        [TIM_AGENT_ID]: 'worker-id',
        [TIM_AGENT_NAME]: ORCHESTRATOR_AGENT_NAME,
        [TIM_AGENT_TYPE]: 'tester',
        [TIM_AGENT_ROLE]: 'subagent',
      },
      {
        [TIM_AGENT_MESSAGING_DIR]: '/tmp/session',
        [TIM_AGENT_ID]: 'root-id',
        [TIM_AGENT_NAME]: 'worker',
        [TIM_AGENT_ROLE]: 'orchestrator',
      },
      {
        [TIM_AGENT_MESSAGING_DIR]: '/tmp/session',
        [TIM_AGENT_ID]: 'worker-id',
        [TIM_AGENT_NAME]: 'worker',
        [TIM_AGENT_TYPE]: 'unknown',
        [TIM_AGENT_ROLE]: 'subagent',
      },
    ];

    for (const env of invalidEnvironments) {
      expect(() => readAgentEnvironmentIdentity(env)).toThrow();
    }
  });

  test('does not mutate the inherited environment or global process environment', () => {
    const inheritedEnv: Record<string, string | undefined> = {
      EXISTING: 'value',
      [TIM_AGENT_TYPE]: 'stale-type',
    };
    const inheritedSnapshot = { ...inheritedEnv };
    const processEnvSnapshot = { ...process.env };

    withAgentEnvironmentIdentity(inheritedEnv, orchestratorIdentity);

    expect(inheritedEnv).toEqual(inheritedSnapshot);
    expect(process.env).toEqual(processEnvSnapshot);
  });
});

describe('agent environment reservations', () => {
  test('reserves every internal identity variable in project configuration', () => {
    for (const variableName of INTERNAL_AGENT_ENVIRONMENT_VARIABLES) {
      expect(RESERVED_TIM_ENVIRONMENT_VARIABLES).toContain(variableName);
      expect(() => timConfigSchema.parse({ environment: { [variableName]: 'spoofed' } })).toThrow();
    }
  });

  test('does not expose internal identity variables as public built-ins', () => {
    const publicBuiltIns = renderBuiltInTimEnvironment({});
    for (const variableName of INTERNAL_AGENT_ENVIRONMENT_VARIABLES) {
      expect(publicBuiltIns).not.toHaveProperty(variableName);
      expect(TIM_ENVIRONMENT_CONTEXT_DEFINITIONS).not.toHaveProperty(variableName);
    }
  });
});
