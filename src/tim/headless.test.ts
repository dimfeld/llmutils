import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { getLoggerAdapter, runWithLogger, type LoggerAdapter } from '../logging/adapter.js';
import { HeadlessAdapter } from '../logging/headless_adapter.js';
import * as logging from '../logging.js';
import { ModuleMocker } from '../testing.js';
import type { StructuredMessage } from '../logging/structured_messages.js';

const moduleMocker = new ModuleMocker(import.meta);

const getRepositoryIdentitySpy = mock(async () => ({
  repositoryId: 'owner/repo',
  remoteUrl: 'https://github.com/owner/repo.git',
  gitRoot: '/tmp/repo',
}));

let resolveHeadlessUrl: typeof import('./headless.js').resolveHeadlessUrl;
let buildHeadlessSessionInfo: typeof import('./headless.js').buildHeadlessSessionInfo;
let runWithHeadlessAdapterIfEnabled: typeof import('./headless.js').runWithHeadlessAdapterIfEnabled;
let createHeadlessAdapterForCommand: typeof import('./headless.js').createHeadlessAdapterForCommand;
let resetHeadlessWarningStateForTests: typeof import('./headless.js').resetHeadlessWarningStateForTests;

beforeAll(async () => {
  await moduleMocker.mock('./assignments/workspace_identifier.js', () => ({
    getRepositoryIdentity: getRepositoryIdentitySpy,
  }));

  ({
    resolveHeadlessUrl,
    buildHeadlessSessionInfo,
    runWithHeadlessAdapterIfEnabled,
    createHeadlessAdapterForCommand,
    resetHeadlessWarningStateForTests,
  } = await import('./headless.js'));
});

afterEach(() => {
  getRepositoryIdentitySpy.mockClear();
  delete process.env.TIM_HEADLESS_URL;
  delete process.env.WEZTERM_PANE;
  resetHeadlessWarningStateForTests();
});

afterAll(() => {
  moduleMocker.clear();
});

describe('resolveHeadlessUrl', () => {
  test('uses TIM_HEADLESS_URL before config and default', () => {
    process.env.TIM_HEADLESS_URL = 'ws://env.example/socket';
    const value = resolveHeadlessUrl({
      headless: {
        url: 'ws://config.example/socket',
      },
    } as any);
    expect(value).toBe('ws://env.example/socket');
  });

  test('uses config url when env is unset', () => {
    const value = resolveHeadlessUrl({
      headless: {
        url: 'ws://config.example/socket',
      },
    } as any);
    expect(value).toBe('ws://config.example/socket');
  });

  test('uses default URL when env and config are unset', () => {
    const value = resolveHeadlessUrl({} as any);
    expect(value).toBe('ws://localhost:8123/tim-agent');
  });

  test('warns once and falls back when configured URL is not ws:// or wss://', () => {
    const warnSpy = spyOn(logging, 'warn');
    try {
      process.env.TIM_HEADLESS_URL = 'http://example.com/socket';
      expect(resolveHeadlessUrl({} as any)).toBe('ws://localhost:8123/tim-agent');
      expect(resolveHeadlessUrl({} as any)).toBe('ws://localhost:8123/tim-agent');
      const headlessWarns = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('Invalid headless URL')
      );
      expect(headlessWarns).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('buildHeadlessSessionInfo', () => {
  test('includes workspace and remote metadata when available', async () => {
    const info = await buildHeadlessSessionInfo('agent', {
      id: 166,
      title: 'headless mode',
    });

    expect(info).toEqual({
      command: 'agent',
      planId: 166,
      planTitle: 'headless mode',
      workspacePath: '/tmp/repo',
      gitRemote: 'github.com/owner/repo',
      terminalPaneId: undefined,
      terminalType: undefined,
    });
  });

  test('strips credentials from remote URL before sending', async () => {
    getRepositoryIdentitySpy.mockImplementationOnce(async () => ({
      repositoryId: 'owner/repo',
      remoteUrl: 'https://user:token@github.com/owner/repo.git',
      gitRoot: '/tmp/repo',
    }));

    const info = await buildHeadlessSessionInfo('agent', {
      id: 1,
      title: 'cred test',
    });

    expect(info.gitRemote).toBe('github.com/owner/repo');
    expect(info.gitRemote).not.toContain('token');
    expect(info.gitRemote).not.toContain('user');
    expect(info.terminalPaneId).toBeUndefined();
    expect(info.terminalType).toBeUndefined();
  });

  test('silently handles repository lookup failures', async () => {
    getRepositoryIdentitySpy.mockImplementationOnce(async () => {
      throw new Error('no repo');
    });

    const info = await buildHeadlessSessionInfo('review', {
      id: 42,
      title: 'review plan',
    });

    expect(info).toEqual({
      command: 'review',
      planId: 42,
      planTitle: 'review plan',
      workspacePath: undefined,
      gitRemote: undefined,
      terminalPaneId: undefined,
      terminalType: undefined,
    });
  });

  test('includes terminal metadata when WEZTERM_PANE is set', async () => {
    process.env.WEZTERM_PANE = '12';

    const info = await buildHeadlessSessionInfo('agent', {
      id: 99,
      title: 'pane test',
    });

    expect(info.terminalPaneId).toBe('12');
    expect(info.terminalType).toBe('wezterm');
  });

  test('omits terminal metadata when WEZTERM_PANE is unset', async () => {
    const info = await buildHeadlessSessionInfo('agent', {
      id: 99,
      title: 'pane test',
    });

    expect(info.terminalPaneId).toBeUndefined();
    expect(info.terminalType).toBeUndefined();
  });
});

describe('runWithHeadlessAdapterIfEnabled', () => {
  const wrappedAdapter: LoggerAdapter = {
    log: () => {},
    error: () => {},
    warn: () => {},
    writeStdout: () => {},
    writeStderr: () => {},
    debugLog: () => {},
    sendStructured: (_message: StructuredMessage) => {},
  };

  test('installs a headless adapter when enabled', async () => {
    const destroySpy = spyOn(HeadlessAdapter.prototype, 'destroy');
    try {
      const activeAdapter = await runWithLogger(wrappedAdapter, () =>
        runWithHeadlessAdapterIfEnabled({
          enabled: true,
          command: 'agent',
          config: {},
          plan: { id: 166, title: 'headless mode' },
          callback: async () => getLoggerAdapter(),
        })
      );

      expect(activeAdapter).toBeInstanceOf(HeadlessAdapter);
      expect((activeAdapter as any).wrappedAdapter).toBe(wrappedAdapter);
      expect(destroySpy).toHaveBeenCalledTimes(1);
    } finally {
      destroySpy.mockRestore();
    }
  });

  test('uses the existing logger adapter when disabled', async () => {
    const activeAdapter = await runWithLogger(wrappedAdapter, () =>
      runWithHeadlessAdapterIfEnabled({
        enabled: false,
        command: 'review',
        config: {},
        callback: async () => getLoggerAdapter(),
      })
    );

    expect(activeAdapter).toBe(wrappedAdapter);
  });

  test('destroys the headless adapter when callback throws', async () => {
    const destroySpy = spyOn(HeadlessAdapter.prototype, 'destroy');
    try {
      await expect(
        runWithHeadlessAdapterIfEnabled({
          enabled: true,
          command: 'review',
          config: {},
          callback: async () => {
            throw new Error('boom');
          },
        })
      ).rejects.toThrow('boom');
      expect(destroySpy).toHaveBeenCalledTimes(1);
    } finally {
      destroySpy.mockRestore();
    }
  });
});

describe('createHeadlessAdapterForCommand', () => {
  const wrappedAdapter: LoggerAdapter = {
    log: () => {},
    error: () => {},
    warn: () => {},
    writeStdout: () => {},
    writeStderr: () => {},
    debugLog: () => {},
    sendStructured: (_message: StructuredMessage) => {},
  };

  test('wraps the current logger adapter when one is present', async () => {
    const headlessAdapter = await runWithLogger(wrappedAdapter, () =>
      createHeadlessAdapterForCommand({
        command: 'review',
        config: { headless: { url: 'ws://127.0.0.1:9/tim-agent' } },
        plan: { id: 42, title: 'review plan' },
      })
    );

    expect(headlessAdapter).toBeInstanceOf(HeadlessAdapter);
    expect((headlessAdapter as any).wrappedAdapter).toBe(wrappedAdapter);
    await headlessAdapter.destroy();
  });
});
