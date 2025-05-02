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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { constructRetryPrompt } from './apply.js';
import type { LlmPromptStructure, LlmPromptMessage } from './apply.js';
import type { NoMatchFailure, NotUniqueFailure } from '../editor/types.js';
import { formatFailuresForLlm } from './failures.js';

// Mock the failures module
vi.mock('./failures.js', () => ({
  formatFailuresForLlm: vi.fn(),
}));

describe('constructRetryPrompt', () => {
  const mockFormatFailuresForLlm = vi.mocked(formatFailuresForLlm);

  beforeEach(() => {
    // Reset mocks before each test
    mockFormatFailuresForLlm.mockClear();
  });

  it('should construct the correct prompt structure for retrying failed edits', () => {
    // Arrange
    const originalRequestContext = 'Original user prompt asking for changes.';
    const failedLlmOutput = `<<<<<<< SEARCH
Some original code
=======
Some new code
>>>>>>> REPLACE

<<<<<<< SEARCH
Another piece of code
=======
More new code
>>>>>>> REPLACE`;

    const mockFailures: (NoMatchFailure | NotUniqueFailure)[] = [
      {
        type: 'noMatch',
        filePath: 'src/file1.ts',
        originalText: 'Some original code',
        updatedText: 'Some new code',
        closestMatch: null,
      },
      {
        type: 'notUnique',
        filePath: 'src/file2.js',
        originalText: 'Another piece of code',
        updatedText: 'More new code',
        matchLocations: [
          { startLine: 10, endLine: 10, contextLines: ['line 10 context'] },
          { startLine: 25, endLine: 25, contextLines: ['line 25 context'] },
        ],
      },
    ];

    const expectedFormattedFailures = `Formatted failure details:\nFailure 1: No match in src/file1.ts\nFailure 2: Not unique in src/file2.js`;
    mockFormatFailuresForLlm.mockReturnValue(expectedFormattedFailures);

    const expectedInstructionalText = `Please review the original request context, your previous response, and the errors listed above. Provide a corrected set of edits in the same format as before, addressing these issues. Ensure the SEARCH blocks exactly match the current file content where the changes should be applied, or provide correct unified diffs.`;

    // Act
    const result: LlmPromptStructure = constructRetryPrompt(
      originalRequestContext,
      failedLlmOutput,
      mockFailures
    );

    // Assert
    expect(result).toBeInstanceOf(Array);
    expect(result).toHaveLength(3);

    expect(result[0]).toEqual({ role: 'user', content: originalRequestContext });
    expect(result[1]).toEqual({ role: 'assistant', content: failedLlmOutput });
    expect(result[2].role).toBe('user');
    expect(result[2].content).toContain(expectedFormattedFailures);
    expect(result[2].content).toContain(expectedInstructionalText);
    expect(mockFormatFailuresForLlm).toHaveBeenCalledWith(mockFailures);
  });
});
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyLlmEdits, getWriteRoot } from './apply';
import * as applyInternal from './apply';
import * as interactive from './interactive';
import * as failures from './failures';
import * as logging from '../logging';
import * as utils from '../rmfilter/utils';
import type { EditResult, Failure, LlmRequester } from './apply';

// --- Mocks ---

vi.mock('./apply', async (importOriginal) => {
  const actual = await importOriginal<typeof applyInternal>();
  return {
    ...actual,
    applyEditsInternal: vi.fn(),
    getOriginalRequestContext: vi.fn(),
    constructRetryPrompt: vi.fn(),
    getWriteRoot: vi.fn(),
  };
});
vi.mock('./interactive');
vi.mock('./failures');
vi.mock('../logging');
vi.mock('../rmfilter/utils');

const mockApplyEditsInternal = vi.mocked(applyInternal.applyEditsInternal);
const mockGetOriginalRequestContext = vi.mocked(applyInternal.getOriginalRequestContext);
const mockConstructRetryPrompt = vi.mocked(applyInternal.constructRetryPrompt);
const mockResolveFailuresInteractively = vi.mocked(interactive.resolveFailuresInteractively);
const mockPrintDetailedFailures = vi.mocked(failures.printDetailedFailures);
const mockLog = vi.mocked(logging.log);
const mockWarn = vi.mocked(logging.warn);
const mockError = vi.mocked(logging.error);
const mockGetGitRoot = vi.mocked(utils.getGitRoot);
const mockGetWriteRoot = vi.mocked(getWriteRoot);

// --- Test Data ---

const sampleContent = '<<<<<<< SEARCH\nold line\n=======\nnew line\n>>>>>>> REPLACE\n';
const sampleCorrectedContent =
  '<<<<<<< SEARCH\nold line corrected\n=======\nnew line corrected\n>>>>>>> REPLACE\n';
const sampleOriginalContext =
  '<rmfilter_command>rmfilter file.ts</rmfilter_command>\nOriginal context';
const sampleFailure: Failure = {
  type: 'noMatch',
  filePath: 'file.ts',
  originalText: 'old line',
  updatedText: 'new line',
  reason: 'No match found',
  closestMatch: null,
};
const sampleSuccess: EditResult = {
  type: 'success',
  filePath: 'file.ts',
  originalText: 'old line',
  updatedText: 'new line',
};

const mockSuccessfulLlmRequester: LlmRequester = vi.fn().mockResolvedValue(sampleCorrectedContent);
const mockFailingLlmRequester: LlmRequester = vi.fn().mockRejectedValue(new Error('LLM API Error'));

// --- Test Suite ---

describe('applyLlmEdits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mocks for successful execution paths
    mockGetGitRoot.mockResolvedValue('/fake/git/root');
    mockGetWriteRoot.mockResolvedValue('/fake/write/root');
    mockGetOriginalRequestContext.mockResolvedValue(sampleOriginalContext);
    mockConstructRetryPrompt.mockReturnValue([{ role: 'user', content: 'retry prompt' }]);
  });

  it('should apply edits successfully on the first try and not trigger retry', async () => {
    mockApplyEditsInternal.mockResolvedValueOnce([sampleSuccess]);

    await applyLlmEdits({ content: sampleContent });

    expect(mockApplyEditsInternal).toHaveBeenCalledTimes(1);
    expect(mockApplyEditsInternal).toHaveBeenCalledWith({
      content: sampleContent,
      writeRoot: '/fake/write/root',
      dryRun: false,
      mode: undefined,
    });
    expect(mockGetOriginalRequestContext).not.toHaveBeenCalled();
    expect(mockConstructRetryPrompt).not.toHaveBeenCalled();
    expect(mockSuccessfulLlmRequester).not.toHaveBeenCalled();
    expect(mockResolveFailuresInteractively).not.toHaveBeenCalled();
    expect(mockPrintDetailedFailures).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith('All edits applied successfully.');
  });

  it('should retry on failure, succeed on retry, and log success', async () => {
    mockApplyEditsInternal
      .mockResolvedValueOnce([sampleFailure])
      .mockResolvedValueOnce([sampleSuccess]);

    await applyLlmEdits({
      content: sampleContent,
      llmRequester: mockSuccessfulLlmRequester,
    });

    expect(mockApplyEditsInternal).toHaveBeenCalledTimes(2);
    expect(mockApplyEditsInternal).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ content: sampleContent })
    );
    expect(mockApplyEditsInternal).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ content: sampleCorrectedContent })
    );
    expect(mockGetOriginalRequestContext).toHaveBeenCalledTimes(1);
    expect(mockConstructRetryPrompt).toHaveBeenCalledTimes(1);
    expect(mockConstructRetryPrompt).toHaveBeenCalledWith(sampleOriginalContext, sampleContent, [
      sampleFailure,
    ]);
    expect(mockSuccessfulLlmRequester).toHaveBeenCalledTimes(1);
    expect(mockSuccessfulLlmRequester).toHaveBeenCalledWith([
      { role: 'user', content: 'retry prompt' },
    ]);
    expect(mockResolveFailuresInteractively).not.toHaveBeenCalled();
    expect(mockPrintDetailedFailures).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Attempting automatic retry'));
    expect(mockLog).toHaveBeenCalledWith('Sending request to LLM for corrections...');
    expect(mockLog).toHaveBeenCalledWith('Received retry response from LLM.');
    expect(mockLog).toHaveBeenCalledWith('Applying edits from LLM retry response...');
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining(
        'Retry attempt finished. 1 edits applied successfully, 0 failures remain.'
      )
    );
    expect(mockLog).toHaveBeenCalledWith('All edits applied successfully.');
  });

  it('should retry, fail again, and throw error when non-interactive', async () => {
    mockApplyEditsInternal
      .mockResolvedValueOnce([sampleFailure])
      .mockResolvedValueOnce([sampleFailure]);

    await expect(
      applyLlmEdits({
        content: sampleContent,
        llmRequester: mockSuccessfulLlmRequester,
        interactive: false,
      })
    ).rejects.toThrow('Failed to apply 1 edits. Run with --interactive to resolve.');

    expect(mockApplyEditsInternal).toHaveBeenCalledTimes(2);
    expect(mockGetOriginalRequestContext).toHaveBeenCalledTimes(1);
    expect(mockConstructRetryPrompt).toHaveBeenCalledTimes(1);
    expect(mockSuccessfulLlmRequester).toHaveBeenCalledTimes(1);
    expect(mockPrintDetailedFailures).toHaveBeenCalledTimes(1);
    expect(mockPrintDetailedFailures).toHaveBeenCalledWith([sampleFailure]);
    expect(mockResolveFailuresInteractively).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining(
        'Retry attempt finished. 0 edits applied successfully, 1 failures remain.'
      )
    );
  });

  it('should retry, fail again, and call interactive resolver when interactive', async () => {
    mockApplyEditsInternal
      .mockResolvedValueOnce([sampleFailure])
      .mockResolvedValueOnce([sampleFailure]);

    await applyLlmEdits({
      content: sampleContent,
      llmRequester: mockSuccessfulLlmRequester,
      interactive: true,
    });

    expect(mockApplyEditsInternal).toHaveBeenCalledTimes(2);
    expect(mockGetOriginalRequestContext).toHaveBeenCalledTimes(1);
    expect(mockConstructRetryPrompt).toHaveBeenCalledTimes(1);
    expect(mockSuccessfulLlmRequester).toHaveBeenCalledTimes(1);
    expect(mockPrintDetailedFailures).not.toHaveBeenCalled();
    expect(mockResolveFailuresInteractively).toHaveBeenCalledTimes(1);
    expect(mockResolveFailuresInteractively).toHaveBeenCalledWith(
      [sampleFailure],
      '/fake/write/root',
      false
    );
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining(
        'Retry attempt finished. 0 edits applied successfully, 1 failures remain.'
      )
    );
  });

  it('should not retry, fail, and throw error when non-interactive and no requester', async () => {
    mockApplyEditsInternal.mockResolvedValueOnce([sampleFailure]);

    await expect(
      applyLlmEdits({
        content: sampleContent,
        interactive: false,
        llmRequester: undefined,
      })
    ).rejects.toThrow('Failed to apply 1 edits. Run with --interactive to resolve.');

    expect(mockApplyEditsInternal).toHaveBeenCalledTimes(1);
    expect(mockGetOriginalRequestContext).not.toHaveBeenCalled();
    expect(mockConstructRetryPrompt).not.toHaveBeenCalled();
    expect(mockPrintDetailedFailures).toHaveBeenCalledTimes(1);
    expect(mockPrintDetailedFailures).toHaveBeenCalledWith([sampleFailure]);
    expect(mockResolveFailuresInteractively).not.toHaveBeenCalled();
  });

  it('should not retry, fail, and call interactive resolver when interactive and no requester', async () => {
    mockApplyEditsInternal.mockResolvedValueOnce([sampleFailure]);

    await applyLlmEdits({
      content: sampleContent,
      interactive: true,
      llmRequester: undefined,
    });

    expect(mockApplyEditsInternal).toHaveBeenCalledTimes(1);
    expect(mockGetOriginalRequestContext).not.toHaveBeenCalled();
    expect(mockConstructRetryPrompt).not.toHaveBeenCalled();
    expect(mockPrintDetailedFailures).not.toHaveBeenCalled();
    expect(mockResolveFailuresInteractively).toHaveBeenCalledTimes(1);
    expect(mockResolveFailuresInteractively).toHaveBeenCalledWith(
      [sampleFailure],
      '/fake/write/root',
      false
    );
  });

  it('should abort retry and fallback if getOriginalRequestContext fails (non-interactive)', async () => {
    const contextError = new Error('Failed to get context');
    mockApplyEditsInternal.mockResolvedValueOnce([sampleFailure]);
    mockGetOriginalRequestContext.mockRejectedValue(contextError);

    await expect(
      applyLlmEdits({
        content: sampleContent,
        llmRequester: mockSuccessfulLlmRequester,
        interactive: false,
      })
    ).rejects.toThrow('Failed to apply 1 edits. Run with --interactive to resolve.');

    expect(mockApplyEditsInternal).toHaveBeenCalledTimes(1);
    expect(mockGetOriginalRequestContext).toHaveBeenCalledTimes(1);
    expect(mockConstructRetryPrompt).not.toHaveBeenCalled();
    expect(mockSuccessfulLlmRequester).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to retrieve original context'),
      contextError.message
    );
    expect(mockWarn).toHaveBeenCalledWith('Proceeding without LLM retry.');
    expect(mockPrintDetailedFailures).toHaveBeenCalledTimes(1);
    expect(mockPrintDetailedFailures).toHaveBeenCalledWith([sampleFailure]);
    expect(mockResolveFailuresInteractively).not.toHaveBeenCalled();
  });

  it('should abort retry and fallback if getOriginalRequestContext fails (interactive)', async () => {
    const contextError = new Error('Failed to get context');
    mockApplyEditsInternal.mockResolvedValueOnce([sampleFailure]);
    mockGetOriginalRequestContext.mockRejectedValue(contextError);

    await applyLlmEdits({
      content: sampleContent,
      llmRequester: mockSuccessfulLlmRequester,
      interactive: true,
    });

    expect(mockApplyEditsInternal).toHaveBeenCalledTimes(1);
    expect(mockGetOriginalRequestContext).toHaveBeenCalledTimes(1);
    expect(mockConstructRetryPrompt).not.toHaveBeenCalled();
    expect(mockSuccessfulLlmRequester).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to retrieve original context'),
      contextError.message
    );
    expect(mockWarn).toHaveBeenCalledWith('Proceeding without LLM retry.');
    expect(mockPrintDetailedFailures).not.toHaveBeenCalled();
    expect(mockResolveFailuresInteractively).toHaveBeenCalledTimes(1);
    expect(mockResolveFailuresInteractively).toHaveBeenCalledWith(
      [sampleFailure],
      '/fake/write/root',
      false
    );
  });

  it('should abort retry and fallback if llmRequester fails (non-interactive)', async () => {
    const llmError = new Error('LLM API Error');
    mockApplyEditsInternal.mockResolvedValueOnce([sampleFailure]);
    mockFailingLlmRequester.mockRejectedValueOnce(llmError);

    await expect(
      applyLlmEdits({
        content: sampleContent,
        llmRequester: mockFailingLlmRequester,
        interactive: false,
      })
    ).rejects.toThrow('Failed to apply 1 edits. Run with --interactive to resolve.');

    expect(mockApplyEditsInternal).toHaveBeenCalledTimes(1);
    expect(mockGetOriginalRequestContext).toHaveBeenCalledTimes(1);
    expect(mockConstructRetryPrompt).toHaveBeenCalledTimes(1);
    expect(mockFailingLlmRequester).toHaveBeenCalledTimes(1);
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining('LLM request for retry failed:'),
      llmError.message
    );
    expect(mockWarn).toHaveBeenCalledWith('Proceeding without applying LLM retry response.');
    expect(mockPrintDetailedFailures).toHaveBeenCalledTimes(1);
    expect(mockPrintDetailedFailures).toHaveBeenCalledWith([sampleFailure]);
    expect(mockResolveFailuresInteractively).not.toHaveBeenCalled();
  });

  it('should abort retry and fallback if llmRequester fails (interactive)', async () => {
    const llmError = new Error('LLM API Error');
    mockApplyEditsInternal.mockResolvedValueOnce([sampleFailure]);
    mockFailingLlmRequester.mockRejectedValueOnce(llmError);

    await applyLlmEdits({
      content: sampleContent,
      llmRequester: mockFailingLlmRequester,
      interactive: true,
    });

    expect(mockApplyEditsInternal).toHaveBeenCalledTimes(1);
    expect(mockGetOriginalRequestContext).toHaveBeenCalledTimes(1);
    expect(mockConstructRetryPrompt).toHaveBeenCalledTimes(1);
    expect(mockFailingLlmRequester).toHaveBeenCalledTimes(1);
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining('LLM request for retry failed:'),
      llmError.message
    );
    expect(mockWarn).toHaveBeenCalledWith('Proceeding without applying LLM retry response.');
    expect(mockPrintDetailedFailures).not.toHaveBeenCalled();
    expect(mockResolveFailuresInteractively).toHaveBeenCalledTimes(1);
    expect(mockResolveFailuresInteractively).toHaveBeenCalledWith(
      [sampleFailure],
      '/fake/write/root',
      false
    );
  });
});
