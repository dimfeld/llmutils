import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import * as glob from 'fast-glob';
import * as os from 'node:os';
import path from 'node:path';
import { getAdditionalDocs } from './additional_docs';
import type { MdcFile } from './mdc';

// Mock dependencies
vi.mock('fast-glob');
vi.mock('node:os');

// Helper to mock Bun.file().text()
const mockFiles: Record<string, string> = {};
const originalBunFile = Bun.file;

beforeEach(() => {
  // Reset mocks and mockFiles before each test
  vi.resetAllMocks();
  for (const key in mockFiles) {
    delete mockFiles[key];
  }

  // Mock Bun.file
  vi.spyOn(Bun, 'file').mockImplementation((filePath: string | URL | Bun.PathLike) => {
    const normalizedPath = path.resolve(filePath.toString());
    // console.log(`Mock Bun.file called for: ${normalizedPath}`); // Debugging
    if (mockFiles[normalizedPath]) {
      return {
        text: vi.fn().mockResolvedValue(mockFiles[normalizedPath]),
        // Add other BunFile methods if needed, mocked appropriately
        exists: vi.fn().mockResolvedValue(true),
        size: mockFiles[normalizedPath].length,
        type: 'text/plain',
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
        stream: vi.fn().mockReturnValue(new ReadableStream()),
        slice: vi.fn(),
        writer: vi.fn(),
        // Add any other methods/properties your code might use
      } as unknown as Bun.BunFile; // Type assertion needed for mocking
    } else {
      // Simulate file not found
      const error = new Error(`ENOENT: no such file or directory, open '${normalizedPath}'`);
      (error as any).code = 'ENOENT';
      // console.error(`Mock Bun.file: File not found - ${normalizedPath}`); // Debugging
      // Mock methods to throw or return appropriate values for non-existent files
      return {
          text: vi.fn().mockRejectedValue(error),
          exists: vi.fn().mockResolvedValue(false),
          size: 0,
          // ... other methods potentially returning errors or empty values
      } as unknown as Bun.BunFile;
    }
  });

  // Mock os.homedir
  vi.spyOn(os, 'homedir').mockReturnValue('/fake/home');
});

afterEach(() => {
  // Restore original Bun.file implementation
  vi.restoreAllMocks();
});

const baseDir = '/project/root';

describe('getAdditionalDocs', () => {
  // --- Manual --docs Tests ---
  it('should format a single --docs file correctly', async () => {
    vi.spyOn(glob, 'glob').mockResolvedValue(['/project/root/manual_doc.md']);
    mockFiles['/project/root/manual_doc.md'] = 'Manual doc content.';

    const result = await getAdditionalDocs(baseDir, { docs: ['manual_doc.md'] });

    expect(result.docsTag).toBe(
      '<documents>\n<document><![CDATA[\nManual doc content.\n]]></document>\n</documents>'
    );
    expect(result.rulesTag).toBe('');
  });

  it('should format multiple --docs files correctly', async () => {
    vi.spyOn(glob, 'glob').mockResolvedValue(['/project/root/doc1.md', '/project/root/doc2.md']);
    mockFiles['/project/root/doc1.md'] = 'Doc 1';
    mockFiles['/project/root/doc2.md'] = 'Doc 2';

    const result = await getAdditionalDocs(baseDir, { docs: ['*.md'] });

    expect(result.docsTag).toBe(
      '<documents>\n<document><![CDATA[\nDoc 1\n]]></document>\n<document><![CDATA[\nDoc 2\n]]></document>\n</documents>'
    );
  });

  // --- Manual --rules Tests ---
  it('should format a single --rules file correctly', async () => {
    vi.spyOn(glob, 'glob').mockResolvedValue(['/project/root/manual_rule.txt']);
    mockFiles['/project/root/manual_rule.txt'] = 'Manual rule content.';

    const result = await getAdditionalDocs(baseDir, { rules: ['manual_rule.txt'] });

    expect(result.rulesTag).toBe(
      '<rules>\n<rule><![CDATA[\nManual rule content.\n]]></rule>\n</rules>'
    );
    expect(result.docsTag).toBe('');
  });

   it('should format multiple --rules files correctly', async () => {
    vi.spyOn(glob, 'glob').mockResolvedValue(['/project/root/rule1.txt', '/project/root/rule2.txt']);
    mockFiles['/project/root/rule1.txt'] = 'Rule 1';
    mockFiles['/project/root/rule2.txt'] = 'Rule 2';

    const result = await getAdditionalDocs(baseDir, { rules: ['*.txt'] });

    expect(result.rulesTag).toBe(
      '<rules>\n<rule><![CDATA[\nRule 1\n]]></rule>\n<rule><![CDATA[\nRule 2\n]]></rule>\n</rules>'
    );
  });

  it('should handle ~/ path expansion for --rules', async () => {
    const rulePath = '/fake/home/my_rules.txt';
    vi.spyOn(glob, 'glob').mockResolvedValue([rulePath]);
    mockFiles[rulePath] = 'Home rule content.';

    const result = await getAdditionalDocs(baseDir, { rules: ['~/my_rules.txt'] });

    expect(glob.glob).toHaveBeenCalledWith(rulePath); // Check if path was expanded correctly before glob
    expect(result.rulesTag).toBe(
      '<rules>\n<rule><![CDATA[\nHome rule content.\n]]></rule>\n</rules>'
    );
  });

  it('should include .cursorrules by default', async () => {
    const cursorRulesPath = path.join(baseDir, '.cursorrules');
    mockFiles[cursorRulesPath] = 'Cursor rule content.';
    vi.spyOn(glob, 'glob').mockResolvedValue([]); // No manual --rules

    const result = await getAdditionalDocs(baseDir, {});

    expect(result.rulesTag).toBe(
      '<rules>\n<rule><![CDATA[\nCursor rule content.\n]]></rule>\n</rules>'
    );
  });

   it('should omit .cursorrules when --omit-cursorrules is true', async () => {
    const cursorRulesPath = path.join(baseDir, '.cursorrules');
    mockFiles[cursorRulesPath] = 'Cursor rule content.';
    vi.spyOn(glob, 'glob').mockResolvedValue([]); // No manual --rules

    const result = await getAdditionalDocs(baseDir, { 'omit-cursorrules': true });

    expect(result.rulesTag).toBe('');
  });

  // --- MDC Integration Tests ---
  const mockMdcDoc: MdcFile = {
    filePath: '/project/root/.cursor/rules/doc_rule.mdc',
    content: 'MDC Doc Content',
    data: { type: 'docs', description: 'An MDC Document' },
  };
  const mockMdcRule: MdcFile = {
    filePath: '/project/root/.cursor/rules/style_rule.mdc',
    content: 'MDC Rule Content',
    data: { type: 'rules', description: 'An MDC Rule with "quotes"' },
  };
   const mockMdcDefaultType: MdcFile = {
    filePath: '/project/root/.cursor/rules/default_doc.mdc',
    content: 'MDC Default Type Content',
    data: { description: 'Default type is doc' }, // No type specified
  };
   const mockMdcNoDesc: MdcFile = {
    filePath: '/project/root/.cursor/rules/no_desc.mdc',
    content: 'MDC No Description Content',
    data: { type: 'docs' }, // No description
  };

  it('should include MDC file with type "docs" and description', async () => {
    const result = await getAdditionalDocs(baseDir, {}, [mockMdcDoc]);
    expect(result.docsTag).toBe(
      '<documents>\n<document description="An MDC Document"><![CDATA[\nMDC Doc Content\n]]></document>\n</documents>'
    );
    expect(result.rulesTag).toBe('');
  });

  it('should include MDC file with type "rules" and description (with escaped quotes)', async () => {
    const result = await getAdditionalDocs(baseDir, {}, [mockMdcRule]);
    expect(result.rulesTag).toBe(
      '<rules>\n<rule description="An MDC Rule with &quot;quotes&quot;"><![CDATA[\nMDC Rule Content\n]]></rule>\n</rules>'
    );
     expect(result.docsTag).toBe('');
  });

  it('should default MDC file type to "docs" if missing', async () => {
    const result = await getAdditionalDocs(baseDir, {}, [mockMdcDefaultType]);
    expect(result.docsTag).toBe(
      '<documents>\n<document description="Default type is doc"><![CDATA[\nMDC Default Type Content\n]]></document>\n</documents>'
    );
  });

  it('should handle MDC file with missing description', async () => {
    const result = await getAdditionalDocs(baseDir, {}, [mockMdcNoDesc]);
    expect(result.docsTag).toBe(
      '<documents>\n<document><![CDATA[\nMDC No Description Content\n]]></document>\n</documents>'
    );
  });

  // --- Combined Manual and MDC Tests ---
  it('should combine manual --docs and MDC docs', async () => {
    vi.spyOn(glob, 'glob').mockResolvedValue(['/project/root/manual_doc.md']);
    mockFiles['/project/root/manual_doc.md'] = 'Manual doc.';

    const result = await getAdditionalDocs(baseDir, { docs: ['manual_doc.md'] }, [mockMdcDoc, mockMdcDefaultType]);

    expect(result.docsTag).toBe(
      '<documents>\n' +
      '<document><![CDATA[\nManual doc.\n]]></document>\n' +
      '<document description="An MDC Document"><![CDATA[\nMDC Doc Content\n]]></document>\n' +
      '<document description="Default type is doc"><![CDATA[\nMDC Default Type Content\n]]></document>\n' +
      '</documents>'
    );
  });

  it('should combine manual --rules, .cursorrules, and MDC rules', async () => {
    const cursorRulesPath = path.join(baseDir, '.cursorrules');
    mockFiles[cursorRulesPath] = 'Cursor rule.';
    vi.spyOn(glob, 'glob').mockResolvedValue(['/project/root/manual_rule.txt']);
    mockFiles['/project/root/manual_rule.txt'] = 'Manual rule.';

    const result = await getAdditionalDocs(baseDir, { rules: ['manual_rule.txt'] }, [mockMdcRule]);

    expect(result.rulesTag).toBe(
      '<rules>\n' +
      '<rule><![CDATA[\nManual rule.\n]]></rule>\n' + // Manual rule first
      '<rule><![CDATA[\nCursor rule.\n]]></rule>\n' + // Then .cursorrules
      '<rule description="An MDC Rule with &quot;quotes&quot;"><![CDATA[\nMDC Rule Content\n]]></rule>\n' + // Then MDC rule
      '</rules>'
    );
  });

  // --- Empty/No Input Tests ---
  it('should return empty tags when no docs, rules, or MDCs are provided', async () => {
     vi.spyOn(glob, 'glob').mockResolvedValue([]);
     const result = await getAdditionalDocs(baseDir, {}, []);
     expect(result.docsTag).toBe('');
     expect(result.rulesTag).toBe('');
     expect(result.instructionsTag).toBe('');
  });

  it('should handle empty filteredMdcFiles array', async () => {
    vi.spyOn(glob, 'glob').mockResolvedValue(['/project/root/manual_doc.md']);
    mockFiles['/project/root/manual_doc.md'] = 'Manual doc content.';

    const result = await getAdditionalDocs(baseDir, { docs: ['manual_doc.md'] }, []); // Pass empty array

    expect(result.docsTag).toBe(
      '<documents>\n<document><![CDATA[\nManual doc content.\n]]></document>\n</documents>'
    );
    expect(result.rulesTag).toBe('');
  });
});

