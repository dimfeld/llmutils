import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { SymbolIndex } from './symbol_index';
import { DiffMapper } from './diff_mapper';
import { ContextMatcher } from './context_matcher';
import { ReferenceResolver } from './reference_resolver';
import { LocationCache } from './cache';
import type { GitDiff, Symbol, FileContent } from './types';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SymbolIndex', () => {
  let index: SymbolIndex;
  let testDir: string;

  beforeEach(() => {
    index = new SymbolIndex();
    testDir = mkdtempSync(join(tmpdir(), 'symbol-index-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should extract symbols from TypeScript files', async () => {
    const testFile = join(testDir, 'test.ts');
    writeFileSync(
      testFile,
      `
export class TestClass {
  constructor() {}
  
  testMethod() {
    return 'test';
  }
}

export function testFunction(param: string): string {
  return param;
}

export const testArrow = (a: number, b: number) => a + b;

interface TestInterface {
  prop: string;
}

type TestType = string | number;
    `.trim()
    );

    await index.buildIndex([testFile]);

    // Find class
    const classSymbols = index.findSymbol('TestClass');
    expect(classSymbols).toHaveLength(1);
    expect(classSymbols[0].type).toBe('class');
    expect(classSymbols[0].members).toContain('testMethod');

    // Find function
    const funcSymbols = index.findSymbol('testFunction');
    expect(funcSymbols).toHaveLength(1);
    expect(funcSymbols[0].type).toBe('function');
    expect(funcSymbols[0].signature).toContain('param');

    // Find arrow function
    const arrowSymbols = index.findSymbol('testArrow');
    expect(arrowSymbols).toHaveLength(1);
    expect(arrowSymbols[0].type).toBe('function');

    // Find interface
    const interfaceSymbols = index.findSymbol('TestInterface');
    expect(interfaceSymbols).toHaveLength(1);
    expect(interfaceSymbols[0].type).toBe('interface');

    // Find type
    const typeSymbols = index.findSymbol('TestType');
    expect(typeSymbols).toHaveLength(1);
    expect(typeSymbols[0].type).toBe('type');
  });

  it('should find symbols with context', () => {
    const symbols: Symbol[] = [
      {
        name: 'test',
        type: 'function',
        file: 'a.ts',
        location: { file: 'a.ts', startLine: 10, endLine: 15, type: 'function' },
      },
      {
        name: 'test',
        type: 'function',
        file: 'b.ts',
        location: { file: 'b.ts', startLine: 20, endLine: 25, type: 'function' },
      },
    ];

    // Mock the symbols
    index['symbols'].set('test', symbols);
    index['fileSymbols'].set('a.ts', [symbols[0]]);
    index['fileSymbols'].set('b.ts', [symbols[1]]);

    // Find with file context
    const found = index.findSymbol('test', { file: 'b.ts' });
    expect(found[0].file).toBe('b.ts');

    // Find with line context
    const nearLine = index.findSymbol('test', { nearLine: 22 });
    expect(nearLine[0].file).toBe('b.ts');
  });
});

describe('DiffMapper', () => {
  let mapper: DiffMapper;

  beforeEach(() => {
    const diff: GitDiff = {
      changedFiles: ['test.ts'],
      files: [
        {
          path: 'test.ts',
          hunks: [
            {
              oldStart: 10,
              oldLines: 5,
              newStart: 10,
              newLines: 7,
              lines: [
                { type: 'context', content: 'line 10', oldLine: 10, newLine: 10 },
                { type: 'delete', content: 'old line 11', oldLine: 11 },
                { type: 'add', content: 'new line 11', newLine: 11 },
                { type: 'add', content: 'new line 12', newLine: 12 },
                { type: 'context', content: 'line 12', oldLine: 12, newLine: 13 },
                { type: 'context', content: 'line 13', oldLine: 13, newLine: 14 },
                { type: 'context', content: 'line 14', oldLine: 14, newLine: 15 },
              ],
            },
          ],
        },
      ],
    };

    mapper = new DiffMapper(diff);
  });

  it('should map unchanged lines correctly', () => {
    const location = {
      file: 'test.ts',
      startLine: 10,
      endLine: 10,
      type: 'block' as const,
    };

    const mapped = mapper.mapLocation(location, 'oldToNew');
    expect(mapped).not.toBeNull();
    expect(mapped!.startLine).toBe(10);
    expect(mapped!.endLine).toBe(10);
  });

  it('should map lines after insertions', () => {
    const location = {
      file: 'test.ts',
      startLine: 12,
      endLine: 14,
      type: 'block' as const,
    };

    const mapped = mapper.mapLocation(location, 'oldToNew');
    expect(mapped).not.toBeNull();
    expect(mapped!.startLine).toBe(13);
    expect(mapped!.endLine).toBe(15);
  });

  it('should handle deleted lines', () => {
    expect(mapper.isLineDeleted(11)).toBe(true);
    expect(mapper.isLineDeleted(10)).toBe(false);
  });

  it('should handle added lines', () => {
    expect(mapper.isLineAdded(11)).toBe(true);
    expect(mapper.isLineAdded(12)).toBe(true);
    expect(mapper.isLineAdded(10)).toBe(false);
  });
});

describe('ContextMatcher', () => {
  let matcher: ContextMatcher;

  beforeEach(() => {
    matcher = new ContextMatcher();
  });

  it('should find blocks by context', () => {
    const file: FileContent = {
      path: 'test.ts',
      content: `
function firstFunction() {
  console.log('first');
}

class TestClass {
  constructor() {}
  
  testMethod() {
    console.log('test');
  }
}

function secondFunction() {
  console.log('second');
}
      `.trim(),
    };

    const matches = matcher.findByContext('console.log test', file);
    expect(matches.length).toBeGreaterThan(0);
    
    // Should find the method that logs 'test'
    const bestMatch = matches[0];
    expect(bestMatch.confidence).toBeGreaterThan(0.7);
    expect(bestMatch.location.startLine).toBeGreaterThanOrEqual(6);
    expect(bestMatch.location.endLine).toBeLessThanOrEqual(12);
  });

  it('should calculate similarity correctly', () => {
    const similarity = matcher['stringSimilarity']('hello', 'hallo');
    expect(similarity).toBeGreaterThan(0.5);
    expect(similarity).toBeLessThan(1.0);

    const exact = matcher['stringSimilarity']('test', 'test');
    expect(exact).toBe(1.0);

    const different = matcher['stringSimilarity']('abc', 'xyz');
    expect(different).toBe(0);
  });
});

describe('LocationCache', () => {
  let cache: LocationCache;

  beforeEach(() => {
    cache = new LocationCache();
  });

  it('should cache and retrieve locations', async () => {
    const location = {
      file: 'test.ts',
      startLine: 10,
      endLine: 20,
      type: 'function' as const,
    };

    const context = {
      prNumber: 123,
      fileHash: 'abc123',
    };

    cache.set('testRef', location, context);

    const retrieved = await cache.get('testRef', context);
    expect(retrieved).toEqual(location);
  });

  it('should invalidate cache on file change', async () => {
    const location = {
      file: 'test.ts',
      startLine: 10,
      endLine: 20,
      type: 'function' as const,
    };

    const context1 = {
      prNumber: 123,
      fileHash: 'abc123',
    };

    const context2 = {
      prNumber: 123,
      fileHash: 'def456',
    };

    cache.set('testRef', location, context1);

    const retrieved = await cache.get('testRef', context2);
    expect(retrieved).toBeNull();
  });

  it('should enforce size limits', () => {
    cache.setMaxSize(2);

    const context = {
      prNumber: 123,
      fileHash: 'abc123',
    };

    cache.set('ref1', { file: 'a.ts', startLine: 1, endLine: 1, type: 'block' }, context);
    cache.set('ref2', { file: 'b.ts', startLine: 2, endLine: 2, type: 'block' }, context);
    cache.set('ref3', { file: 'c.ts', startLine: 3, endLine: 3, type: 'block' }, context);

    expect(cache.size()).toBe(2);
    // First item should be evicted
    expect(cache.get('ref1', context)).resolves.toBeNull();
  });

  it('should clear old entries', () => {
    cache.setMaxAge(100); // 100ms

    const context = {
      prNumber: 123,
      fileHash: 'abc123',
    };

    cache.set('ref1', { file: 'a.ts', startLine: 1, endLine: 1, type: 'block' }, context);

    // Wait for expiry
    setTimeout(() => {
      cache.clearOld();
      expect(cache.size()).toBe(0);
    }, 150);
  });
});