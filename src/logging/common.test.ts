import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeLogFile, openLogFile, writeToLogFile } from './common.js';

describe('logging/common', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'tim-log-test-'));
    await closeLogFile();
  });

  afterEach(async () => {
    await closeLogFile();
    await rm(tempDir, { recursive: true, force: true });
  });

  test('does not create the file until the first write', async () => {
    const logPath = path.join(tempDir, 'tim.log');

    openLogFile(logPath);
    expect(existsSync(logPath)).toBe(false);

    writeToLogFile('hello\n');
    await closeLogFile();

    expect(existsSync(logPath)).toBe(true);
    await expect(readFile(logPath, 'utf8')).resolves.toBe('hello\n');
  });

  test('closing without writes does not create the file', async () => {
    const logPath = path.join(tempDir, 'tim.log');

    openLogFile(logPath);
    await closeLogFile();

    expect(existsSync(logPath)).toBe(false);
  });
});
