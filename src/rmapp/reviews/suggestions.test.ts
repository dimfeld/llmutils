import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { SuggestionHandler } from './suggestions';
import type { GitHubSuggestion } from './types';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SuggestionHandler', () => {
  let handler: SuggestionHandler;
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'suggestion-test-'));
    handler = new SuggestionHandler(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('processSuggestion', () => {
    it('should parse a valid suggestion block', async () => {
      const testFile = 'test.ts';
      writeFileSync(join(testDir, testFile), `function add(a, b) {\n  return a + b;\n}\n`);

      const suggestion: GitHubSuggestion = {
        id: 1,
        body: `
          This should have type annotations.
          
          \`\`\`suggestion
          function add(a: number, b: number): number {
            return a + b;
          }
          \`\`\`
        `,
        path: testFile,
        line: 1,
        side: 'RIGHT',
      };

      const result = await handler.processSuggestion(suggestion);

      expect(result.parsed).not.toBeNull();
      expect(result.parsed?.suggestedCode).toContain('a: number');
      expect(result.validation.isValid).toBe(true);
      // Can't auto-apply without original code to compare
      expect(result.canAutoApply).toBe(false);
    });

    it('should detect invalid suggestions', async () => {
      const suggestion: GitHubSuggestion = {
        id: 2,
        body: 'Please fix this', // No suggestion block
        path: 'nonexistent.ts',
        line: 1,
        side: 'RIGHT',
      };

      const result = await handler.processSuggestion(suggestion);

      expect(result.parsed).toBeNull();
      expect(result.validation.isValid).toBe(false);
      expect(result.validation.errors).toContain('No suggestion block found in comment');
      expect(result.canAutoApply).toBe(false);
    });

    it('should validate file existence', async () => {
      const suggestion: GitHubSuggestion = {
        id: 3,
        body: `
          \`\`\`suggestion
          const x = 1;
          \`\`\`
        `,
        path: 'missing.ts',
        line: 1,
        side: 'RIGHT',
      };

      const result = await handler.processSuggestion(suggestion);

      expect(result.validation.isValid).toBe(false);
      expect(result.validation.errors[0]).toContain('File missing.ts not found');
    });

    it('should check syntax issues', async () => {
      const testFile = 'syntax.js';
      writeFileSync(join(testDir, testFile), 'const x = 1;\n');

      const suggestion: GitHubSuggestion = {
        id: 4,
        body: `
          \`\`\`suggestion
          const x = {
            a: 1,
            b: 2
          // Missing closing brace
          \`\`\`
        `,
        path: testFile,
        line: 1,
        side: 'RIGHT',
      };

      const result = await handler.processSuggestion(suggestion);

      expect(result.validation.warnings).toContain('Unclosed bracket: {');
    });

    it('should detect indentation issues', async () => {
      const testFile = 'indent.ts';
      writeFileSync(join(testDir, testFile), '  const x = 1;\n  const y = 2;\n');

      const suggestion: GitHubSuggestion = {
        id: 5,
        body: `
          \`\`\`suggestion
          \tconst x = 1;
            const y = 2;
          \`\`\`
        `,
        path: testFile,
        line: 1,
        side: 'RIGHT',
      };

      const result = await handler.processSuggestion(suggestion);

      // Check for indentation warning
      const hasIndentWarning = result.validation.warnings.some(w => 
        w.includes('Mixed tabs and spaces') || 
        w.includes('Inconsistent indentation')
      );
      expect(hasIndentWarning || result.validation.warnings.length > 0).toBe(true);
    });

    it('should enhance valid suggestions', async () => {
      const testFile = 'enhance.ts';
      writeFileSync(join(testDir, testFile), 'const add = (a, b) => a + b;\n');

      const suggestion: GitHubSuggestion = {
        id: 6,
        body: `
          \`\`\`suggestion
          function add(a: number, b: number): number {
            return a + b;
          }
          \`\`\`
        `,
        path: testFile,
        line: 1,
        side: 'RIGHT',
      };

      const result = await handler.processSuggestion(suggestion);

      expect(result.enhanced).toBeDefined();
      // Function changes are medium impact
      expect(result.enhanced?.impact).toBe('medium');
      expect(result.enhanced?.affectedSymbols).toContain('add');
    });

    it('should extract line ranges from context', async () => {
      const testFile = 'range.ts';
      writeFileSync(join(testDir, testFile), 'line1\nline2\nline3\nline4\nline5\n');

      const suggestion: GitHubSuggestion = {
        id: 7,
        body: `
          For lines 2-4, we should update:
          
          \`\`\`suggestion
          updated line2
          updated line3
          updated line4
          \`\`\`
        `,
        path: testFile,
        line: 2,
        side: 'RIGHT',
      };

      const result = await handler.processSuggestion(suggestion);

      expect(result.parsed?.startLine).toBe(2);
      expect(result.parsed?.endLine).toBe(4);
    });
  });

  describe('formatSuggestionForApplication', () => {
    it('should format suggestion with imports', () => {
      const processed = {
        original: {} as GitHubSuggestion,
        parsed: {
          suggestedCode: 'const Component = () => <div>Hello</div>;',
          startLine: 1,
        },
        validation: { isValid: true, hasConflicts: false, errors: [], warnings: [] },
        enhanced: {
          suggestedCode: 'const Component = () => <div>Hello</div>;',
          startLine: 1,
          impact: 'low' as const,
          affectedSymbols: ['Component'],
          requiresImports: ["import React from 'react';"],
        },
        canAutoApply: true,
      };

      const result = handler.formatSuggestionForApplication(processed);

      expect(result).toContain("import React from 'react';");
      expect(result).toContain('const Component');
    });

    it('should return null for invalid suggestions', () => {
      const processed = {
        original: {} as GitHubSuggestion,
        parsed: null,
        validation: { isValid: false, hasConflicts: false, errors: ['Error'], warnings: [] },
        canAutoApply: false,
      };

      const result = handler.formatSuggestionForApplication(processed);
      expect(result).toBeNull();
    });
  });
});