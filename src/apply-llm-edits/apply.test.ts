import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import { getOriginalRequestContext, extractRmfilterCommandArgs } from './apply';
import type { ApplyLlmEditsOptions } from './apply';
import { getOutputPath } from '../rmfilter/repomix';
import { runRmfilterProgrammatically } from '../rmfilter/rmfilter';
import { getGitRoot } from '../rmfilter/utils';

// --- Mocking Dependencies ---

// Mock extractRmfilterCommandArgs from the same module
vi.mock('./apply', async (importOriginal) => {
  const original = await importOriginal<typeof import('./apply')>();
  return {
    ...original,
    extractRmfilterCommandArgs: vi.fn(),
  };
});

// Mock functions from other modules
vi.mock('../rmfilter/repomix', () => ({
  getOutputPath: vi.fn(),
}));

vi.mock('../rmfilter/rmfilter', () => ({
  runRmfilterProgrammatically: vi.fn(),
}));

// Mock Bun.file().text()
// Store mock file contents and errors here
const mockFileStore: Record<string, { content?: string; error?: any }> = {};
vi.mock('bun', async (importOriginal) => {
  const original = await importOriginal<typeof import('bun')>();
  return {
    ...original,
    file: (path: string) => ({
      text: async () => {
        const entry = mockFileStore[path];
        if (entry?.error) {
          throw entry.error;
        }
        if (entry?.content !== undefined) {
          return entry.content;
        }
        // Default behavior if path not in store: throw ENOENT
        const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
        (err as any).code = 'ENOENT';
        throw err;
      },
      // Add other Bun.file methods if needed by the tested function
    }),
  };
});

// --- Test Suite ---

describe('getOriginalRequestContext', () => {
  const mockGitRoot = '/fake/git/root';
  const mockBaseDir = '/fake/base/dir';
  const mockCachePath = '/fake/git/root/repomix_output.txt';
  const mockContentWithCommand =
    '<rmfilter_command>rmfilter file1.ts --grep "foo"</rmfilter_command> Some other content';
  const mockContentWithoutCommand = 'Some other content without the tag';
  const mockCommandArgs = ['rmfilter', 'file1.ts', '--grep', 'foo'];
  const mockDifferentCommandArgs = ['rmfilter', 'file2.ts', '--grep', 'bar'];
  const mockCachedContent =
    '<rmfilter_command>rmfilter file1.ts --grep "foo"</rmfilter_command> Cached context';
  const mockRerunContent =
    '<rmfilter_command>rmfilter file1.ts --grep "foo"</rmfilter_command> Rerun context';

  // Helper to reset mocks and file store before each test
  beforeEach(() => {
    vi.resetAllMocks();
    // Clear the mock file store
    for (const key in mockFileStore) {
      delete mockFileStore[key];
    }

    // Default mock implementations
    vi.mocked(getOutputPath).mockResolvedValue('repomix_output.txt');
    vi.mocked(runRmfilterProgrammatically).mockResolvedValue(mockRerunContent);
  });

  it('should return options.originalPrompt if provided', async () => {
    const options: ApplyLlmEditsOptions = {
      content: mockContentWithCommand,
      originalPrompt: 'Explicit original prompt',
    };
    const context = await getOriginalRequestContext(options, mockGitRoot, mockBaseDir);
    expect(context).toBe('Explicit original prompt');
    expect(vi.mocked(extractRmfilterCommandArgs)).not.toHaveBeenCalled();
    expect(vi.mocked(getOutputPath)).not.toHaveBeenCalled();
  });

  it('should throw if originalPrompt is not provided and rmfilter_command is missing', async () => {
    const options: ApplyLlmEditsOptions = {
      content: mockContentWithoutCommand,
    };
    // Mock extractRmfilterCommandArgs to return null for the input content
    vi.mocked(extractRmfilterCommandArgs).mockReturnValue(null);

    await expect(getOriginalRequestContext(options, mockGitRoot, mockBaseDir)).rejects.toThrow(
      'Cannot retry: Original prompt not provided and <rmfilter_command> tag not found or empty in the LLM response content.'
    );
    expect(vi.mocked(extractRmfilterCommandArgs)).toHaveBeenCalledWith(options.content);
  });

  it('should return cached content if cache file exists and arguments match', async () => {
    const options: ApplyLlmEditsOptions = {
      content: mockContentWithCommand,
    };
    // Mock command extraction for input content
    vi.mocked(extractRmfilterCommandArgs).mockImplementation((content) => {
      if (content === options.content) return mockCommandArgs;
      if (content === mockCachedContent) return mockCommandArgs;
      return null;
    });
    // Mock file read for cache file
    mockFileStore[mockCachePath] = { content: mockCachedContent };

    const context = await getOriginalRequestContext(options, mockGitRoot, mockBaseDir);

    expect(context).toBe(mockCachedContent);
    expect(vi.mocked(getOutputPath)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(extractRmfilterCommandArgs)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(extractRmfilterCommandArgs)).toHaveBeenCalledWith(options.content);
    expect(vi.mocked(extractRmfilterCommandArgs)).toHaveBeenCalledWith(mockCachedContent);
    expect(vi.mocked(runRmfilterProgrammatically)).not.toHaveBeenCalled();
  });

  it('should return cached content if cache file exists and arguments match (different order)', async () => {
    const options: ApplyLlmEditsOptions = {
      content: '<rmfilter_command>rmfilter --grep "foo" file1.ts</rmfilter_command> Content',
    };
    const currentArgsOutOfOrder = ['rmfilter', '--grep', 'foo', 'file1.ts'];
    const cachedArgs = ['rmfilter', 'file1.ts', '--grep', 'foo'];
    const cachedContentWithCommand = `<rmfilter_command>rmfilter file1.ts --grep "foo"</rmfilter_command> Cached context`;

    vi.mocked(extractRmfilterCommandArgs).mockImplementation((content) => {
      if (content === options.content) return currentArgsOutOfOrder;
      if (content === cachedContentWithCommand) return cachedArgs;
      return null;
    });
    mockFileStore[mockCachePath] = { content: cachedContentWithCommand };

    const context = await getOriginalRequestContext(options, mockGitRoot, mockBaseDir);

    expect(context).toBe(cachedContentWithCommand);
    expect(vi.mocked(runRmfilterProgrammatically)).not.toHaveBeenCalled();
    expect(vi.mocked(extractRmfilterCommandArgs)).toHaveBeenCalledTimes(2);
  });

  it('should re-run rmfilter if cache file exists but arguments do not match', async () => {
    const options: ApplyLlmEditsOptions = {
      content: mockContentWithCommand,
    };
    const cachedContentDifferentArgs = `<rmfilter_command>rmfilter file2.ts --grep "bar"</rmfilter_command> Stale cached context`;

    // Mock command extraction
    vi.mocked(extractRmfilterCommandArgs).mockImplementation((content) => {
      if (content === options.content) return mockCommandArgs;
      if (content === cachedContentDifferentArgs) return mockDifferentCommandArgs;
      return null;
    });
    // Mock file read for cache file
    mockFileStore[mockCachePath] = { content: cachedContentDifferentArgs };

    const context = await getOriginalRequestContext(options, mockGitRoot, mockBaseDir);

    expect(context).toBe(mockRerunContent);
    expect(vi.mocked(getOutputPath)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(extractRmfilterCommandArgs)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runRmfilterProgrammatically)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runRmfilterProgrammatically)).toHaveBeenCalledWith(
      mockCommandArgs,
      mockGitRoot,
      mockBaseDir
    );
  });

  it('should re-run rmfilter if cache file does not exist', async () => {
    const options: ApplyLlmEditsOptions = {
      content: mockContentWithCommand,
    };
    // Mock command extraction for input content
    vi.mocked(extractRmfilterCommandArgs).mockReturnValue(mockCommandArgs);
    // No entry in mockFileStore for mockCachePath simulates ENOENT

    const context = await getOriginalRequestContext(options, mockGitRoot, mockBaseDir);

    expect(context).toBe(mockRerunContent);
    expect(vi.mocked(getOutputPath)).toHaveBeenCalledTimes(1);
    // extractRmfilterCommandArgs only called once because cache read fails before parsing cache
    expect(vi.mocked(extractRmfilterCommandArgs)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(extractRmfilterCommandArgs)).toHaveBeenCalledWith(options.content);
    expect(vi.mocked(runRmfilterProgrammatically)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runRmfilterProgrammatically)).toHaveBeenCalledWith(
      mockCommandArgs,
      mockGitRoot,
      mockBaseDir
    );
  });

  it('should re-run rmfilter if cache file exists but rmfilter_command is missing in cache', async () => {
    const options: ApplyLlmEditsOptions = {
      content: mockContentWithCommand,
    };
    const cachedContentNoCommand = `Just some text, no command tag`;

    vi.mocked(extractRmfilterCommandArgs).mockImplementation((content) => {
      if (content === options.content) return mockCommandArgs;
      if (content === cachedContentNoCommand) return null;
      return null;
    });
    mockFileStore[mockCachePath] = { content: cachedContentNoCommand };

    const context = await getOriginalRequestContext(options, mockGitRoot, mockBaseDir);

    expect(context).toBe(mockRerunContent);
    expect(vi.mocked(getOutputPath)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(extractRmfilterCommandArgs)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runRmfilterProgrammatically)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runRmfilterProgrammatically)).toHaveBeenCalledWith(
      mockCommandArgs,
      mockGitRoot,
      mockBaseDir
    );
  });

  it('should throw if runRmfilterProgrammatically throws an error', async () => {
    const options: ApplyLlmEditsOptions = {
      content: mockContentWithCommand,
    };
    const runError = new Error('rmfilter failed');
    // Mock command extraction for input content
    vi.mocked(extractRmfilterCommandArgs).mockReturnValue(mockCommandArgs);
    // Mock cache file not existing
    // Mock runRmfilterProgrammatically to throw
    vi.mocked(runRmfilterProgrammatically).mockRejectedValue(runError);

    await expect(getOriginalRequestContext(options, mockGitRoot, mockBaseDir)).rejects.toThrow(
      `Failed to regenerate original rmfilter context by re-running command: ${mockCommandArgs.join(' ')}`
    );

    expect(vi.mocked(getOutputPath)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(extractRmfilterCommandArgs)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runRmfilterProgrammatically)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runRmfilterProgrammatically)).toHaveBeenCalledWith(
      mockCommandArgs,
      mockGitRoot,
      mockBaseDir
    );
  });

  it('should handle errors during cache file reading gracefully and re-run rmfilter', async () => {
    const options: ApplyLlmEditsOptions = {
      content: mockContentWithCommand,
    };
    const readError = new Error('Permission denied');
    (readError as any).code = 'EACCES';

    vi.mocked(extractRmfilterCommandArgs).mockReturnValue(mockCommandArgs);
    mockFileStore[mockCachePath] = { error: readError };

    // We expect it to log a warning (can't easily test console output here)
    // and then proceed to re-run rmfilter
    const context = await getOriginalRequestContext(options, mockGitRoot, mockBaseDir);

    expect(context).toBe(mockRerunContent);
    expect(vi.mocked(getOutputPath)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(extractRmfilterCommandArgs)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runRmfilterProgrammatically)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runRmfilterProgrammatically)).toHaveBeenCalledWith(
      mockCommandArgs,
      mockGitRoot,
      mockBaseDir
    );
  });
});
