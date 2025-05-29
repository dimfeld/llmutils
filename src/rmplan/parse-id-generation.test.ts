import { describe, expect, test } from 'bun:test';
import { slugify } from './id_utils.js';

describe('rmplan parse - project ID generation logic', () => {
  test('truncates long issue titles', async () => {
    const title =
      'This is an extremely long issue title that should definitely be truncated when creating the project ID to avoid excessively long directory names in the filesystem';
    const slugTitle = slugify(title);
    expect(slugTitle.length).toBeLessThanOrEqual(50);
    expect(slugTitle).not.toEndWith('-');
  });

  test('slugifies custom project ID', () => {
    const customId = 'My Custom Project ID!';
    const projectId = slugify(customId);

    expect(projectId).toBe('my-custom-project-id');
  });

  test('handles project ID with special characters', () => {
    const customId = '---Project@#$%Name---';
    const projectId = slugify(customId);

    expect(projectId).toBe('project-name');
  });
});
