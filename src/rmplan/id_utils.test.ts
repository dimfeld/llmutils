import { describe, test, expect } from 'bun:test';
import { generateProjectId, generatePhaseId, slugify } from './id_utils.js';

describe('slugify', () => {
  test('converts text to lowercase', () => {
    expect(slugify('UPPERCASE')).toBe('uppercase');
    expect(slugify('MixedCase')).toBe('mixedcase');
  });

  test('replaces spaces with hyphens', () => {
    expect(slugify('hello world')).toBe('hello-world');
    expect(slugify('one two three')).toBe('one-two-three');
  });

  test('replaces special characters with hyphens', () => {
    expect(slugify('hello!@#$%world')).toBe('hello-world');
    expect(slugify('test&*()_+=')).toBe('test');
  });

  test('preserves existing hyphens', () => {
    expect(slugify('already-hyphenated')).toBe('already-hyphenated');
  });

  test('replaces multiple consecutive hyphens with single hyphen', () => {
    expect(slugify('hello---world')).toBe('hello-world');
    expect(slugify('test - - - case')).toBe('test-case');
  });

  test('removes leading and trailing hyphens', () => {
    expect(slugify('---hello---')).toBe('hello');
    expect(slugify('-world-')).toBe('world');
  });

  test('handles complex cases', () => {
    expect(slugify('The Quick Brown Fox!!! Jumps... Over the lazy dog.')).toBe(
      'the-quick-brown-fox-jumps-over-the-lazy-dog'
    );
    expect(slugify('____test____case____')).toBe('test-case');
  });

  test('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  test('handles string with only special characters', () => {
    expect(slugify('!@#$%^&*()')).toBe('');
  });
});

describe('generateProjectId', () => {
  test('generates ID with simple title', () => {
    const id = generateProjectId('MyProject');
    expect(id).toMatch(/^myproject-[a-z0-9]+$/);
  });

  test('handles title with spaces and mixed case', () => {
    const id = generateProjectId('My Awesome Project Name');
    expect(id).toMatch(/^my-awesome-project-name-[a-z0-9]+$/);
  });

  test('handles title with special characters', () => {
    const id = generateProjectId('Project!@#$%^&*()_+123');
    expect(id).toMatch(/^project-123-[a-z0-9]+$/);
  });

  test('handles title with leading/trailing special characters', () => {
    const id = generateProjectId('---Project---');
    expect(id).toMatch(/^project-[a-z0-9]+$/);
  });

  test('generates different IDs for same title on different calls', async () => {
    const ids = new Set<string>();

    // Generate multiple IDs with small delays to ensure at least some are different
    for (let i = 0; i < 10; i++) {
      ids.add(generateProjectId('SameTitle'));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    // We should have at least 2 different IDs out of 10 attempts
    expect(ids.size).toBeGreaterThan(1);

    // All IDs should match the expected pattern
    for (const id of ids) {
      expect(id).toMatch(/^sametitle-[a-z0-9]{6}$/);
    }
  });

  test('output format is slugified_title-unique_part', () => {
    const id = generateProjectId('Test Project 123');
    const parts = id.split('-');

    // Should have at least 4 parts: test, project, 123, and the unique ID
    expect(parts.length).toBeGreaterThanOrEqual(4);
    expect(parts[0]).toBe('test');
    expect(parts[1]).toBe('project');
    expect(parts[2]).toBe('123');
    // The unique part should be alphanumeric
    expect(parts[parts.length - 1]).toMatch(/^[a-z0-9]+$/);
  });

  test('truncates very long titles', () => {
    const longTitle =
      'This is a very long project title that should be truncated to avoid excessively long IDs in the system';
    const id = generateProjectId(longTitle);

    // The slug part (without unique ID) should be truncated to 50 chars max
    const parts = id.split('-');
    const uniquePart = parts[parts.length - 1];
    const slugPart = id.substring(0, id.length - uniquePart.length - 1);

    expect(slugPart.length).toBeLessThanOrEqual(50);
    expect(slugPart).not.toEndWith('-'); // No trailing hyphen after truncation
  });

  test('unique component is 6 characters', () => {
    const id = generateProjectId('Test');
    const parts = id.split('-');
    const uniquePart = parts[parts.length - 1];

    expect(uniquePart.length).toBe(6);
    expect(uniquePart).toMatch(/^[a-z0-9]{6}$/);
  });
});

describe('generatePhaseId', () => {
  test('generates phase ID with correct format', () => {
    const projectId = 'my-project-abc123';
    const phaseIndex = 1;
    const phaseId = generatePhaseId(projectId, phaseIndex);

    expect(phaseId).toBe('my-project-abc123-1');
  });

  test('handles different phase indices', () => {
    const projectId = 'test-project-xyz789';

    expect(generatePhaseId(projectId, 1)).toBe('test-project-xyz789-1');
    expect(generatePhaseId(projectId, 2)).toBe('test-project-xyz789-2');
    expect(generatePhaseId(projectId, 10)).toBe('test-project-xyz789-10');
  });

  test('preserves complex project IDs', () => {
    const projectId = 'complex-project-name-with-many-parts-123abc';
    const phaseIndex = 3;
    const phaseId = generatePhaseId(projectId, phaseIndex);

    expect(phaseId).toBe('complex-project-name-with-many-parts-123abc-3');
  });
});
