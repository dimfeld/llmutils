import { test, expect, describe, jest, mock } from 'bun:test';
import type { EditResult } from '../editor/types';

// Mock the underlying processors
const mockProcessUnifiedDiff = jest.fn();
const mockProcessSearchReplace = jest.fn();
const mockProcessXmlContents = jest.fn();
const mockProcessRawFiles = jest.fn();

mock.module('../editor/udiff-simple/parse.ts', () => ({
  processUnifiedDiff: mockProcessUnifiedDiff,
}));
mock.module('../editor/diff-editor/parse.ts', () => ({
  processSearchReplace: mockProcessSearchReplace,
}));
mock.module('../editor/xml/parse_xml.ts', () => ({
  processXmlContents: mockProcessXmlContents,
}));
mock.module('../editor/whole-file/parse_raw_edits.ts', () => ({
  processRawFiles: mockProcessRawFiles,
}));

// Import the function under test *after* setting up mocks
import { applyEditsInternal } from './apply';

// Sample EditResult for testing diff modes
const mockEditResults: EditResult[] = [
  { type: 'success', filePath: 'test.txt', originalText: 'a', updatedText: 'b' },
];

describe('applyEditsInternal', () => {
  const defaultArgs = {
    content: 'some content',
    writeRoot: '/path/to/root',
    dryRun: false,
  };

  beforeEach(() => {
    // Reset mocks before each test
    mockProcessUnifiedDiff.mockReset();
    mockProcessSearchReplace.mockReset();
    mockProcessXmlContents.mockReset();
    mockProcessRawFiles.mockReset();

    // Default mock implementations
    mockProcessUnifiedDiff.mockResolvedValue(mockEditResults);
    mockProcessSearchReplace.mockResolvedValue(mockEditResults);
    mockProcessXmlContents.mockResolvedValue(undefined);
    mockProcessRawFiles.mockResolvedValue(undefined);
  });

  // --- Explicit Mode Tests ---

  test('should call processUnifiedDiff when mode is "udiff"', async () => {
    const result = await applyEditsInternal({ ...defaultArgs, mode: 'udiff' });
    expect(mockProcessUnifiedDiff).toHaveBeenCalledTimes(1);
    expect(mockProcessUnifiedDiff).toHaveBeenCalledWith(defaultArgs);
    expect(mockProcessSearchReplace).not.toHaveBeenCalled();
    expect(mockProcessXmlContents).not.toHaveBeenCalled();
    expect(mockProcessRawFiles).not.toHaveBeenCalled();
    expect(result).toEqual(mockEditResults);
  });

  test('should call processSearchReplace when mode is "diff"', async () => {
    const result = await applyEditsInternal({ ...defaultArgs, mode: 'diff' });
    expect(mockProcessSearchReplace).toHaveBeenCalledTimes(1);
    expect(mockProcessSearchReplace).toHaveBeenCalledWith(defaultArgs);
    expect(mockProcessUnifiedDiff).not.toHaveBeenCalled();
    expect(mockProcessXmlContents).not.toHaveBeenCalled();
    expect(mockProcessRawFiles).not.toHaveBeenCalled();
    expect(result).toEqual(mockEditResults);
  });

  test('should call processXmlContents when mode is "xml"', async () => {
    const result = await applyEditsInternal({ ...defaultArgs, mode: 'xml' });
    expect(mockProcessXmlContents).toHaveBeenCalledTimes(1);
    expect(mockProcessXmlContents).toHaveBeenCalledWith(defaultArgs);
    expect(mockProcessUnifiedDiff).not.toHaveBeenCalled();
    expect(mockProcessSearchReplace).not.toHaveBeenCalled();
    expect(mockProcessRawFiles).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  test('should call processRawFiles when mode is "whole"', async () => {
    const result = await applyEditsInternal({ ...defaultArgs, mode: 'whole' });
    expect(mockProcessRawFiles).toHaveBeenCalledTimes(1);
    expect(mockProcessRawFiles).toHaveBeenCalledWith(defaultArgs);
    expect(mockProcessUnifiedDiff).not.toHaveBeenCalled();
    expect(mockProcessSearchReplace).not.toHaveBeenCalled();
    expect(mockProcessXmlContents).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  // --- Automatic Mode Detection Tests ---

  test('should detect udiff mode from content (--- and @@)', async () => {
    const content = '--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,1 @@\n-old\n+new';
    const result = await applyEditsInternal({ ...defaultArgs, content });
    expect(mockProcessUnifiedDiff).toHaveBeenCalledTimes(1);
    expect(mockProcessUnifiedDiff).toHaveBeenCalledWith({ ...defaultArgs, content });
    expect(result).toEqual(mockEditResults);
  });

  test('should detect udiff mode from content (```diff and @@)', async () => {
    const content = '```diff\n--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n```';
    const result = await applyEditsInternal({ ...defaultArgs, content });
    expect(mockProcessUnifiedDiff).toHaveBeenCalledTimes(1);
    expect(mockProcessUnifiedDiff).toHaveBeenCalledWith({ ...defaultArgs, content });
    expect(result).toEqual(mockEditResults);
  });

  test('should detect diff mode from content (<<<<<<< SEARCH)', async () => {
    const content = '<<<<<<< SEARCH\nold content\n=======\nnew content\n>>>>>>> REPLACE';
    const result = await applyEditsInternal({ ...defaultArgs, content });
    expect(mockProcessSearchReplace).toHaveBeenCalledTimes(1);
    expect(mockProcessSearchReplace).toHaveBeenCalledWith({ ...defaultArgs, content });
    expect(result).toEqual(mockEditResults);
  });

  test('should detect xml mode from content (<code_changes>)', async () => {
    const content = '<code_changes><change>...</change></code_changes>';
    const result = await applyEditsInternal({ ...defaultArgs, content });
    expect(mockProcessXmlContents).toHaveBeenCalledTimes(1);
    expect(mockProcessXmlContents).toHaveBeenCalledWith({ ...defaultArgs, content });
    expect(result).toBeUndefined();
  });

  test('should default to whole file mode for unrecognized content', async () => {
    const content = 'Just some plain text or code without specific markers.';
    const result = await applyEditsInternal({ ...defaultArgs, content });
    expect(mockProcessRawFiles).toHaveBeenCalledTimes(1);
    expect(mockProcessRawFiles).toHaveBeenCalledWith({ ...defaultArgs, content });
    expect(result).toBeUndefined();
  });

  // --- Argument Passing Test ---

  test('should pass dryRun and writeRoot correctly', async () => {
    const specificArgs = {
      content: '--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,1 @@\n-old\n+new',
      writeRoot: '/specific/root',
      dryRun: true,
    };
    await applyEditsInternal(specificArgs);
    expect(mockProcessUnifiedDiff).toHaveBeenCalledWith(specificArgs);
  });
});
import { describe, it, expect } from 'bun:test';
import { extractRmfilterCommandArgs } from './apply.ts';

describe('extractRmfilterCommandArgs', () => {
  it('should return null if the tag is not present', () => {
    const content = 'Some content without the tag.';
    expect(extractRmfilterCommandArgs(content)).toBeNull();
  });

  it('should return null if the tag is empty', () => {
    const content = 'Content with <rmfilter_command></rmfilter_command> empty tag.';
    expect(extractRmfilterCommandArgs(content)).toBeNull();
  });

  it('should return null if the tag contains only whitespace', () => {
    const content = 'Content with <rmfilter_command>   \n \t </rmfilter_command> whitespace tag.';
    expect(extractRmfilterCommandArgs(content)).toBeNull();
  });

  it('should extract and parse simple arguments', () => {
    const content =
      'Some preamble <rmfilter_command>--arg1 value1 --arg2</rmfilter_command> some postamble';
    expect(extractRmfilterCommandArgs(content)).toEqual(['--arg1', 'value1', '--arg2']);
  });

  it('should extract and parse arguments with quotes', () => {
    const content =
      '<rmfilter_command>command --path "path/with spaces" --message \'hello world\'</rmfilter_command>';
    expect(extractRmfilterCommandArgs(content)).toEqual([
      'command',
      '--path',
      'path/with spaces',
      '--message',
      'hello world',
    ]);
  });

  it('should handle escaped quotes within arguments', () => {
    const content =
      '<rmfilter_command>--arg "value with \\"escaped quotes\\"" --another \'single \\\' quote\'</rmfilter_command>';
    expect(extractRmfilterCommandArgs(content)).toEqual([
      '--arg',
      'value with "escaped quotes"',
      '--another',
      "single ' quote",
    ]);
  });

  it('should only parse the first tag if multiple exist', () => {
    const content =
      '<rmfilter_command>first --tag</rmfilter_command> some text <rmfilter_command>second --tag</rmfilter_command>';
    expect(extractRmfilterCommandArgs(content)).toEqual(['first', '--tag']);
  });
});
