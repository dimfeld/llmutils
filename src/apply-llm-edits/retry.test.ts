import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runRmfilterProgrammatically } from '../rmfilter/rmfilter';
import { getOriginalRequestContext } from './retry.ts';

// Helper function to create a temporary directory structure for testing
async function createTempTestDir() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'apply-llm-edits-test-'));
  return tempDir;
}

describe('getOriginalRequestContext', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir();
    // Reset mocks for runRmfilterProgrammatically
    await mock.module('../rmfilter/rmfilter', () => ({
      runRmfilterProgrammatically: mock(() => Promise.resolve('regenerated output')),
    }));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('returns originalPrompt when provided', async () => {
    const options = { originalPrompt: 'test prompt', content: '' };
    const result = await getOriginalRequestContext(options, tempDir, tempDir);
    expect(result).toBe('test prompt');
  });

  test('throws when rmfilter_command is missing in content', async () => {
    const options = { content: 'no rmfilter_command tag' };
    await expect(getOriginalRequestContext(options, tempDir, tempDir)).rejects.toThrow(
      'Cannot retry: Original prompt not provided and <rmfilter_command> tag not found or empty in the LLM response content.'
    );
  });

  test('returns cached content when cache file exists and arguments match', async () => {
    const outputPath = path.join(tempDir, 'repomix-output.xml');
    const cachedContent = '<rmfilter_command>--include "*.ts"</rmfilter_command>\nCached content';
    await Bun.write(outputPath, cachedContent);

    const options = {
      content: '<rmfilter_command>--include "*.ts"</rmfilter_command>',
    };
    const result = await getOriginalRequestContext(options, tempDir, tempDir);
    expect(result).toBe(cachedContent);
  });

  test('calls runRmfilterProgrammatically when cache file exists but arguments do not match', async () => {
    const outputPath = path.join(tempDir, 'repomix-output.xml');
    const cachedContent = '<rmfilter_command>--include "*.js"</rmfilter_command>\nCached content';
    await Bun.write(outputPath, cachedContent);

    const options = {
      content: '<rmfilter_command>--include "*.ts"</rmfilter_command>',
    };
    const result = await getOriginalRequestContext(options, tempDir, tempDir);
    expect(result).toBe('regenerated output');
    expect(runRmfilterProgrammatically).toHaveBeenCalledWith(
      ['--include', '*.ts'],
      tempDir,
      tempDir
    );
  });

  test('calls runRmfilterProgrammatically when cache file does not exist', async () => {
    // Don't create the output file, so it doesn't exist
    const options = {
      content: '<rmfilter_command>--include "*.ts"</rmfilter_command>',
    };
    const result = await getOriginalRequestContext(options, tempDir, tempDir);
    expect(result).toBe('regenerated output');
    expect(runRmfilterProgrammatically).toHaveBeenCalledWith(
      ['--include', '*.ts'],
      tempDir,
      tempDir
    );
  });

  test('handles different argument ordering in comparison', async () => {
    const outputPath = path.join(tempDir, 'repomix-output.xml');
    const cachedContent =
      '<rmfilter_command>--include "*.ts" --exclude "node_modules"</rmfilter_command>\nCached content';
    await Bun.write(outputPath, cachedContent);

    const options = {
      content: '<rmfilter_command>--exclude "node_modules" --include "*.ts"</rmfilter_command>',
    };
    const result = await getOriginalRequestContext(options, tempDir, tempDir);
    expect(result).toBe(cachedContent);
  });
});
