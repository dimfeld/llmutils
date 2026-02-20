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
    const parseAllowedToolsList = (allowedTools: string[]) => {
      const result = new Map<string, true | string[]>();
      for (const tool of allowedTools) {
        if (tool.startsWith('Bash(') && tool.endsWith(')')) {
          const inner = tool.slice(5, -1);
          const prefix = inner.endsWith(':*') ? inner.slice(0, -2) : inner;
          const existing = result.get('Bash');
          if (Array.isArray(existing)) {
            if (!existing.includes(prefix)) {
              existing.push(prefix);
            }
          } else {
            result.set('Bash', [prefix]);
          }
          continue;
        }
        result.set(tool, true);
      }
      return result;
    };

    return {
      parseAllowedToolsList,
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

    expect(commandResult).toEqual({ decision: 'accept' });
    expect(fileResult).toEqual({ decision: 'accept' });
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
