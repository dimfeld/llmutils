import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ModuleMocker } from '../../../testing.js';

const selectResponses: Array<string | Error> = [];
const prefixResponses: Array<{ exact: boolean; command: string } | Error> = [];
const addPermissionCalls: Array<{
  toolName: string;
  argument?: { exact: boolean; command?: string };
}> = [];

const mockPromptSelect = mock(async () => {
  const next = selectResponses.shift();
  if (next instanceof Error) {
    throw next;
  }
  if (typeof next !== 'string') {
    throw new Error('No queued select response');
  }
  return next;
});

const mockPromptPrefixSelect = mock(async () => {
  const next = prefixResponses.shift();
  if (next instanceof Error) {
    throw next;
  }
  if (!next) {
    throw new Error('No queued prefix response');
  }
  return next;
});

const moduleMocker = new ModuleMocker(import.meta);
let createApprovalHandler: typeof import('./app_server_approval').createApprovalHandler;
let AppServerRequestError: typeof import('./app_server_connection').AppServerRequestError;

const originalAllowAllTools = process.env.ALLOW_ALL_TOOLS;

beforeAll(async () => {
  await moduleMocker.mock('../../../common/input.ts', () => ({
    promptSelect: mockPromptSelect,
    promptPrefixSelect: mockPromptPrefixSelect,
    isPromptTimeoutError: () => false,
  }));

  await moduleMocker.mock('../claude_code/permissions_mcp_setup.ts', () => {
    return {
      addPermissionToFile: async (
        toolName: string,
        argument?: { exact: boolean; command?: string }
      ) => {
        addPermissionCalls.push({ toolName, argument });
      },
    };
  });

  ({ createApprovalHandler } = await import('./app_server_approval'));
  ({ AppServerRequestError } = await import('./app_server_connection'));
});

afterAll(() => {
  moduleMocker.clear();
});

beforeEach(() => {
  selectResponses.length = 0;
  prefixResponses.length = 0;
  addPermissionCalls.length = 0;
  mockPromptSelect.mockClear();
  mockPromptPrefixSelect.mockClear();
  delete process.env.ALLOW_ALL_TOOLS;
});

afterEach(() => {
  if (originalAllowAllTools === undefined) {
    delete process.env.ALLOW_ALL_TOOLS;
  } else {
    process.env.ALLOW_ALL_TOOLS = originalAllowAllTools;
  }
});

describe('createApprovalHandler', () => {
  test('auto-approves all requests when ALLOW_ALL_TOOLS is set', async () => {
    process.env.ALLOW_ALL_TOOLS = '1';
    const handler = createApprovalHandler();

    const commandResult = await handler('item/commandExecution/requestApproval', 1, {
      command: 'rm -rf /tmp/x',
    });
    const fileResult = await handler('item/fileChange/requestApproval', 2, {
      changes: [{ path: 'src/a.ts', kind: 'modify' }],
    });
    const permissionsResult = await handler('item/permissions/requestApproval', 3, {
      threadId: 'thread-1',
      turnId: 'turn-1',
      permissions: {
        fileSystem: {
          write: ['/tmp/project'],
        },
      },
    });

    expect(commandResult).toEqual({ decision: 'accept' });
    expect(fileResult).toEqual({ decision: 'accept' });
    expect(permissionsResult).toEqual({
      permissions: {
        fileSystem: {
          write: ['/tmp/project'],
        },
      },
    });
    expect(mockPromptSelect).not.toHaveBeenCalled();
  });

  test('auto-approves commands matching allowed bash prefix', async () => {
    const handler = createApprovalHandler({
      allowedTools: ['Bash(git:*)'],
    });

    const result = await handler('item/commandExecution/requestApproval', 1, {
      command: 'git status',
    });

    expect(result).toEqual({ decision: 'accept' });
    expect(mockPromptSelect).not.toHaveBeenCalled();
  });

  test('auto-approves piped update-plan-tasks commands by suffix', async () => {
    const handler = createApprovalHandler({ allowedTools: [] });

    const result = await handler('item/commandExecution/requestApproval', 1, {
      command: 'echo \'{"plan":"42","tasks":[]}\' | tim tools update-plan-tasks',
    });

    expect(result).toEqual({ decision: 'accept' });
    expect(mockPromptSelect).not.toHaveBeenCalled();
    expect(mockPromptPrefixSelect).not.toHaveBeenCalled();
  });

  test('auto-approves direct update-plan-tasks commands by suffix', async () => {
    const handler = createApprovalHandler({ allowedTools: [] });

    const result = await handler('item/commandExecution/requestApproval', 1, {
      command: 'tim tools update-plan-tasks',
    });

    expect(result).toEqual({ decision: 'accept' });
    expect(mockPromptSelect).not.toHaveBeenCalled();
    expect(mockPromptPrefixSelect).not.toHaveBeenCalled();
  });

  test('auto-approves update-plan-tasks commands with trailing whitespace', async () => {
    const handler = createApprovalHandler({ allowedTools: [] });

    const result = await handler('item/commandExecution/requestApproval', 1, {
      command: 'tim tools update-plan-tasks   ',
    });

    expect(result).toEqual({ decision: 'accept' });
    expect(mockPromptSelect).not.toHaveBeenCalled();
    expect(mockPromptPrefixSelect).not.toHaveBeenCalled();
  });

  test('still prompts for unrelated commands', async () => {
    selectResponses.push('decline');
    const handler = createApprovalHandler({ allowedTools: [] });

    const result = await handler('item/commandExecution/requestApproval', 1, {
      command: 'tim tools list-ready-plans',
    });

    expect(result).toEqual({ decision: 'decline' });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);
  });

  test('declines unknown command when prompt returns decline', async () => {
    selectResponses.push('decline');
    const handler = createApprovalHandler({ allowedTools: [] });

    const result = await handler('item/commandExecution/requestApproval', 1, {
      command: 'npm publish',
    });

    expect(result).toEqual({ decision: 'decline' });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);
  });

  test('supports Allow for Session and then auto-approves matching prefix', async () => {
    selectResponses.push('session_allow');
    prefixResponses.push({ command: 'git', exact: false });
    const handler = createApprovalHandler({ allowedTools: [] });

    const first = await handler('item/commandExecution/requestApproval', 1, {
      command: 'git status',
    });
    expect(first).toEqual({ decision: 'accept', acceptSettings: { forSession: true } });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);
    expect(mockPromptPrefixSelect).toHaveBeenCalledTimes(1);

    const second = await handler('item/commandExecution/requestApproval', 2, {
      command: 'git diff --name-only',
    });
    expect(second).toEqual({ decision: 'accept' });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);
    expect(mockPromptPrefixSelect).toHaveBeenCalledTimes(1);
  });

  test('supports Always Allow and persists prefix for future auto-approval', async () => {
    selectResponses.push('always_allow');
    prefixResponses.push({ command: 'npm', exact: false });
    const handler = createApprovalHandler({ allowedTools: [] });

    const first = await handler('item/commandExecution/requestApproval', 1, {
      command: 'npm publish --dry-run',
    });
    expect(first).toEqual({ decision: 'accept' });
    expect(addPermissionCalls).toEqual([
      {
        toolName: 'Bash',
        argument: { command: 'npm', exact: false },
      },
    ]);

    const second = await handler('item/commandExecution/requestApproval', 2, {
      command: 'npm install',
    });
    expect(second).toEqual({ decision: 'accept' });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);
    expect(mockPromptPrefixSelect).toHaveBeenCalledTimes(1);
  });

  test('auto-approves file changes when sandbox allows writes', async () => {
    const handler = createApprovalHandler({ sandboxAllowsFileWrites: true });
    const result = await handler('item/fileChange/requestApproval', 1, {
      changes: [{ path: 'src/a.ts', kind: 'modify' }],
    });

    expect(result).toEqual({ decision: 'accept' });
    expect(mockPromptSelect).not.toHaveBeenCalled();
  });

  test('prompts for file changes when sandbox does not allow writes', async () => {
    selectResponses.push('allow');
    const handler = createApprovalHandler({ sandboxAllowsFileWrites: false });
    const result = await handler('item/fileChange/requestApproval', 1, {
      changes: [{ path: 'src/a.ts', kind: 'modify' }],
    });

    expect(result).toEqual({ decision: 'accept' });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);
  });

  test('auto-grants requested filesystem writes that are already within writable roots', async () => {
    const handler = createApprovalHandler({
      writableRoots: ['/repo', '/shared'],
    });

    const result = await handler('item/permissions/requestApproval', 1, {
      threadId: 'thread-1',
      turnId: 'turn-1',
      reason: 'Select a workspace root',
      permissions: {
        fileSystem: {
          write: ['/shared'],
        },
      },
    });

    expect(result).toEqual({
      permissions: {
        fileSystem: {
          write: ['/shared'],
        },
      },
    });
    expect(mockPromptSelect).not.toHaveBeenCalled();
  });

  test('returns only the already-granted subset when new permissions are declined', async () => {
    selectResponses.push('decline');
    const handler = createApprovalHandler({
      writableRoots: ['/repo'],
    });

    const result = await handler('item/permissions/requestApproval', 1, {
      threadId: 'thread-1',
      turnId: 'turn-1',
      permissions: {
        fileSystem: {
          write: ['/repo', '/outside'],
        },
      },
    });

    expect(result).toEqual({
      permissions: {
        fileSystem: {
          write: ['/repo'],
        },
      },
    });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);
  });

  test('sticks granted permissions for later requests in the same turn', async () => {
    selectResponses.push('allow');
    const handler = createApprovalHandler();

    const first = await handler('item/permissions/requestApproval', 1, {
      threadId: 'thread-1',
      turnId: 'turn-1',
      permissions: {
        fileSystem: {
          write: ['/repo'],
        },
      },
    });

    const second = await handler('item/permissions/requestApproval', 2, {
      threadId: 'thread-1',
      turnId: 'turn-1',
      permissions: {
        fileSystem: {
          write: ['/repo'],
        },
      },
    });

    expect(first).toEqual({
      permissions: {
        fileSystem: {
          write: ['/repo'],
        },
      },
    });
    expect(second).toEqual({
      permissions: {
        fileSystem: {
          write: ['/repo'],
        },
      },
    });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);
  });

  test('persists session-scoped permission grants across turns in the same thread', async () => {
    selectResponses.push('session_allow');
    const handler = createApprovalHandler();

    const first = await handler('item/permissions/requestApproval', 1, {
      threadId: 'thread-1',
      turnId: 'turn-1',
      permissions: {
        macos: {
          accessibility: true,
        },
      },
    });

    const second = await handler('item/permissions/requestApproval', 2, {
      threadId: 'thread-1',
      turnId: 'turn-2',
      permissions: {
        macos: {
          accessibility: true,
        },
      },
    });

    expect(first).toEqual({
      scope: 'session',
      permissions: {
        macos: {
          accessibility: true,
        },
      },
    });
    expect(second).toEqual({
      permissions: {
        macos: {
          accessibility: true,
        },
      },
    });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);
  });

  test('throws AppServerRequestError for unknown method', async () => {
    const handler = createApprovalHandler();

    await expect(handler('item/unknown/requestApproval', 1, {})).rejects.toBeInstanceOf(
      AppServerRequestError
    );
    await expect(handler('item/unknown/requestApproval', 1, {})).rejects.toMatchObject({
      code: -32601,
    });
  });
});
