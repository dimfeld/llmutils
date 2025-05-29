import { describe, test, expect } from 'bun:test';
import { generateProjectId, generatePhaseId } from './id_utils.js';

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
    const id1 = generateProjectId('SameTitle');
    // Small delay to ensure different timestamp
    await new Promise((resolve) => setTimeout(resolve, 1));
    const id2 = generateProjectId('SameTitle');

    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^sametitle-[a-z0-9]+$/);
    expect(id2).toMatch(/^sametitle-[a-z0-9]+$/);
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
