import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  closeLogFile,
  formatLogData,
  openLogFile,
  runWithLogWriter,
  writeToLogFile,
} from './common.js';
import { vi } from 'vitest';

describe('logging/common', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'tim-log-test-'));
    await closeLogFile();
  });

  afterEach(async () => {
    await closeLogFile();
    await rm(tempDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  test('does not create the file until the first write', async () => {
    const logPath = path.join(tempDir, 'tim.log');

    openLogFile(logPath);
    expect(existsSync(logPath)).toBe(false);

    writeToLogFile('hello\n');
    await closeLogFile();

    expect(existsSync(logPath)).toBe(true);
    await expect(readFile(logPath, 'utf8')).resolves.toMatch(
      /^\[\d{2}:\d{2}:\d{2}\] \[orchestrator\] hello\n$/
    );
  });

  test('adds a timestamp and writer name to every line', async () => {
    const logPath = path.join(tempDir, 'tim.log');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T01:02:03.000Z'));

    openLogFile(logPath);
    runWithLogWriter('worker-a', () => writeToLogFile('first\n\nthird\n'));
    await closeLogFile();

    await expect(readFile(logPath, 'utf8')).resolves.toBe(
      '[01:02:03] [worker-a] first\n[01:02:03] [worker-a] \n[01:02:03] [worker-a] third\n'
    );
  });

  test('formats empty data without adding a line', () => {
    expect(formatLogData('', 'worker-a')).toBe('');
  });

  test('closing without writes does not create the file', async () => {
    const logPath = path.join(tempDir, 'tim.log');

    openLogFile(logPath);
    await closeLogFile();

    expect(existsSync(logPath)).toBe(false);
  });
});
