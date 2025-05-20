import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';
import {
  extractRmfilterCommandArgs,
  applyEditsInternal,
  applyLlmEdits,
  getWriteRoot,
} from './apply';
import * as path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setDebug } from '../rmfilter/utils.ts';

// Helper function to create a temporary directory structure for testing
async function createTempTestDir() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'apply-llm-edits-test-'));
  return tempDir;
}

describe('extractRmfilterCommandArgs', () => {
  const responseContent = '<command_id>1234</command_id>';

  test('extracts command args from content with rmfilter_command tag', () => {
    const content = `
Some content here
<rmfilter_command>--include "*.ts" --exclude "node_modules"</rmfilter_command>
More content here
    `;

    const result = extractRmfilterCommandArgs(content, responseContent);
    expect(result).toEqual({
      commands: ['--include', '*.ts', '--exclude', 'node_modules'],
    });
  });

  test('returns null when no rmfilter_command tag is found', () => {
    const content = 'Some content without rmfilter_command tag';
    const result = extractRmfilterCommandArgs(content, responseContent);
    expect(result).toBeNull();
  });

  test('returns null when rmfilter_command tag is empty', () => {
    const content = '<rmfilter_command></rmfilter_command>';
    const result = extractRmfilterCommandArgs(content, responseContent);
    expect(result).toBeNull();
  });

  test('handles multiline command args', () => {
    const content = `
<rmfilter_command>
--include "*.ts" 
--exclude "node_modules"
</rmfilter_command>
    `;

    const result = extractRmfilterCommandArgs(content, responseContent);
    expect(result).toEqual({
      commands: ['--include', '*.ts', '--exclude', 'node_modules'],
    });
  });

  test('handles quoted arguments correctly', () => {
    const content =
      '<rmfilter_command>--include "src/**/*.ts" --exclude "test files"</rmfilter_command>';
    const result = extractRmfilterCommandArgs(content, responseContent);
    expect(result).toEqual({
      commands: ['--include', 'src/**/*.ts', '--exclude', 'test files'],
    });
  });

  test('handles escaped quotes inside quoted strings', () => {
    const content =
      '<rmfilter_command>--include "src/**/*.ts" --message "This is a \\"quoted\\" message"</rmfilter_command>';
    const result = extractRmfilterCommandArgs(content, responseContent);
    expect(result).toEqual({
      commands: ['--include', 'src/**/*.ts', '--message', 'This is a "quoted" message'],
    });
  });

  test('handles single quotes', () => {
    const content =
      "<rmfilter_command>--include '*.ts' --exclude 'node_modules'</rmfilter_command>";
    const result = extractRmfilterCommandArgs(content, responseContent);
    expect(result).toEqual({
      commands: ['--include', '*.ts', '--exclude', 'node_modules'],
    });
  });

  test('returns only first rmfilter_command tag when multiple exist', () => {
    const content = `
<rmfilter_command>--include "*.ts"</rmfilter_command>
Some content in between
<rmfilter_command>--exclude "node_modules"</rmfilter_command>
    `;

    const result = extractRmfilterCommandArgs(content, responseContent);
    expect(result).toEqual({
      commands: ['--include', '*.ts'],
    });
  });

  test('handles whitespace-only content in rmfilter_command tag', () => {
    const content = '<rmfilter_command>   </rmfilter_command>';
    const result = extractRmfilterCommandArgs(content, responseContent);
    expect(result).toBeNull();
  });

  test('returns promptMessage when command IDs mismatch', () => {
    const content = `
<command_id>1234</command_id>
<rmfilter_command>--include "*.ts"</rmfilter_command>
    `;
    const responseContent = `
<command_id>5678</command_id>
<rmfilter_command>--include "*.ts"</rmfilter_command>
    `;

    const result = extractRmfilterCommandArgs(content, responseContent);
    expect(result).toEqual({
      commands: ['--include', '*.ts'],
      promptMessage: "The saved command file ID does not match the response's ID. Continue anyway?",
    });
  });

  test('returns promptMessage when response lacks command ID', () => {
    const content = `
<command_id>1234</command_id>
<rmfilter_command>--include "*.ts"</rmfilter_command>
    `;
    const responseContent = `
<rmfilter_command>--include "*.ts"</rmfilter_command>
    `;

    const result = extractRmfilterCommandArgs(content, responseContent);
    expect(result).toEqual({
      commands: ['--include', '*.ts'],
      promptMessage: 'The response does not contain a command file ID. Continue anyway?',
    });
  });

  test('includes instructions in command string', () => {
    const content = `
<command_id>1234</command_id>
<rmfilter_instructions>Update all TypeScript files</rmfilter_instructions>
<rmfilter_command>--include "*.ts"</rmfilter_command>
    `;

    const result = extractRmfilterCommandArgs(content, responseContent);
    expect(result).toEqual({
      commands: ['--include', '*.ts', '--instructions', 'Update all TypeScript files'],
    });
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
    expect(result?.appliedSuccesses.length).toBe(1);
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

    expect(result?.appliedSuccesses).toHaveLength(0);
    expect(result?.remainingSuccesses).toHaveLength(1);
    expect(result?.failures).toHaveLength(1);
    expect(calledConfirm).toBe(true);

    const updatedContent1 = await Bun.file(testFile1).text();
    expect(updatedContent1).toBe('Original content\nSecond line\n');
    const updatedContent2 = await Bun.file(testFile2).text();
    expect(updatedContent2).toBe('Different content\nSecond line\n');
  });

  test('attempts LLM retry when provided with retryRequester', async () => {
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
    const mockRetryRequester = mock(() => {
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
      retryRequester: mockRetryRequester,
      originalPrompt,
      baseDir: tempDir,
      applyPartial: true,
    });

    expect(result).toBeDefined();
    expect(result?.appliedSuccesses.length).toBe(1);
    expect(result?.failures.length).toBe(0);
    expect(mockRetryRequester).toHaveBeenCalled();

    const updatedContent = await Bun.file(testFile).text();
    expect(updatedContent).toBe('Modified content\nSecond line\n');
  });

  test('applies success-only files first and retries with missing successes', async () => {
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

    // Mock LLM requester that omits the successful edit for test1.txt
    const mockRetryRequester = mock(() => {
      return Promise.resolve(`
--- test2.txt
+++ test2.txt
@@ -1,2 +1,2 @@
-Different content
+Modified content
 Second line
`);
    });

    const originalPrompt = 'Please modify test1.txt and test2.txt';
    // setDebug(true);

    const result = await applyLlmEdits({
      content: diffContent,
      writeRoot: tempDir,
      dryRun: false,
      mode: 'udiff',
      interactive: false,
      retryRequester: mockRetryRequester,
      originalPrompt,
      baseDir: tempDir,
      applyPartial: true,
    });

    const updatedContent1 = await Bun.file(testFile1).text();
    expect(updatedContent1).toBe('Modified content\nSecond line\n');
    const updatedContent2 = await Bun.file(testFile2).text();
    expect(updatedContent2).toBe('Modified content\nSecond line\n');

    expect(result).toBeDefined();
    expect(result?.appliedSuccesses.length).toBe(2); // Both files should be updated
    expect(result?.failures.length).toBe(0);
    expect(mockRetryRequester).toHaveBeenCalled();
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
