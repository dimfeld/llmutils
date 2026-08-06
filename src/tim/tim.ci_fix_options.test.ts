import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const { handleCiFixCommandMock } = vi.hoisted(() => ({
  handleCiFixCommandMock: vi.fn(async () => {}),
}));

vi.mock('./commands/ci_fix.js', () => ({
  handleCiFixCommand: handleCiFixCommandMock,
}));

import { program } from './tim.ts';

function findCommand(parentName: string, commandName: string) {
  const parent = program.commands.find((command) => command.name() === parentName);
  if (!parent) {
    throw new Error(`Command ${parentName} was not registered`);
  }

  const command = parent.commands.find((child) => child.name() === commandName);
  if (!command) {
    throw new Error(`Command ${parentName} ${commandName} was not registered`);
  }

  return command;
}

async function runTimCli(args: string[]): Promise<void> {
  await program.parseAsync(['node', 'tim', ...args]);
}

describe('tim pr fix-ci Commander registration', () => {
  beforeAll(() => {
    program.exitOverride();
  });

  beforeEach(() => {
    handleCiFixCommandMock.mockClear();
  });

  test('keeps the pr fix option block and passes every option to the handler', async () => {
    const prFix = findCommand('pr', 'fix');
    const ciFix = findCommand('pr', 'fix-ci');

    expect(ciFix.options.map((option) => option.flags).sort()).toEqual(
      prFix.options.map((option) => option.flags).sort()
    );

    await runTimCli([
      'pr',
      'fix-ci',
      '123',
      '--pr',
      '456',
      '--plan',
      '789',
      '--current',
      '--branch',
      'feature/ci-fix',
      '-x',
      'codex-cli',
      '-m',
      'gpt-5-codex',
      '--effort',
      'max',
      '--aw',
      '-w',
      'ci-workspace',
      '--nw',
      '--no-workspace-sync',
      '--non-interactive',
      '--no-terminal-input',
    ]);

    expect(handleCiFixCommandMock).toHaveBeenCalledTimes(1);
    const [positionalArg, options] = handleCiFixCommandMock.mock.calls[0];
    expect(positionalArg).toBe('123');
    expect(options).toMatchObject({
      pr: '456',
      plan: '789',
      current: true,
      branch: 'feature/ci-fix',
      executor: 'codex-cli',
      model: 'gpt-5-codex',
      effort: 'max',
      autoWorkspace: true,
      workspace: 'ci-workspace',
      newWorkspace: true,
      workspaceSync: false,
      nonInteractive: true,
      terminalInput: false,
    });
  });
});
