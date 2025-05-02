import { test, expect, describe, beforeEach, afterEach, jest } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';

// Mock dependencies before importing the module under test
const mockGenerateRmfilterOutput = jest.fn();
const mockGetGitRoot = jest.fn();

jest.mock('./rmfilter', async (importOriginal) => {
  const original = await importOriginal<typeof import('./rmfilter')>();
  return {
    ...original,
    generateRmfilterOutput: mockGenerateRmfilterOutput,
  };
});

jest.mock('./utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('./utils')>();
  return {
    ...original,
    getGitRoot: mockGetGitRoot,
  };
});

// Now import the function to test
import { runRmfilterProgrammatically } from './rmfilter';

describe('runRmfilterProgrammatically', () => {
  let tempDir: string;
  const MOCK_GIT_ROOT = '/mock/git/root';

  beforeEach(async () => {
    // Create a temporary directory for testing file operations
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmfilter-test-'));
    // Create some dummy files
    await fs.writeFile(path.join(tempDir, 'file1.ts'), 'console.log("hello");');
    await fs.writeFile(path.join(tempDir, 'file2.js'), 'console.log("world");');
    await fs.mkdir(path.join(tempDir, 'subdir'));
    await fs.writeFile(path.join(tempDir, 'subdir', 'file3.txt'), 'subdir file');

    // Reset mocks
    mockGenerateRmfilterOutput.mockReset();
    mockGetGitRoot.mockReset();

    // Setup default mock implementations
    mockGetGitRoot.mockResolvedValue(MOCK_GIT_ROOT);
    mockGenerateRmfilterOutput.mockResolvedValue('Mocked rmfilter output');
  });

  afterEach(async () => {
    // Clean up the temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('should parse simple file path arguments', async () => {
    const args = ['file1.ts', 'subdir/file3.txt'];
    const expectedOutput = 'Mocked output for simple files';
    mockGenerateRmfilterOutput.mockResolvedValueOnce(expectedOutput);

    const result = await runRmfilterProgrammatically(args, MOCK_GIT_ROOT, tempDir);

    expect(result).toBe(expectedOutput);
    expect(mockGenerateRmfilterOutput).toHaveBeenCalledTimes(1);
    const callArgs = mockGenerateRmfilterOutput.mock.calls[0];
    const config = callArgs[0];
    const baseDir = callArgs[1];
    const gitRoot = callArgs[2];

    expect(gitRoot).toBe(MOCK_GIT_ROOT);
    expect(baseDir).toBe(tempDir);
    expect(config.globalValues).toEqual({});
    expect(config.commandsParsed).toHaveLength(1);
    expect(config.commandsParsed[0].positionals).toEqual(['file1.ts', 'subdir/file3.txt']);
    expect(config.commandsParsed[0].values).toEqual({});
    expect(config.cliArgsString).toBe('file1.ts subdir/file3.txt');
  });

  test('should parse global flags like --with-diff and --model', async () => {
    const args = ['--with-diff', '--model', 'test-model', 'file1.ts'];
    await runRmfilterProgrammatically(args, MOCK_GIT_ROOT, tempDir);

    expect(mockGenerateRmfilterOutput).toHaveBeenCalledTimes(1);
    const config = mockGenerateRmfilterOutput.mock.calls[0][0];

    expect(config.globalValues['with-diff']).toBe(true);
    expect(config.globalValues.model).toBe('test-model');
    expect(config.commandsParsed).toHaveLength(1);
    expect(config.commandsParsed[0].positionals).toEqual(['file1.ts']);
    // Flags are parsed globally *and* for the first command segment before '--'
    expect(config.commandsParsed[0].values['with-diff']).toBe(true);
    expect(config.commandsParsed[0].values.model).toBe('test-model');
    expect(config.cliArgsString).toBe('--with-diff --model test-model file1.ts');
  });

  test('should parse command-specific flags like --grep', async () => {
    const args = ['file1.ts', '--grep', 'hello'];
    await runRmfilterProgrammatically(args, MOCK_GIT_ROOT, tempDir);

    expect(mockGenerateRmfilterOutput).toHaveBeenCalledTimes(1);
    const config = mockGenerateRmfilterOutput.mock.calls[0][0];

    expect(config.globalValues.grep).toBeUndefined();
    expect(config.commandsParsed).toHaveLength(1);
    expect(config.commandsParsed[0].positionals).toEqual(['file1.ts']);
    expect(config.commandsParsed[0].values.grep).toEqual(['hello']);
    expect(config.cliArgsString).toBe('file1.ts --grep hello');
  });

  test('should handle multiple commands separated by --', async () => {
    const args = ['file1.ts', '--grep', 'hello', '--', 'file2.js', '--ignore', '*.txt'];
    await runRmfilterProgrammatically(args, MOCK_GIT_ROOT, tempDir);

    expect(mockGenerateRmfilterOutput).toHaveBeenCalledTimes(1);
    const config = mockGenerateRmfilterOutput.mock.calls[0][0];

    // Global values only capture flags before the first positional or '--'
    // In this case, none are truly global as file1.ts comes first.
    expect(config.globalValues).toEqual({});

    expect(config.commandsParsed).toHaveLength(2);

    // First command
    expect(config.commandsParsed[0].positionals).toEqual(['file1.ts']);
    expect(config.commandsParsed[0].values.grep).toEqual(['hello']);
    expect(config.commandsParsed[0].values.ignore).toBeUndefined();

    // Second command
    expect(config.commandsParsed[1].positionals).toEqual(['file2.js']);
    expect(config.commandsParsed[1].values.ignore).toEqual(['*.txt']);
    expect(config.commandsParsed[1].values.grep).toBeUndefined();

    expect(config.cliArgsString).toBe('file1.ts --grep hello -- file2.js --ignore *.txt');
  });

  test('should pass baseDir and gitRoot correctly', async () => {
    const args = ['file1.ts'];
    const customGitRoot = '/custom/git';
    const customBaseDir = tempDir;

    await runRmfilterProgrammatically(args, customGitRoot, customBaseDir);

    expect(mockGenerateRmfilterOutput).toHaveBeenCalledTimes(1);
    const callArgs = mockGenerateRmfilterOutput.mock.calls[0];
    expect(callArgs[1]).toBe(customBaseDir);
    expect(callArgs[2]).toBe(customGitRoot);
  });

  test('should return the output from generateRmfilterOutput', async () => {
    const args = ['file1.ts'];
    const expectedOutput = 'Specific output for this test case';
    mockGenerateRmfilterOutput.mockResolvedValueOnce(expectedOutput);

    const result = await runRmfilterProgrammatically(args, MOCK_GIT_ROOT, tempDir);

    expect(result).toBe(expectedOutput);
  });

  // Note: Error handling within runRmfilterProgrammatically itself is minimal,
  // as argument parsing errors are typically handled by `parseArgs` (which throws)
  // or within `generateRmfilterOutput`. Testing specific error scenarios might
  // involve mocking `parseArgs` to throw or testing `generateRmfilterOutput` errors separately.
});
```
