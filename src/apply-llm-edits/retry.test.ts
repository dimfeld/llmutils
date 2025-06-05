import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as repomix from '../rmfilter/repomix';
import { getOriginalRequestContext } from './retry.ts';
import { ModuleMocker } from '../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Helper function to create a temporary directory structure for testing
async function createTempTestDir() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'apply-llm-edits-test-'));
  return tempDir;
}

describe('getOriginalRequestContext', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir();
    // Reset mocks for runRmfilterProgrammatically and inquirer
    await moduleMocker.mock('../rmfilter/rmfilter.js', () => ({
      runRmfilterProgrammatically: mock(() => Promise.resolve('regenerated output')),
    }));
    await moduleMocker.mock('@inquirer/prompts', () => ({
      confirm: mock(() => Promise.resolve(true)),
    }));
    await moduleMocker.mock('../rmfilter/repomix.js', () => ({
      ...repomix,
      getOutputPath: mock(() => Promise.resolve(path.join(tempDir, 'repomix-output.xml'))),
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    await rm(tempDir, { recursive: true, force: true });
  });

  test('returns originalPrompt when provided', async () => {
    const options = { originalPrompt: 'test prompt', content: '' };
    const result = await getOriginalRequestContext(options, tempDir, tempDir);
    expect(result).toBe('test prompt');
  });

  test('throws when cache file does not exist', async () => {
    const options = { content: '<rmfilter_command>--include "*.ts"</rmfilter_command>' };
    await expect(getOriginalRequestContext(options, tempDir, tempDir)).rejects.toThrow(
      `No cached rmfilter output found at: ${path.join(tempDir, 'repomix-output.command.xml')}`
    );
  });

  test('throws when rmfilter_command is missing in cached content', async () => {
    const outputPath = path.join(tempDir, 'repomix-output.xml');
    const commandPath = repomix.getCommandFilePath(outputPath);
    await Bun.write(commandPath, 'no rmfilter_command tag');

    const options = { content: '<rmfilter_command>--include "*.ts"</rmfilter_command>' };
    await expect(getOriginalRequestContext(options, tempDir, tempDir)).rejects.toThrow(
      `No rmfilter command found in cached rmfilter output at: ${repomix.getCommandFilePath(outputPath)}`
    );
  });

  test('prompts user when command IDs mismatch and proceeds if confirmed', async () => {
    const outputPath = path.join(tempDir, 'repomix-output.xml');
    const commandPath = repomix.getCommandFilePath(outputPath);
    const cachedContent = `
<command_id>1234</command_id>
<rmfilter_command>--include "*.ts"</rmfilter_command>
Cached content
    `;
    await Bun.write(commandPath, cachedContent);

    const options = {
      content: `
<command_id>5678</command_id>
<rmfilter_command>--include "*.ts"</rmfilter_command>
      `,
      interactive: true,
    };
    const result = await getOriginalRequestContext(options, tempDir, tempDir);
    expect(result).toBe('regenerated output');
    expect((await import('@inquirer/prompts')).confirm).toHaveBeenCalledWith({
      message: "The saved command file ID does not match the response's ID. Continue anyway?",
      default: true,
    });
  });

  test('throws when user declines command ID mismatch prompt', async () => {
    await moduleMocker.mock('@inquirer/prompts', () => ({
      confirm: mock(() => Promise.resolve(false)),
    }));

    const outputPath = path.join(tempDir, 'repomix-output.xml');
    const commandPath = repomix.getCommandFilePath(outputPath);
    const cachedContent = `
<command_id>1234</command_id>
<rmfilter_command>--include "*.ts"</rmfilter_command>
Cached content
    `;
    await Bun.write(commandPath, cachedContent);

    const options = {
      content: `
<command_id>5678</command_id>
<rmfilter_command>--include "*.ts"</rmfilter_command>
      `,
      interactive: true,
    };
    await expect(getOriginalRequestContext(options, tempDir, tempDir)).rejects.toThrow(
      'Not continuing due to command ID mismatch'
    );
  });

  test('prompts when response lacks command ID and proceeds if confirmed', async () => {
    const outputPath = path.join(tempDir, 'repomix-output.xml');
    const commandPath = repomix.getCommandFilePath(outputPath);
    const cachedContent = `
<command_id>1234</command_id>
<rmfilter_command>--include "*.ts"</rmfilter_command>
Cached content
    `;
    await Bun.write(commandPath, cachedContent);

    const options = {
      content: '<rmfilter_command>--include "*.ts"</rmfilter_command>',
      interactive: true,
    };
    const result = await getOriginalRequestContext(options, tempDir, tempDir);
    expect(result).toBe('regenerated output');
    expect((await import('@inquirer/prompts')).confirm).toHaveBeenCalledWith({
      message: 'The response does not contain a command file ID. Continue anyway?',
      default: true,
    });
  });
});
