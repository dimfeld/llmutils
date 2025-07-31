import { describe, it, expect, beforeEach, afterEach, jest, spyOn } from 'bun:test';
import * as glob from 'fast-glob';
import * as os from 'node:os';
import path from 'node:path';
import { gatherDocsInternal } from './additional_docs';
import type { MdcFile } from './mdc';

import { parseJjRename } from './additional_docs';

// Helper to mock Bun.file().text()
const mockFiles: Record<string, string> = {};

beforeEach(() => {
  // Reset mocks and mockFiles before each test
  jest.clearAllMocks();
  for (const key in mockFiles) {
    delete mockFiles[key];
  }

  // Mock Bun.file
  jest.spyOn(Bun, 'file').mockImplementation((filePath: string | URL | Bun.PathLike) => {
    const normalizedPath = path.resolve(filePath.toString());
    // console.log(`Mock Bun.file called for: ${normalizedPath}`); // Debugging
    if (mockFiles[normalizedPath]) {
      return {
        text: jest.fn().mockResolvedValue(mockFiles[normalizedPath]),
        // Add other BunFile methods if needed, mocked appropriately
        exists: jest.fn().mockResolvedValue(true),
        size: mockFiles[normalizedPath].length,
        type: 'text/plain',
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
        stream: jest.fn().mockReturnValue(new ReadableStream()),
        slice: jest.fn(),
        writer: jest.fn(),
        // Add any other methods/properties your code might use
      } as unknown as Bun.BunFile; // Type assertion needed for mocking
    } else {
      // Simulate file not found
      const error = new Error(`ENOENT: no such file or directory, open '${normalizedPath}'`);
      (error as any).code = 'ENOENT';
      // console.error(`Mock Bun.file: File not found - ${normalizedPath}`); // Debugging
      // Mock methods to throw or return appropriate values for non-existent files
      return {
        text: jest.fn().mockRejectedValue(error),
        exists: jest.fn().mockResolvedValue(false),
        size: 0,
        // ... other methods potentially returning errors or empty values
      } as unknown as Bun.BunFile;
    }
  });

  // Mock os.homedir
  jest.spyOn(os, 'homedir').mockReturnValue('/fake/home');
});

afterEach(() => {
  // Restore original Bun.file implementation
  jest.restoreAllMocks();
});

const baseDir = '/project/root';

describe('getAdditionalDocs', () => {
  // --- Manual --docs Tests ---
  it('should format a single --docs file correctly', async () => {
    jest.spyOn(glob, 'glob').mockResolvedValue(['/project/root/manual_doc.md']);
    mockFiles['/project/root/manual_doc.md'] = 'Manual doc content.';

    const result = await gatherDocsInternal(baseDir, { docs: ['manual_doc.md'] });

    expect(result.docsTag).toBe(
      '<documents>\n<document filename="../../../../../project/root/manual_doc.md"><![CDATA[\nManual doc content.\n]]></document>\n</documents>'
    );
    expect(result.rulesTag).toBe('');
  });

  it('should format multiple --docs files correctly', async () => {
    jest.spyOn(glob, 'glob').mockResolvedValue(['/project/root/doc1.md', '/project/root/doc2.md']);
    mockFiles['/project/root/doc1.md'] = 'Doc 1';
    mockFiles['/project/root/doc2.md'] = 'Doc 2';

    const result = await gatherDocsInternal(baseDir, { docs: ['*.md'] });

    expect(result.docsTag).toBe(
      '<documents>\n<document filename="../../../../../project/root/doc1.md"><![CDATA[\nDoc 1\n]]></document>\n<document filename="../../../../../project/root/doc2.md"><![CDATA[\nDoc 2\n]]></document>\n</documents>'
    );
  });

  // --- Manual --rules Tests ---
  it('should format a single --rules file correctly', async () => {
    jest.spyOn(glob, 'glob').mockResolvedValue(['/project/root/manual_rule.txt']);
    mockFiles['/project/root/manual_rule.txt'] = 'Manual rule content.';

    const result = await gatherDocsInternal(baseDir, { rules: ['manual_rule.txt'] });

    expect(result.rulesTag).toBe(
      '<rules>\n<rule filename="../../../../../project/root/manual_rule.txt"><![CDATA[\nManual rule content.\n]]></rule>\n</rules>'
    );
    expect(result.docsTag).toBe('');
  });

  it('should format multiple --rules files correctly', async () => {
    jest
      .spyOn(glob, 'glob')
      .mockResolvedValue(['/project/root/rule1.txt', '/project/root/rule2.txt']);
    mockFiles['/project/root/rule1.txt'] = 'Rule 1';
    mockFiles['/project/root/rule2.txt'] = 'Rule 2';

    const result = await gatherDocsInternal(baseDir, { rules: ['*.txt'] });

    expect(result.rulesTag).toBe(
      '<rules>\n<rule filename="../../../../../project/root/rule1.txt"><![CDATA[\nRule 1\n]]></rule>\n<rule filename="../../../../../project/root/rule2.txt"><![CDATA[\nRule 2\n]]></rule>\n</rules>'
    );
  });

  it('should include .cursorrules by default', async () => {
    const cursorRulesPath = path.join(baseDir, '.cursorrules');
    mockFiles[cursorRulesPath] = 'Cursor rule content.';
    jest.spyOn(glob, 'glob').mockResolvedValue([]); // No manual --rules

    const result = await gatherDocsInternal(baseDir, {});

    expect(result.rulesTag).toBe(
      '<rules>\n<rule filename=".cursorrules"><![CDATA[\nCursor rule content.\n]]></rule>\n</rules>'
    );
  });

  it('should omit .cursorrules when --omit-cursorrules is true', async () => {
    const cursorRulesPath = path.join(baseDir, '.cursorrules');
    mockFiles[cursorRulesPath] = 'Cursor rule content.';
    jest.spyOn(glob, 'glob').mockResolvedValue([]); // No manual --rules

    const result = await gatherDocsInternal(baseDir, { 'omit-cursorrules': true });

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
    filePath: '/project/root/.cursor/rules/default_rule.mdc',
    content: 'MDC Default Type Content',
    data: { description: 'Default type is rule' }, // No type specified
  };
  const mockMdcNoDesc: MdcFile = {
    filePath: '/project/root/.cursor/rules/no_desc.mdc',
    content: 'MDC No Description Content',
    data: { type: 'docs' }, // No description
  };
  const mockMdcQuotedDesc: MdcFile = {
    filePath: '/project/root/.cursor/rules/quoted_desc.mdc',
    content: 'MDC Quoted Description Content',
    data: { type: 'docs', description: '"This entire description is quoted"' },
  };

  it('should include MDC file with type "docs" and description', async () => {
    const result = await gatherDocsInternal(baseDir, {}, [mockMdcDoc]);
    expect(result.docsTag).toBe(
      '<documents>\n<document filename="../../../../../project/root/.cursor/rules/doc_rule.mdc" description="An MDC Document"><![CDATA[\nMDC Doc Content\n]]></document>\n</documents>'
    );
    expect(result.rulesTag).toBe('');
  });

  it('should include MDC file with type "rules" and description (with escaped quotes)', async () => {
    const result = await gatherDocsInternal(baseDir, {}, [mockMdcRule]);
    expect(result.rulesTag).toBe(
      '<rules>\n<rule filename="../../../../../project/root/.cursor/rules/style_rule.mdc" description="An MDC Rule with &quot;quotes&quot;"><![CDATA[\nMDC Rule Content\n]]></rule>\n</rules>'
    );
    expect(result.docsTag).toBe('');
  });

  it('should default MDC file type to "docs" if missing', async () => {
    const result = await gatherDocsInternal(baseDir, {}, [mockMdcDefaultType]);
    expect(result.rulesTag).toBe(
      '<rules>\n<rule filename="../../../../../project/root/.cursor/rules/default_rule.mdc" description="Default type is rule"><![CDATA[\nMDC Default Type Content\n]]></rule>\n</rules>'
    );
  });

  it('should handle MDC file with missing description', async () => {
    const result = await gatherDocsInternal(baseDir, {}, [mockMdcNoDesc]);
    expect(result.docsTag).toBe(
      '<documents>\n<document filename="../../../../../project/root/.cursor/rules/no_desc.mdc"><![CDATA[\nMDC No Description Content\n]]></document>\n</documents>'
    );
  });

  it('should trim quotes that wrap the entire description', async () => {
    const result = await gatherDocsInternal(baseDir, {}, [mockMdcQuotedDesc]);
    expect(result.docsTag).toBe(
      '<documents>\n<document filename="../../../../../project/root/.cursor/rules/quoted_desc.mdc" description="This entire description is quoted"><![CDATA[\nMDC Quoted Description Content\n]]></document>\n</documents>'
    );
  });

  // --- Combined Manual and MDC Tests ---
  it('should combine manual --docs and MDC docs', async () => {
    jest.spyOn(glob, 'glob').mockResolvedValue(['/project/root/manual_doc.md']);
    mockFiles['/project/root/manual_doc.md'] = 'Manual doc.';

    const result = await gatherDocsInternal(baseDir, { docs: ['manual_doc.md'] }, [
      mockMdcDoc,
      mockMdcDefaultType,
    ]);

    expect(result.docsTag).toBe(
      '<documents>\n' +
        '<document filename="../../../../../project/root/manual_doc.md"><![CDATA[\nManual doc.\n]]></document>\n' +
        '<document filename="../../../../../project/root/.cursor/rules/doc_rule.mdc" description="An MDC Document"><![CDATA[\nMDC Doc Content\n]]></document>\n' +
        '</documents>'
    );
  });

  it('should combine manual --rules, .cursorrules, and MDC rules', async () => {
    const cursorRulesPath = path.join(baseDir, '.cursorrules');
    mockFiles[cursorRulesPath] = 'Cursor rule.';
    jest.spyOn(glob, 'glob').mockResolvedValue(['/project/root/manual_rule.txt']);
    mockFiles['/project/root/manual_rule.txt'] = 'Manual rule.';

    const result = await gatherDocsInternal(baseDir, { rules: ['manual_rule.txt'] }, [mockMdcRule]);

    expect(result.rulesTag).toBe(
      '<rules>\n' +
        '<rule filename="../../../../../project/root/.cursor/rules/style_rule.mdc"><![CDATA[\nManual rule.\n]]></rule>\n' + // Manual rule first
        '<rule filename="../../../../../project/root/manual_rule.txt"><![CDATA[\nCursor rule.\n]]></rule>\n' + // Then .cursorrules
        '<rule filename="../../../../../project/root/.cursor/rules/style_rule.mdc" description="An MDC Rule with &quot;quotes&quot;"><![CDATA[\nMDC Rule Content\n]]></rule>\n' + // Then MDC rule
        '</rules>'
    );
  });

  // --- Empty/No Input Tests ---
  it('should return empty tags when no docs, rules, or MDCs are provided', async () => {
    jest.spyOn(glob, 'glob').mockResolvedValue([]);
    const result = await gatherDocsInternal(baseDir, {}, []);
    expect(result.docsTag).toBe('');
    expect(result.rulesTag).toBe('');
    expect(result.instructionsTag).toBe('');
  });

  it('should handle empty filteredMdcFiles array', async () => {
    jest.spyOn(glob, 'glob').mockResolvedValue(['/project/root/manual_doc.md']);
    mockFiles['/project/root/manual_doc.md'] = 'Manual doc content.';

    const result = await gatherDocsInternal(baseDir, { docs: ['manual_doc.md'] }, []); // Pass empty array

    expect(result.docsTag).toBe(
      '<documents>\n<document filename="../../../../../project/root/manual_doc.md"><![CDATA[\nManual doc content.\n]]></document>\n</documents>'
    );
    expect(result.rulesTag).toBe('');
  });

  // --- parseJjRename Tests ---
  describe('parseJjRename', () => {
    it('should correctly parse a jj diff rename line', () => {
      const renameLine =
        'R apps/inbox/src/{routes/inventory/inventories/[inventoryId] => lib/components/ui/inventory}/InventoryPicker.svelte';
      const result = parseJjRename(renameLine);
      expect(result).toBe('apps/inbox/src/lib/components/ui/inventory/InventoryPicker.svelte');
    });

    it('should handle a simple rename with no nested paths', () => {
      const renameLine = 'R src/{old => new}/file.ts';
      const result = parseJjRename(renameLine);
      expect(result).toBe('src/new/file.ts');
    });

    it('should return empty string for invalid rename format', () => {
      const renameLine = 'R src/{old => new/file.ts'; // Missing closing brace
      const result = parseJjRename(renameLine);
      expect(result).toEqual('');
    });

    it('should handle empty after segment', () => {
      const renameLine = 'R src/{old/dir => }/file.ts'; // Empty after segment
      const result = parseJjRename(renameLine);
      expect(result).toBe('src//file.ts');
    });
  });
});
