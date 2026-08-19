import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimConfig } from '../../configSchema.js';
import type { AgentIdentity } from '../../agent_messaging/agent_manager_types.js';
import { formatAgentProcessLabel } from '../../agent_messaging/agent_process_labels.js';
import type { CodexAgentToolDispatcher } from './codex_agent_tools.js';
import { createCodexAgentToolProvider } from './codex_agent_tools.js';
import {
  CODEX_PERSISTENT_AGENT_MODE,
  type CodexPersistentAgentLifecycleCallbacks,
} from './persistent_agent_contract.js';
import {
  startPersistentCodexAgent,
  validateCodexPersistentAgentLaunchOptions,
  type CodexPersistentAgentLaunchOptions,
} from './persistent_codex_session.js';

const originalAppServerMode = process.env.CODEX_USE_APP_SERVER;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalAppServerMode === undefined) {
    delete process.env.CODEX_USE_APP_SERVER;
  } else {
    process.env.CODEX_USE_APP_SERVER = originalAppServerMode;
  }
});

function createIdentity(): AgentIdentity {
  return {
    id: 'agent-1' as AgentIdentity['id'],
    name: 'worker-a' as AgentIdentity['name'],
    role: 'subagent',
    type: 'implementer',
    executor: 'codex-cli',
  };
}

function createCallbacks(): CodexPersistentAgentLifecycleCallbacks {
  return {
    outputActivity: vi.fn(),
    completedAssistantMessage: vi.fn(),
    turnComplete: vi.fn(),
    exit: vi.fn(),
  };
}

function createProvider(identity: AgentIdentity) {
  const dispatcher: CodexAgentToolDispatcher = {
    startAgent: vi.fn(async () => ({
      name: 'worker-b',
      id: 'agent-2',
      type: 'tester',
      executor: 'codex-cli',
      state: 'starting',
    })),
    listAgents: vi.fn(() => ({ agents: [] })),
    sendAgentMessage: vi.fn(async () => ({
      name: 'worker-a',
      messageId: 'message-1',
      delivery: 'queued' as const,
    })),
    stopAgent: vi.fn(async () => ({
      name: 'worker-b',
      mode: 'graceful-requested' as const,
      state: 'stopping' as const,
    })),
    finishAgent: vi.fn(async () => ({ state: 'finishing' as const })),
  };
  return createCodexAgentToolProvider({ caller: identity, dispatcher });
}

function createOptions(
  overrides: Partial<CodexPersistentAgentLaunchOptions> = {}
): CodexPersistentAgentLaunchOptions {
  const identity = createIdentity();
  return {
    mode: CODEX_PERSISTENT_AGENT_MODE,
    identity,
    prompt: 'Initial assignment',
    cwd: '/repo',
    timConfig: {} as TimConfig,
    dynamicToolProvider: createProvider(identity),
    processLabel: formatAgentProcessLabel('codex-cli', identity.name),
    lifecycleCallbacks: createCallbacks(),
    ...overrides,
  };
}

describe('persistent Codex launch validation', () => {
  it('accepts a complete app-server launch contract', () => {
    expect(() => validateCodexPersistentAgentLaunchOptions(createOptions())).not.toThrow();
  });

  it.each([
    ['mode', { mode: 'single-turn' }],
    ['prompt', { prompt: 42 }],
    ['cwd', { cwd: '' }],
    ['identity', { identity: undefined }],
    ['process label', { processLabel: 'Codex thread (wrong-name)' }],
    ['dynamic provider', { dynamicToolProvider: undefined }],
    ['lifecycle callbacks', { lifecycleCallbacks: undefined }],
    ['output schema', { outputSchema: {} }],
    ['output schema path', { outputSchemaPath: '/tmp/schema.json' }],
    ['one-shot app-server mode', { appServerMode: 'single-turn' }],
    ['one-shot inactivity timeout', { inactivityTimeoutMs: 1000 }],
    ['terminal input', { terminalInput: true }],
  ])('rejects invalid %s before setup', (_label, override) => {
    expect(() =>
      validateCodexPersistentAgentLaunchOptions(
        createOptions(override as Partial<CodexPersistentAgentLaunchOptions>)
      )
    ).toThrow();
  });

  it.each([
    ['mode', { mode: 'single-turn' }],
    ['prompt', { prompt: 42 }],
    ['cwd', { cwd: '' }],
    ['identity', { identity: undefined }],
    ['process label', { processLabel: 'Codex thread (wrong-name)' }],
    ['dynamic provider', { dynamicToolProvider: undefined }],
    ['lifecycle callbacks', { lifecycleCallbacks: undefined }],
    ['output schema', { outputSchema: {} }],
    ['output schema path', { outputSchemaPath: '/tmp/schema.json' }],
    ['one-shot app-server mode', { appServerMode: 'single-turn' }],
    ['one-shot inactivity timeout', { inactivityTimeoutMs: 1000 }],
    ['terminal input', { terminalInput: true }],
  ])('launcher rejects invalid %s before any resource allocation', async (_label, override) => {
    const spawnSpy = vi.spyOn(Bun, 'spawn');
    const prepareLogicalExecutor = vi.fn();

    await expect(
      startPersistentCodexAgent(
        createOptions({
          ...override,
          sessionProcessOwner: { prepareLogicalExecutor },
        } as Partial<CodexPersistentAgentLaunchOptions>)
      )
    ).rejects.toThrow();

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(prepareLogicalExecutor).not.toHaveBeenCalled();
  });

  it('rejects a dynamic provider bound to another identity', () => {
    const otherIdentity = { ...createIdentity(), id: 'agent-2' as AgentIdentity['id'] };
    expect(() =>
      validateCodexPersistentAgentLaunchOptions(
        createOptions({ dynamicToolProvider: createProvider(otherIdentity) })
      )
    ).toThrow('not bound to the persistent agent identity');
  });

  it('rejects disabled app-server mode before allocation', () => {
    process.env.CODEX_USE_APP_SERVER = 'false';
    expect(() => validateCodexPersistentAgentLaunchOptions(createOptions())).toThrow(
      /require Codex app-server mode/i
    );
  });

  it('launcher rejects disabled app-server mode before allocation', async () => {
    process.env.CODEX_USE_APP_SERVER = 'false';
    const spawnSpy = vi.spyOn(Bun, 'spawn');
    const prepareLogicalExecutor = vi.fn();

    await expect(
      startPersistentCodexAgent(createOptions({ sessionProcessOwner: { prepareLogicalExecutor } }))
    ).rejects.toThrow(/require Codex app-server mode/i);

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(prepareLogicalExecutor).not.toHaveBeenCalled();
  });

  it('rejects through the launcher before setup when validation fails', async () => {
    await expect(startPersistentCodexAgent(createOptions({ terminalInput: true }))).rejects.toThrow(
      'do not support terminal input'
    );
  });
});
