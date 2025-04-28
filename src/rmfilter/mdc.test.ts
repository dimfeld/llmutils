import { beforeEach, afterEach, describe, it, expect, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseMdcFile, findMdcFiles } from './mdc';

describe('MDC Utilities', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a unique temporary directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmfilter-mdc-test-'));
  });

  afterEach(() => {
    // Clean up the temporary directory
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks(); // Restore any mocks
  });

  describe('parseMdcFile', () => {
    it('should parse a valid MDC file with all fields', async () => {
      const filePath = path.join(tempDir, 'valid.mdc');
      const fileContent = `---
description: Test Description
globs: ["src/**/*.ts", "*.js"]
grep: ["TODO", "FIXME"]
type: rules
name: MyRule
extra: metadata
---
This is the rule content.
`;
      await Bun.write(filePath, fileContent);

      const result = await parseMdcFile(filePath);

      expect(result).not.toBeNull();
      expect(result?.filePath).toBe(path.resolve(filePath));
      expect(result?.content).toBe('This is the rule content.');
      expect(result?.data).toEqual({
        description: 'Test Description',
        globs: ['src/**/*.ts', '*.js'],
        grep: ['TODO', 'FIXME'],
        type: 'rules',
        name: 'MyRule',
        extra: 'metadata',
      });
    });

    it('should parse a file with minimal frontmatter (only description)', async () => {
      const filePath = path.join(tempDir, 'minimal.mdc');
      const fileContent = `---
description: Minimal
---
Minimal content.
`;
      await Bun.write(filePath, fileContent);

      const result = await parseMdcFile(filePath);

      expect(result).not.toBeNull();
      expect(result?.filePath).toBe(path.resolve(filePath));
      expect(result?.content).toBe('Minimal content.');
      expect(result?.data).toEqual({ description: 'Minimal' });
    });

    it('should parse a file with no frontmatter', async () => {
      const filePath = path.join(tempDir, 'no-frontmatter.mdc');
      const fileContent = `Just content here.`;
      await Bun.write(filePath, fileContent);

      // gray-matter returns empty data object and full content if no frontmatter fences are found
      const result = await parseMdcFile(filePath);

      expect(result).not.toBeNull(); // It should still parse successfully
      expect(result?.filePath).toBe(path.resolve(filePath));
      expect(result?.content).toBe('Just content here.');
      expect(result?.data).toEqual({}); // Expect an empty data object
    });

    it('should handle non-existent file path', async () => {
      const filePath = path.join(tempDir, 'nonexistent.mdc');
      // Bun.file().text() throws if file doesn't exist
      const result = await parseMdcFile(filePath);
      expect(result).toBeNull();
    });

    it('should handle invalid YAML frontmatter', async () => {
      const filePath = path.join(tempDir, 'invalid-yaml.mdc');
      const fileContent = `---
invalid: yaml: here
---
Content.
`;
      await Bun.write(filePath, fileContent);

      // gray-matter might throw or return malformed data depending on invalidity
      // Our wrapper should catch this and return null
      const result = await parseMdcFile(filePath);
      expect(result).toBeNull();
    });

     it('should handle empty file', async () => {
      const filePath = path.join(tempDir, 'empty.mdc');
      await Bun.write(filePath, '');

      const result = await parseMdcFile(filePath);
      expect(result).not.toBeNull();
      expect(result?.filePath).toBe(path.resolve(filePath));
      expect(result?.content).toBe('');
      expect(result?.data).toEqual({});
    });
  });

  describe('findMdcFiles', () => {
    let mockGitRoot: string;
    let mockHomeDir: string;
    let projectRulesDir: string;
    let userRulesDir: string;

    beforeEach(() => {
      mockGitRoot = path.join(tempDir, 'project');
      mockHomeDir = path.join(tempDir, 'home');
      projectRulesDir = path.join(mockGitRoot, '.cursor', 'rules');
      userRulesDir = path.join(mockHomeDir, '.config', 'rmfilter', 'rules');

      fs.mkdirSync(mockGitRoot, { recursive: true });
      fs.mkdirSync(mockHomeDir, { recursive: true });

      // Mock os.homedir()
      vi.spyOn(os, 'homedir').mockReturnValue(mockHomeDir);
    });

    it('should find files in both project and user locations, including nested', async () => {
      fs.mkdirSync(projectRulesDir, { recursive: true });
      fs.mkdirSync(path.join(projectRulesDir, 'subdir'), { recursive: true });
      fs.mkdirSync(userRulesDir, { recursive: true });

      const file1 = path.join(projectRulesDir, 'rule1.mdc');
      const file2 = path.join(projectRulesDir, 'subdir', 'rule2.mdc');
      const file3 = path.join(userRulesDir, 'user_rule.mdc');
      await Bun.write(file1, 'content1');
      await Bun.write(file2, 'content2');
      await Bun.write(file3, 'content3');

      const result = await findMdcFiles(mockGitRoot);
      expect(result).toHaveLength(3);
      expect(result).toContain(path.resolve(file1));
      expect(result).toContain(path.resolve(file2));
      expect(result).toContain(path.resolve(file3));
    });

    it('should handle case where project rules directory does not exist', async () => {
      fs.mkdirSync(userRulesDir, { recursive: true });
      const file3 = path.join(userRulesDir, 'user_rule.mdc');
      await Bun.write(file3, 'content3');

      const result = await findMdcFiles(mockGitRoot);
      expect(result).toHaveLength(1);
      expect(result).toContain(path.resolve(file3));
    });

    it('should handle case where user rules directory does not exist', async () => {
      fs.mkdirSync(projectRulesDir, { recursive: true });
      const file1 = path.join(projectRulesDir, 'rule1.mdc');
      await Bun.write(file1, 'content1');

      const result = await findMdcFiles(mockGitRoot);
      expect(result).toHaveLength(1);
      expect(result).toContain(path.resolve(file1));
    });

    it('should return an empty array if no .mdc files are found', async () => {
      fs.mkdirSync(projectRulesDir, { recursive: true });
      fs.mkdirSync(userRulesDir, { recursive: true });
      // No files written

      const result = await findMdcFiles(mockGitRoot);
      expect(result).toEqual([]);
    });

    it('should return an empty array if neither rules directory exists', async () => {
      // Directories are not created
      const result = await findMdcFiles(mockGitRoot);
      expect(result).toEqual([]);
    });
  });
});
