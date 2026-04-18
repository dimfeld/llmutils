import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const {
  handleAddCommandMock,
  handleSetCommandMock,
  handleImportCommandMock,
  handleGenerateCommandMock,
  handleReviewGuideCommandMock,
  handleListCommandMock,
  handleReadyCommandMock,
  handleRenumberMock,
} = vi.hoisted(() => ({
  handleAddCommandMock: vi.fn(async () => {}),
  handleSetCommandMock: vi.fn(async () => {}),
  handleImportCommandMock: vi.fn(async () => {}),
  handleGenerateCommandMock: vi.fn(async () => {}),
  handleReviewGuideCommandMock: vi.fn(async () => {}),
  handleListCommandMock: vi.fn(async () => {}),
  handleReadyCommandMock: vi.fn(async () => {}),
  handleRenumberMock: vi.fn(async () => {}),
}));

vi.mock('./commands/add.js', () => ({
  handleAddCommand: handleAddCommandMock,
}));

vi.mock('./commands/set.js', () => ({
  handleSetCommand: handleSetCommandMock,
}));

vi.mock('./commands/import/import.js', () => ({
  handleImportCommand: handleImportCommandMock,
}));

vi.mock('./commands/generate.js', () => ({
  handleGenerateCommand: handleGenerateCommandMock,
}));

vi.mock('./commands/review_pr.js', () => ({
  handleReviewGuideCommand: handleReviewGuideCommandMock,
}));

vi.mock('./commands/list.js', () => ({
  handleListCommand: handleListCommandMock,
}));

vi.mock('./commands/ready.js', () => ({
  handleReadyCommand: handleReadyCommandMock,
}));

vi.mock('./commands/renumber.js', () => ({
  handleRenumber: handleRenumberMock,
}));

import { program } from './tim.ts';

async function runTimCli(args: string[]): Promise<void> {
  await program.parseAsync(['node', 'tim', ...args]);
}

describe('tim plan ID option parsing at Commander boundary', () => {
  beforeAll(() => {
    program.exitOverride();
  });

  beforeEach(() => {
    handleAddCommandMock.mockClear();
    handleSetCommandMock.mockClear();
    handleImportCommandMock.mockClear();
    handleGenerateCommandMock.mockClear();
    handleReviewGuideCommandMock.mockClear();
    handleListCommandMock.mockClear();
    handleReadyCommandMock.mockClear();
    handleRenumberMock.mockClear();
  });

  test('parses valid plan ID options for add command', async () => {
    await runTimCli([
      'add',
      'Boundary',
      'Parse',
      '--parent',
      '42',
      '--depends-on',
      '1',
      '2',
      '--cleanup',
      '99',
      '--discovered-from',
      '7',
    ]);

    expect(handleAddCommandMock).toHaveBeenCalledTimes(1);
    const [, options] = handleAddCommandMock.mock.calls[0];
    expect(options.parent).toBe(42);
    expect(options.dependsOn).toEqual([1, 2]);
    expect(options.cleanup).toBe(99);
    expect(options.discoveredFrom).toBe(7);
  });

  test('rejects invalid non-integer plan ID options for set command', async () => {
    await expect(runTimCli(['set', '42', '--parent', '1.5'])).rejects.toThrow(
      'Expected a numeric plan ID'
    );
    expect(handleSetCommandMock).not.toHaveBeenCalled();
  });

  test('parses import depends-on and parent as numeric plan IDs', async () => {
    await runTimCli(['import', '123', '--depends-on', '11', '12', '--parent', '9']);

    expect(handleImportCommandMock).toHaveBeenCalledTimes(1);
    const [, options] = handleImportCommandMock.mock.calls[0];
    expect(options.dependsOn).toEqual([11, 12]);
    expect(options.parent).toBe(9);
  });

  test('rejects invalid import depends-on plan IDs at the CLI boundary', async () => {
    await expect(runTimCli(['import', '123', '--depends-on', 'foo'])).rejects.toThrow(
      'Expected a numeric plan ID'
    );
    expect(handleImportCommandMock).not.toHaveBeenCalled();
  });

  test('parses --next-ready as a numeric plan ID at the CLI boundary', async () => {
    await runTimCli(['generate', '--next-ready', '44']);

    expect(handleGenerateCommandMock).toHaveBeenCalledTimes(1);
    const [, options] = handleGenerateCommandMock.mock.calls[0];
    expect(options.nextReady).toBe(44);
  });

  test('rejects non-numeric --next-ready at the CLI boundary', async () => {
    await expect(runTimCli(['generate', '--next-ready', './plans/44.plan.md'])).rejects.toThrow(
      'Expected a numeric plan ID'
    );
    expect(handleGenerateCommandMock).not.toHaveBeenCalled();
  });

  test('rejects non-numeric pr review-guide --plan at the CLI boundary', async () => {
    await expect(runTimCli(['pr', 'review-guide', '--plan', './plans/44.plan.md'])).rejects.toThrow(
      'Expected a numeric plan ID'
    );
    expect(handleReviewGuideCommandMock).not.toHaveBeenCalled();
  });

  test('rejects non-numeric list --epic values at the CLI boundary', async () => {
    await expect(runTimCli(['list', '--epic', 'abc'])).rejects.toThrow(
      'Expected a numeric plan ID'
    );
    await expect(runTimCli(['list', '--epic', '0x10'])).rejects.toThrow(
      'Expected a numeric plan ID'
    );
    expect(handleListCommandMock).not.toHaveBeenCalled();
  });

  test('rejects non-numeric ready --epic values at the CLI boundary', async () => {
    await expect(runTimCli(['ready', '--epic', 'abc'])).rejects.toThrow(
      'Expected a numeric plan ID'
    );
    await expect(runTimCli(['ready', '--epic', '0x10'])).rejects.toThrow(
      'Expected a numeric plan ID'
    );
    expect(handleReadyCommandMock).not.toHaveBeenCalled();
  });

  test('rejects non-numeric renumber --from/--to values at the CLI boundary', async () => {
    await expect(runTimCli(['renumber', '--from', '0x10', '--to', '11'])).rejects.toThrow(
      'Expected a numeric plan ID'
    );
    await expect(runTimCli(['renumber', '--from', '10', '--to', 'abc'])).rejects.toThrow(
      'Expected a numeric plan ID'
    );
    expect(handleRenumberMock).not.toHaveBeenCalled();
  });
});
