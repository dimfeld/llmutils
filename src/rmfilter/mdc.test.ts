import { beforeEach, afterEach, describe, it, expect, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseMdcFile, findMdcFiles } from './mdc';
import { filterMdcFiles, type MdcFile } from './mdc'; // Import filterMdcFiles and MdcFile type
import { setDebug } from './utils'; // To potentially enable debug logging in tests

describe('MDC Utilities', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a unique temporary directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmfilter-mdc-test-'));
  });

  afterEach(() => {
    // Clean up the temporary directory
    fs.rmSync(tempDir, { recursive: true, force: true });
    // setDebug(false); // Ensure debug is off after tests
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

  describe('filterMdcFiles', () => {
    let gitRoot: string;
    let sourceFilesDir: string;
    let activeSourceFilesAbs: string[];
    let activeSourceFilesRel: string[];
    let mdcFiles: MdcFile[];

    beforeEach(async () => {
      gitRoot = path.resolve(tempDir, 'project');
      sourceFilesDir = path.resolve(gitRoot, 'src');
      fs.mkdirSync(sourceFilesDir, { recursive: true });

      // Create dummy source files
      const file1Path = path.join(sourceFilesDir, 'file1.ts');
      const file2Path = path.join(sourceFilesDir, 'file2.js');
      const file3Path = path.join(gitRoot, 'config.json'); // File outside 'src'
      await Bun.write(file1Path, 'console.log("hello world");\n// TODO: Implement feature');
      await Bun.write(file2Path, 'function oldFunc() { /* FIXME */ }');
      await Bun.write(file3Path, '{ "setting": "value" }');

      activeSourceFilesAbs = [file1Path, file2Path, file3Path];
      // Pre-calculate relative paths for easier assertion/debugging if needed
      activeSourceFilesRel = activeSourceFilesAbs.map((absPath) =>
        path.relative(gitRoot, absPath).replace(/\\/g, '/')
      );
      // console.log("Git Root:", gitRoot);
      // console.log("Active Source Files (Abs):", activeSourceFilesAbs);
      // console.log("Active Source Files (Rel):", activeSourceFilesRel);

      // Create dummy MdcFile objects
      mdcFiles = [
        {
          // 1. Default include (no rules)
          filePath: path.resolve(gitRoot, '.cursor/rules/default.mdc'),
          content: 'Default rule content.',
          data: { description: 'Default' },
        },
        {
          // 2. Glob match (ts files in src)
          filePath: path.resolve(gitRoot, '.cursor/rules/typescript.mdc'),
          content: 'TS rules.',
          data: { description: 'TS Globs', globs: 'src/**/*.ts' },
        },
        {
          // 3. Glob match (js files) - array input
          filePath: path.resolve(gitRoot, '.cursor/rules/javascript.mdc'),
          content: 'JS rules.',
          data: { description: 'JS Globs', globs: ['*.js', 'src/*.js'] },
        },
        {
          // 4. Glob miss (md files)
          filePath: path.resolve(gitRoot, '.cursor/rules/markdown.mdc'),
          content: 'MD rules.',
          data: { description: 'MD Globs', globs: '**/*.md' },
        },
        {
          // 5. Grep match (TODO - case insensitive)
          filePath: path.resolve(gitRoot, '.cursor/rules/todos.mdc'),
          content: 'Todo tracking.',
          data: { description: 'TODO Grep', grep: 'todo' },
        },
        {
          // 6. Grep match (FIXME - case sensitive in term, but search is insensitive) - array input
          filePath: path.resolve(gitRoot, '.cursor/rules/fixmes.mdc'),
          content: 'Fixme tracking.',
          data: { description: 'FIXME Grep', grep: ['FIXME', 'HACK'] },
        },
        {
          // 7. Grep miss (BUG)
          filePath: path.resolve(gitRoot, '.cursor/rules/bugs.mdc'),
          content: 'Bug tracking.',
          data: { description: 'BUG Grep', grep: 'BUG' },
        },
        {
          // 8. Glob miss, Grep match (setting)
          filePath: path.resolve(gitRoot, '.cursor/rules/config_setting.mdc'),
          content: 'Config setting rule.',
          data: { description: 'Config Grep', globs: '*.yaml', grep: 'setting' },
        },
        {
          // 9. Glob match, Grep miss (json files, grep for missing_term)
          filePath: path.resolve(gitRoot, '.cursor/rules/json_files.mdc'),
          content: 'JSON file rule.',
          data: { description: 'JSON Glob', globs: '*.json', grep: 'missing_term' },
        },
        {
          // 10. Empty/Whitespace rules (should be default include)
          filePath: path.resolve(gitRoot, '.cursor/rules/empty.mdc'),
          content: 'Empty rule content.',
          data: { description: 'Empty Rules', globs: [' '], grep: '' },
        },
        {
          // 11. Only whitespace in array (should be default include)
          filePath: path.resolve(gitRoot, '.cursor/rules/whitespace.mdc'),
          content: 'Whitespace rule content.',
          data: { description: 'Whitespace Rules', globs: [' ', '  '], grep: ['\t'] },
        },
        {
          // 12. Glob match in root dir
          filePath: path.resolve(gitRoot, '.cursor/rules/root_json.mdc'),
          content: 'Root JSON rule.',
          data: { description: 'Root JSON Glob', globs: '*.json' },
        },
      ];
    });

    it('should include files with no rules (default)', async () => {
      const filtered = await filterMdcFiles([mdcFiles[0]], activeSourceFilesAbs, gitRoot);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].filePath).toBe(mdcFiles[0].filePath);
    });

    it('should include files with empty/whitespace rules (default)', async () => {
      const filtered = await filterMdcFiles(
        [mdcFiles[9], mdcFiles[10]],
        activeSourceFilesAbs,
        gitRoot
      ); // Indices 9 and 10
      expect(filtered).toHaveLength(2);
      expect(filtered.map((f) => f.filePath)).toEqual(
        expect.arrayContaining([mdcFiles[9].filePath, mdcFiles[10].filePath])
      );
    });

    it('should include files matching glob patterns', async () => {
      const filtered = await filterMdcFiles(
        [mdcFiles[1], mdcFiles[2]],
        activeSourceFilesAbs,
        gitRoot
      );
      expect(filtered).toHaveLength(2);
      // console.log("Filtered (Glob):", filtered.map(f => f.filePath));
      expect(filtered.map((f) => f.filePath)).toEqual(
        expect.arrayContaining([mdcFiles[1].filePath, mdcFiles[2].filePath])
      );
    });

    it('should not include files where globs do not match', async () => {
      const filtered = await filterMdcFiles([mdcFiles[3]], activeSourceFilesAbs, gitRoot);
      expect(filtered).toHaveLength(0);
    });

    it('should include files matching grep terms (case-insensitive)', async () => {
      const filtered = await filterMdcFiles(
        [mdcFiles[4], mdcFiles[5]],
        activeSourceFilesAbs,
        gitRoot
      );
      expect(filtered).toHaveLength(2);
      // console.log("Filtered (Grep):", filtered.map(f => f.filePath));
      expect(filtered.map((f) => f.filePath)).toEqual(
        expect.arrayContaining([mdcFiles[4].filePath, mdcFiles[5].filePath])
      );
    });

    it('should not include files where grep terms do not match', async () => {
      const filtered = await filterMdcFiles([mdcFiles[6]], activeSourceFilesAbs, gitRoot);
      expect(filtered).toHaveLength(0);
    });

    it('should exclude files if glob misses but grep matches', async () => {
      const filtered = await filterMdcFiles([mdcFiles[7]], activeSourceFilesAbs, gitRoot);
      expect(filtered).toHaveLength(0);
    });

    it('should exclude files if glob matches but grep misses', async () => {
      const filtered = await filterMdcFiles([mdcFiles[8]], activeSourceFilesAbs, gitRoot);
      expect(filtered).toHaveLength(0);
    });

    it('should handle a mix of matching and non-matching files correctly', async () => {
      const filtered = await filterMdcFiles(mdcFiles, activeSourceFilesAbs, gitRoot);
      console.log({ filtered });
      const expectedPaths = [
        mdcFiles[0].filePath, // Default
        mdcFiles[1].filePath, // Glob match (ts)
        mdcFiles[2].filePath, // Glob match (js)
        // mdcFiles[3] excluded (glob miss)
        mdcFiles[4].filePath, // Grep match (todo)
        mdcFiles[5].filePath, // Grep match (FIXME)
        // mdcFiles[6] excluded (grep miss)
        // mdcFiles[7].filePath, // Glob miss, Grep match (setting)
        // mdcFiles[8].filePath, // Glob match, Grep miss (json)
        mdcFiles[9].filePath, // Default (empty rules)
        mdcFiles[10].filePath, // Default (whitespace rules)
        mdcFiles[11].filePath, // Glob match (root json)
      ];
      expect(filtered).toHaveLength(expectedPaths.length);
      expect(filtered.map((f) => f.filePath)).toEqual(expect.arrayContaining(expectedPaths));
    });

    it('should return empty array if no mdc files are provided', async () => {
      const filtered = await filterMdcFiles([], activeSourceFilesAbs, gitRoot);
      expect(filtered).toEqual([]);
    });

    it('should return empty array if no active source files are provided (and no default includes)', async () => {
      // Filter out the default includes (index 0, 9, 10)
      const nonDefaultMdcs = mdcFiles.filter((_, index) => ![0, 9, 10].includes(index));
      const filtered = await filterMdcFiles(nonDefaultMdcs, [], gitRoot);
      expect(filtered).toEqual([]);
    });

    it('should return only default includes if no active source files are provided', async () => {
      const filtered = await filterMdcFiles(mdcFiles, [], gitRoot);
      expect(filtered.map((f) => f.filePath)).toEqual(
        expect.arrayContaining([mdcFiles[0].filePath, mdcFiles[9].filePath, mdcFiles[10].filePath])
      );
    });
  });
});
