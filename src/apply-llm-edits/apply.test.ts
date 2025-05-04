import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';
import {
  extractRmfilterCommandArgs,
  applyEditsInternal,
  applyLlmEdits,
  getWriteRoot,
  getOriginalRequestContext,
} from './apply';
import * as path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { secureWrite, setDebug } from '../rmfilter/utils';
import { runRmfilterProgrammatically } from '../rmfilter/rmfilter';

// Helper function to create a temporary directory structure for testing
async function createTempTestDir() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'apply-llm-edits-test-'));
  return tempDir;
}

describe('extractRmfilterCommandArgs', () => {
  test('extracts command args from content with rmfilter_command tag', () => {
    const content = `
Some content here
<rmfilter_command>--include "*.ts" --exclude "node_modules"</rmfilter_command>
More content here
    `;

    const result = extractRmfilterCommandArgs(content);
    expect(result).toEqual(['--include', '*.ts', '--exclude', 'node_modules']);
  });

  test('returns null when no rmfilter_command tag is found', () => {
    const content = 'Some content without rmfilter_command tag';
    const result = extractRmfilterCommandArgs(content);
    expect(result).toBeNull();
  });

  test('returns null when rmfilter_command tag is empty', () => {
    const content = '<rmfilter_command></rmfilter_command>';
    const result = extractRmfilterCommandArgs(content);
    expect(result).toBeNull();
  });

  test('handles multiline command args', () => {
    const content = `
<rmfilter_command>
--include "*.ts" 
--exclude "node_modules"
</rmfilter_command>
    `;

    const result = extractRmfilterCommandArgs(content);
    expect(result).toEqual(['--include', '*.ts', '--exclude', 'node_modules']);
  });

  test('handles quoted arguments correctly', () => {
    const content =
      '<rmfilter_command>--include "src/**/*.ts" --exclude "test files"</rmfilter_command>';
    const result = extractRmfilterCommandArgs(content);
    expect(result).toEqual(['--include', 'src/**/*.ts', '--exclude', 'test files']);
  });

  test('handles escaped quotes inside quoted strings', () => {
    const content =
      '<rmfilter_command>--include "src/**/*.ts" --message "This is a \\"quoted\\" message"</rmfilter_command>';
    const result = extractRmfilterCommandArgs(content);
    expect(result).toEqual(['--include', 'src/**/*.ts', '--message', 'This is a "quoted" message']);
  });

  test('handles single quotes', () => {
    const content =
      "<rmfilter_command>--include '*.ts' --exclude 'node_modules'</rmfilter_command>";
    const result = extractRmfilterCommandArgs(content);
    expect(result).toEqual(['--include', '*.ts', '--exclude', 'node_modules']);
  });

  test('returns only first rmfilter_command tag when multiple exist', () => {
    const content = `
<rmfilter_command>--include "*.ts"</rmfilter_command>
Some content in between
<rmfilter_command>--exclude "node_modules"</rmfilter_command>
    `;

    const result = extractRmfilterCommandArgs(content);
    expect(result).toEqual(['--include', '*.ts']);
  });

  test('handles whitespace-only content in rmfilter_command tag', () => {
    const content = '<rmfilter_command>   </rmfilter_command>';
    const result = extractRmfilterCommandArgs(content);
    expect(result).toBeNull();
  });
});

describe('applyEditsInternal', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('processes unified diff content correctly', async () => {
    const testFile = path.join(tempDir, 'test.txt');
    await writeFile(testFile, 'Original content\nSecond line\n');

    const diffContent = `
--- test.txt
+++ test.txt
@@ -1,2 +1,2 @@
-Original content
+Modified content
 Second line
`;

    const results = await applyEditsInternal({
      content: diffContent,
      writeRoot: tempDir,
      dryRun: false,
      mode: 'udiff',
    });

    expect(results).toBeDefined();
    expect(results?.successes.length).toBeGreaterThan(0);

    const updatedContent = await Bun.file(testFile).text();
    expect(updatedContent).toBe('Modified content\nSecond line\n');
  });

  test('processes search/replace diff content correctly', async () => {
    const testFile = path.join(tempDir, 'test.txt');
    await writeFile(testFile, 'Original content\nSecond line\n');

    const diffContent = `
test.txt
<<<<<<< SEARCH
Original content
=======
Modified content
>>>>>>> REPLACE
`;

    const results = await applyEditsInternal({
      content: diffContent,
      writeRoot: tempDir,
      dryRun: false,
      mode: 'diff',
    });

    expect(results).toBeDefined();
    expect(results?.successes.length).toBeGreaterThan(0);

    const updatedContent = await Bun.file(testFile).text();
    expect(updatedContent).toBe('Modified content\nSecond line\n');
  });

  test('processes XML whole files content correctly', async () => {
    const xmlContent = `
<code_changes>
<file>
<file_operation>CREATE</file_operation>
<file_path>test.txt</file_path>
<file_code>
Modified content
Second line
</file_code>
</file>
</code_changes>
`;

    const results = await applyEditsInternal({
      content: xmlContent,
      writeRoot: tempDir,
      dryRun: false,
      mode: 'xml',
    });

    expect(results).toBeUndefined(); // XML mode doesn't return results

    const fileContent = await Bun.file(path.join(tempDir, 'test.txt')).text();
    expect(fileContent).toBe('Modified content\nSecond line\n');
  });

  test('processes whole files content correctly', async () => {
    const wholeFileContent = `
\`\`\`
./test.txt
Modified content
Second line
\`\`\`
`;

    const results = await applyEditsInternal({
      content: wholeFileContent,
      writeRoot: tempDir,
      dryRun: false,
      mode: 'whole',
    });

    expect(results).toBeUndefined(); // Whole file mode doesn't return results

    const fileContent = await Bun.file(path.join(tempDir, 'test.txt')).text();
    expect(fileContent).toBe('Modified content\nSecond line\n');
  });

  test('auto-detects unified diff mode', async () => {
    const testFile = path.join(tempDir, 'test.txt');
    await writeFile(testFile, 'Original content\nSecond line\n');

    const diffContent = `
\`\`\`diff
--- test.txt
+++ test.txt
@@ -1,2 +1,2 @@
-Original content
+Modified content
 Second line
\`\`\`
`;

    const results = await applyEditsInternal({
      content: diffContent,
      writeRoot: tempDir,
      dryRun: false,
      mode: undefined, // Auto-detect
    });

    expect(results).toBeDefined();
    expect(results?.successes.length).toBeGreaterThan(0);

    const updatedContent = await Bun.file(testFile).text();
    expect(updatedContent).toBe('Modified content\nSecond line\n');
  });

  test('auto-detects search/replace diff mode', async () => {
    const testFile = path.join(tempDir, 'test.txt');
    await writeFile(testFile, 'Original content\nSecond line\n');

    const diffContent = `
test.txt
<<<<<<< SEARCH
Original content
=======
Modified content
>>>>>>> REPLACE
`;

    const results = await applyEditsInternal({
      content: diffContent,
      writeRoot: tempDir,
      dryRun: false,
      mode: undefined, // Auto-detect
    });

    expect(results).toBeDefined();
    expect(results?.successes.length).toBeGreaterThan(0);

    const updatedContent = await Bun.file(testFile).text();
    expect(updatedContent).toBe('Modified content\nSecond line\n');
  });

  test('auto-detects XML mode', async () => {
    const xmlContent = `
<code_changes>
<file>
<file_operation>CREATE</file_operation>
<file_path>test.txt</file_path>
<file_code>
Modified content
Second line
</file_code>
</file>
</code_changes>
`;

    const results = await applyEditsInternal({
      content: xmlContent,
      writeRoot: tempDir,
      dryRun: false,
      mode: undefined, // Auto-detect
    });

    expect(results).toBeUndefined(); // XML mode doesn't return results

    const fileContent = await Bun.file(path.join(tempDir, 'test.txt')).text();
    expect(fileContent).toBe('Modified content\nSecond line\n');
  });

  test('respects dry run mode', async () => {
    const testFile = path.join(tempDir, 'test.txt');
    await writeFile(testFile, 'Original content\nSecond line\n');

    const diffContent = `
\`\`\`diff
--- test.txt
+++ test.txt
@@ -1,2 +1,2 @@
-Original content
+Modified content
 Second line
\`\`\`
`;

    await applyEditsInternal({
      content: diffContent,
      writeRoot: tempDir,
      dryRun: true,
      mode: 'udiff',
    });

    // File should remain unchanged in dry run mode
    const updatedContent = await Bun.file(testFile).text();
    expect(updatedContent).toBe('Original content\nSecond line\n');
  });
});

describe('handleAutoApplyNotUnique', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('auto-applies edits when number of failures matches number of locations', async () => {
    // Create a test file with multiple instances of the same text
    const testFile = path.join(tempDir, 'test.txt');
    await writeFile(
      testFile,
      'Line with pattern\nSome other content\nLine with pattern\nSome other content\nLine with pattern\nSome other content\n'
    );

    // Create a diff that should match all three instances
    const diffContent = `
\`\`\`diff
--- test.txt
+++ test.txt
@@ -1 +1 @@
-Line with pattern
+Updated pattern
Some other content
\`\`\`
`;

    // Apply the diff which should result in "not unique" failures
    const initialResults = await applyEditsInternal({
      content: diffContent,
      writeRoot: tempDir,
      dryRun: true,
      mode: 'udiff',
    });

    // Verify we have the expected not unique failures
    expect(initialResults).toBeDefined();
    expect(initialResults?.failures.length).toBeGreaterThan(0);
    expect(initialResults?.failures.some((r) => r.type === 'notUnique')).toBe(true);

    // Now apply the same diff two more times to match the number of locations
    const diffContent2 = diffContent + '\n\n' + diffContent + '\n\n' + diffContent;
    const results = await applyEditsInternal({
      content: diffContent2,
      writeRoot: tempDir,
      dryRun: false,
      mode: 'udiff',
    });

    // Now they should all be successful because of the resolution.
    expect(results).toBeDefined();
    expect(results?.successes.length).toEqual(3);
    expect(results?.failures.length).toEqual(0);

    // Check that all instances were updated
    const updatedContent = await Bun.file(testFile).text();
    expect(updatedContent).toBe(
      'Updated pattern\nSome other content\nUpdated pattern\nSome other content\nUpdated pattern\nSome other content\n'
    );
  });
});

describe('applyLlmEdits', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('applies edits and returns results', async () => {
    const testFile = path.join(tempDir, 'test.txt');
    await writeFile(testFile, 'Original content\nSecond line\n');

    const diffContent = `
--- test.txt
+++ test.txt
@@ -1,2 +1,2 @@
-Original content
+Modified content
 Second line
`;

    const result = await applyLlmEdits({
      content: diffContent,
      writeRoot: tempDir,
      dryRun: false,
      mode: 'udiff',
      interactive: false,
    });

    expect(result).toBeDefined();
    expect(result?.successes.length).toBe(1);
    expect(result?.failures.length).toBe(0);

    const updatedContent = await Bun.file(testFile).text();
    expect(updatedContent).toBe('Modified content\nSecond line\n');
  });

  test('handles failures without interactive mode', async () => {
    const testFile = path.join(tempDir, 'test.txt');
    await writeFile(testFile, 'Different content\nSecond line\n');

    const diffContent = `
--- test.txt
+++ test.txt
@@ -1,2 +1,2 @@
-Original content
+Modified content
 Second line
`;

    // This should fail because the file content doesn't match the diff
    await expect(
      applyLlmEdits({
        content: diffContent,
        writeRoot: tempDir,
        dryRun: false,
        mode: 'udiff',
        interactive: false,
      })
    ).rejects.toThrow(/Failed to apply 1 edits/);
  });

  test('applies successful edits with --apply-partial despite failures', async () => {
    const testFile1 = path.join(tempDir, 'test1.txt');
    const testFile2 = path.join(tempDir, 'test2.txt');
    await writeFile(testFile1, 'Original content\nSecond line\n');
    await writeFile(testFile2, 'Different content\nSecond line\n');

    const diffContent = `
--- test1.txt
+++ test1.txt
@@ -1,2 +1,2 @@
-Original content
+Modified content
 Second line
--- test2.txt
+++ test2.txt
@@ -1,2 +1,2 @@
-Original content
+Modified content
 Second line
`;

    await expect(
      applyLlmEdits({
        content: diffContent,
        writeRoot: tempDir,
        dryRun: false,
        mode: 'udiff',
        interactive: false,
        applyPartial: true,
      })
    ).rejects.toThrow(/Failed to apply 1 edits/);

    const updatedContent1 = await Bun.file(testFile1).text();
    expect(updatedContent1).toBe('Modified content\nSecond line\n');
    const updatedContent2 = await Bun.file(testFile2).text();
    expect(updatedContent2).toBe('Different content\nSecond line\n');
  });

  test('prompts to apply successful edits in interactive mode', async () => {
    const testFile1 = path.join(tempDir, 'test1.txt');
    const testFile2 = path.join(tempDir, 'test2.txt');
    await writeFile(testFile1, 'Original content\nSecond line\n');
    await writeFile(testFile2, 'Different content\nSecond line\n');

    const diffContent = `
--- test1.txt
+++ test1.txt
@@ -1,2 +1,2 @@
-Original content
+Modified content
 Second line
--- test2.txt
+++ test2.txt
@@ -1,2 +1,2 @@
-Original content
+Modified content
 Second line
`;

    let calledConfirm = false;
    await mock.module('@inquirer/prompts', () => ({
      confirm: () => {
        calledConfirm = true;
        return Promise.resolve(true);
      },
      select: () => {
        return Promise.resolve(-1);
      },
    }));

    const result = await applyLlmEdits({
      content: diffContent,
      writeRoot: tempDir,
      dryRun: false,
      mode: 'udiff',
      interactive: true,
    });

    expect(result).toBeDefined();
    expect(result?.successes.length).toBe(1);
    expect(result?.failures.length).toBe(1);
    expect(calledConfirm).toBe(true);

    const updatedContent1 = await Bun.file(testFile1).text();
    expect(updatedContent1).toBe('Modified content\nSecond line\n');
    const updatedContent2 = await Bun.file(testFile2).text();
    expect(updatedContent2).toBe('Different content\nSecond line\n');
  });

  test('exits without applying edits in interactive mode if user declines', async () => {
    const testFile1 = path.join(tempDir, 'test1.txt');
    const testFile2 = path.join(tempDir, 'test2.txt');
    await writeFile(testFile1, 'Original content\nSecond line\n');
    await writeFile(testFile2, 'Different content\nSecond line\n');

    const diffContent = `
--- test1.txt
+++ test1.txt
@@ -1,2 +1,2 @@
-Original content
+Modified content
 Second line
--- test2.txt
+++ test2.txt
@@ -1,2 +1,2 @@
-Original content
+Modified content
 Second line
`;

    // Mock stdin to simulate user input 'n'
    let calledConfirm = false;
    await mock.module('@inquirer/prompts', () => ({
      confirm: () => {
        calledConfirm = true;
        return Promise.resolve(false);
      },
      select: () => {
        return Promise.resolve(-1);
      },
    }));

    const result = await applyLlmEdits({
      content: diffContent,
      writeRoot: tempDir,
      dryRun: false,
      mode: 'udiff',
      interactive: true,
    });

    expect(result).toBeUndefined();
    expect(calledConfirm).toBe(true);

    const updatedContent1 = await Bun.file(testFile1).text();
    expect(updatedContent1).toBe('Original content\nSecond line\n');
    const updatedContent2 = await Bun.file(testFile2).text();
    expect(updatedContent2).toBe('Different content\nSecond line\n');
  });

  test('attempts LLM retry when provided with llmRequester', async () => {
    const testFile = path.join(tempDir, 'test.txt');
    await writeFile(testFile, 'Different content\nSecond line\n');

    // Initial diff that will fail
    const diffContent = `
--- test.txt
+++ test.txt
@@ -1,2 +1,2 @@
-Original content
+Modified content
 Second line
`;

    // Mock LLM requester that returns a corrected diff
    const mockLlmRequester = mock(() => {
      return Promise.resolve(`
--- test.txt
+++ test.txt
@@ -1,2 +1,2 @@
-Different content
+Modified content
 Second line
`);
    });

    // Mock the original prompt
    const originalPrompt = 'Please modify test.txt';

    // Create a git-like directory structure for getOriginalRequestContext
    const gitDir = path.join(tempDir, '.git');
    await mkdir(gitDir, { recursive: true });

    const result = await applyLlmEdits({
      content: diffContent,
      writeRoot: tempDir,
      dryRun: false,
      mode: 'udiff',
      interactive: false,
      llmRequester: mockLlmRequester,
      originalPrompt,
      baseDir: tempDir,
      applyPartial: true,
    });

    expect(result).toBeDefined();
    expect(result?.successes.length).toBe(1);
    expect(result?.failures.length).toBe(0);
    expect(mockLlmRequester).toHaveBeenCalled();

    const updatedContent = await Bun.file(testFile).text();
    expect(updatedContent).toBe('Modified content\nSecond line\n');
  });
});

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

  test('throws when runRmfilterProgrammatically fails', async () => {
    // Don't create the output file, so it doesn't exist

    await mock.module('../rmfilter/rmfilter', () => ({
      runRmfilterProgrammatically: mock(() => Promise.reject(new Error('rmfilter error'))),
    }));

    const options = {
      content: '<rmfilter_command>--include "*.ts"</rmfilter_command>',
    };
    await expect(getOriginalRequestContext(options, tempDir, tempDir)).rejects.toThrow(
      'Failed to regenerate original rmfilter context by re-running command: --include *.ts'
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

describe('getWriteRoot', () => {
  test('returns provided cwd when specified', async () => {
    const testDir = '/test/dir';
    const result = await getWriteRoot(testDir);
    expect(result).toBe(testDir);
  });

  test('falls back to process.cwd() when no cwd provided and getGitRoot fails', async () => {
    // This test assumes getGitRoot will fail in the test environment
    // since we're not in a git repository
    const result = await getWriteRoot();
    expect(result).toBe(process.cwd());
  });
});
