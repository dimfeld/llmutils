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
import { AGENT_TYPES, ORCHESTRATOR_AGENT_NAME, agentRuntimeRoleSchema } from './contracts.js';
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
    expect(
      agentEnvironmentIdentitySchema.safeParse({
        ...orchestratorIdentity,
        unexpected: true,
      }).success
    ).toBe(false);
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
    for (const type of AGENT_TYPES) {
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

  test('copies every defined inherited value while replacing the identity contract', () => {
    const inheritedEnv: Record<string, string | undefined> = {
      KEEP_EMPTY: '',
      KEEP_ZERO: '0',
      KEEP_TEXT: 'inherited',
      OMIT_UNDEFINED: undefined,
      [TIM_AGENT_MESSAGING_DIR]: '/tmp/stale-session',
      [TIM_AGENT_ID]: 'stale-id',
      [TIM_AGENT_NAME]: 'stale-name',
      [TIM_AGENT_TYPE]: 'tester',
      [TIM_AGENT_ROLE]: 'subagent',
    };

    const childEnv = withAgentEnvironmentIdentity(inheritedEnv, {
      messagingDirectory: '/tmp/tim-agent-session',
      id: 'worker-id',
      name: 'api-worker',
      type: 'tester',
      role: 'subagent',
    });

    expect(childEnv).toEqual({
      KEEP_EMPTY: '',
      KEEP_ZERO: '0',
      KEEP_TEXT: 'inherited',
      [TIM_AGENT_MESSAGING_DIR]: '/tmp/tim-agent-session',
      [TIM_AGENT_ID]: 'worker-id',
      [TIM_AGENT_NAME]: 'api-worker',
      [TIM_AGENT_TYPE]: 'tester',
      [TIM_AGENT_ROLE]: 'subagent',
    });
    expect(childEnv).not.toHaveProperty('OMIT_UNDEFINED');
  });

  test('returns undefined only when all internal values are absent', () => {
    expect(readAgentEnvironmentIdentity({})).toBeUndefined();
    for (const variableName of INTERNAL_AGENT_ENVIRONMENT_VARIABLES) {
      expect(() => readAgentEnvironmentIdentity({ [variableName]: 'present' })).toThrow();
    }
    expect(() => readAgentEnvironmentIdentity({ [TIM_AGENT_MESSAGING_DIR]: '' })).toThrow();
  });

  test('rejects incomplete and contradictory identities', () => {
    const completeOrchestratorEnvironment: Record<string, string> = {
      [TIM_AGENT_MESSAGING_DIR]: '/tmp/session',
      [TIM_AGENT_ID]: 'root-id',
      [TIM_AGENT_NAME]: ORCHESTRATOR_AGENT_NAME,
      [TIM_AGENT_ROLE]: 'orchestrator',
    };
    for (const variableName of [
      TIM_AGENT_MESSAGING_DIR,
      TIM_AGENT_ID,
      TIM_AGENT_NAME,
      TIM_AGENT_ROLE,
    ]) {
      const incompleteEnvironment = { ...completeOrchestratorEnvironment };
      delete incompleteEnvironment[variableName];
      expect(() => readAgentEnvironmentIdentity(incompleteEnvironment)).toThrow();
    }

    const completeSubagentEnvironment: Record<string, string> = {
      [TIM_AGENT_MESSAGING_DIR]: '/tmp/session',
      [TIM_AGENT_ID]: 'worker-id',
      [TIM_AGENT_NAME]: 'worker',
      [TIM_AGENT_TYPE]: 'tester',
      [TIM_AGENT_ROLE]: 'subagent',
    };
    for (const variableName of INTERNAL_AGENT_ENVIRONMENT_VARIABLES) {
      const incompleteEnvironment = { ...completeSubagentEnvironment };
      delete incompleteEnvironment[variableName];
      expect(() => readAgentEnvironmentIdentity(incompleteEnvironment)).toThrow();
    }

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
        [TIM_AGENT_ID]: 'root-id',
        [TIM_AGENT_NAME]: ORCHESTRATOR_AGENT_NAME,
        [TIM_AGENT_TYPE]: 'tester',
        [TIM_AGENT_ROLE]: 'orchestrator',
      },
      {
        [TIM_AGENT_MESSAGING_DIR]: '/tmp/session',
        [TIM_AGENT_ID]: 'worker-id',
        [TIM_AGENT_NAME]: 'worker',
        [TIM_AGENT_TYPE]: 'tester',
        [TIM_AGENT_ROLE]: 'orchestrator',
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
        [TIM_AGENT_ID]: 'worker-id',
        [TIM_AGENT_NAME]: 'worker',
        [TIM_AGENT_TYPE]: 'tester',
        [TIM_AGENT_ROLE]: 'unknown',
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

    const readEnv = {
      [TIM_AGENT_MESSAGING_DIR]: orchestratorIdentity.messagingDirectory,
      [TIM_AGENT_ID]: orchestratorIdentity.id,
      [TIM_AGENT_NAME]: orchestratorIdentity.name,
      [TIM_AGENT_ROLE]: orchestratorIdentity.role,
    };
    const readEnvSnapshot = { ...readEnv };
    expect(readAgentEnvironmentIdentity(readEnv)).toEqual(orchestratorIdentity);
    expect(readEnv).toEqual(readEnvSnapshot);
  });
});

describe('agent environment reservations', () => {
  test('defines the exact internal variable set', () => {
    expect(INTERNAL_AGENT_ENVIRONMENT_VARIABLES).toEqual([
      'TIM_AGENT_MESSAGING_DIR',
      'TIM_AGENT_ID',
      'TIM_AGENT_NAME',
      'TIM_AGENT_TYPE',
      'TIM_AGENT_ROLE',
    ]);
  });

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
