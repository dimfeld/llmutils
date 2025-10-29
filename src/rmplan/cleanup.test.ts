import { test, expect, mock, describe } from 'bun:test';
import { cleanComments } from './cleanup';
import type { RmplanConfig } from './configSchema.ts';
import type { PlanSchema } from './planSchema.ts';
import { prepareNextStep } from './plans/prepare_step.js';
import yaml from 'yaml';

describe('cleanComments', () => {
  test('removes TypeScript EOL comments', () => {
    const input = `
    let x = 1; // This will be removed
    let y = 2; /* This too */
    // This whole line comment stays
    let z = 3;
    let stringWithHash = '# This is not a comment';
    let simpleVar = 42; // But this comment is removed
  `;
    const expected = `
    let x = 1;
    let y = 2;
    // This whole line comment stays
    let z = 3;
    let stringWithHash = '# This is not a comment';
    let simpleVar = 42;
  `;
    const result = cleanComments(input, '.ts');
    expect(result).toBeDefined();
    if (result) {
      expect(result.cleanedContent.trim()).toEqual(expected.trim());
      expect(result.linesCleaned).toBe(3);
    }
  });

  test('removes Python EOL comments', () => {
    const input = `
    x = 1 # This is a comment
    y = 2
    # Another comment
    z = 3
  `;
    const expected = `
    x = 1
    y = 2
    # Another comment
    z = 3
  `;
    const result = cleanComments(input, '.py');
    expect(result).toBeDefined();
    if (result) {
      expect(result.cleanedContent.trim()).toEqual(expected.trim());
      expect(result.linesCleaned).toBe(1);
    }
  });

  test('handles Svelte invalid template comments', () => {
    const input = `
    <div>
      {/* Invalid comment */}
      <p>Hello</p>
    </div>
  `;
    const expected = `
    <div>
      <!-- Invalid comment -->
      <p>Hello</p>
    </div>
  `;
    const result = cleanComments(input, '.svelte');
    expect(result).toBeDefined();
    if (result) {
      expect(result.cleanedContent.trim()).toEqual(expected.trim());
      expect(result.linesCleaned).toBe(1);
    }
  });

  test('returns unchanged content for unsupported extension', () => {
    const input = `
    content: some text
  `;
    const result = cleanComments(input, '.txt');
    expect(result).toBeUndefined();
  });
});
