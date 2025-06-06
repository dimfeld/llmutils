import { describe, test, expect } from 'bun:test';
import { slugify, timestamp } from './id_utils.js';

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

  test('truncates at word boundary when exceeding maxLength', () => {
    const longText = 'this-is-a-very-long-slug-that-should-be-truncated-at-word-boundary';
    const result = slugify(longText, 30);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result).toBe('this-is-a-very-long-slug-that');
  });

  test('truncates at exact maxLength when no word boundary available', () => {
    const longWord = 'thisisaverylongwordwithouthyphens';
    const result = slugify(longWord, 20);
    expect(result.length).toBe(20);
    expect(result).toBe('thisisaverylongwordw');
  });

  test('does not truncate when text is shorter than maxLength', () => {
    const shortText = 'short-text';
    const result = slugify(shortText, 50);
    expect(result).toBe('short-text');
  });

  test('handles truncation with trailing hyphen removal', () => {
    // This should truncate to 'this-is-a-test' not 'this-is-a-test-'
    const text = 'this-is-a-test-case-with-many-words';
    const result = slugify(text, 15);
    expect(result.length).toBeLessThanOrEqual(15);
    expect(result).toBe('this-is-a-test');
    expect(result).not.toEndWith('-');
  });
});

describe('timestamp', () => {
  test('should return a string', () => {
    const id = timestamp();
    expect(typeof id).toBe('string');
  });

  test('should return a string consisting only of base36 characters (0-9, a-z)', () => {
    const id = timestamp();
    expect(id).toMatch(/^[0-9a-z]+$/);
  });

  test('should generate sortable IDs (later IDs should be lexicographically greater)', async () => {
    const ids: string[] = [];

    // Generate several IDs with small delays
    for (let i = 0; i < 5; i++) {
      ids.push(timestamp());
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    // Check that each ID is greater than or equal to the previous one
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] >= ids[i - 1]).toBe(true);
    }
  });

  test('should produce a valid base36 string even when Date.now() - EPOCH is negative', () => {
    // Mock Date.now to return a time before the epoch
    const originalDateNow = Date.now;
    const mockedTime = new Date('2025-04-01T00:00:00.000Z').getTime();

    Date.now = () => mockedTime;

    try {
      const id = timestamp();
      // Should still be a valid base36 string
      expect(id).toMatch(/^[0-9a-z]+$/);
      // Should not be empty
      expect(id.length).toBeGreaterThan(0);
    } finally {
      // Restore original Date.now
      Date.now = originalDateNow;
    }
  });

  test('should generate reasonably short IDs for dates close to the epoch', () => {
    const originalDateNow = Date.now;
    // Set time to 1 hour after epoch
    const mockedTime = new Date('2025-05-01T01:00:00.000Z').getTime();

    Date.now = () => mockedTime;

    try {
      const id = timestamp();
      // ID should be relatively short for times close to epoch
      expect(id.length).toBeLessThanOrEqual(6);
    } finally {
      Date.now = originalDateNow;
    }
  });
});

describe('generateNumericPlanId', () => {
  test('should return next ID after maximum numeric ID', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tempPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-test-'));

    try {
      // Create mock plan files
      await Bun.write(
        `${tempPath}/1.yml`,
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\nid: 1\ngoal: Test plan 1\ndetails: Details for test plan 1\ntasks: []\n'
      );
      await Bun.write(
        `${tempPath}/100.yml`,
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\nid: 100\ngoal: Test plan 100\ndetails: Details for test plan 100\ntasks: []\n'
      );
      await Bun.write(
        `${tempPath}/old.yml`,
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\nid: "abc"\ngoal: Old alphanumeric plan\ndetails: Details for old plan\ntasks: []\n'
      );

      // Import dynamically to avoid circular dependencies
      const { generateNumericPlanId } = await import('./id_utils.js');
      const nextId = await generateNumericPlanId(tempPath);

      expect(nextId).toBe(101);
    } finally {
      // Clean up
      await fs.rm(tempPath, { recursive: true, force: true });
    }
  });

  test('should return 1 for empty directory', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tempPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-test-'));

    try {
      const { generateNumericPlanId } = await import('./id_utils.js');
      const nextId = await generateNumericPlanId(tempPath);

      expect(nextId).toBe(1);
    } finally {
      await fs.rm(tempPath, { recursive: true, force: true });
    }
  });

  test('should return 1 when only non-numeric IDs exist', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tempPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-test-'));

    try {
      // Create plan files with only non-numeric IDs
      await Bun.write(
        `${tempPath}/alpha.yml`,
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\nid: "alpha123"\ngoal: Alpha plan\ndetails: Details for alpha plan\ntasks: []\n'
      );
      await Bun.write(
        `${tempPath}/beta.yml`,
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\nid: "beta456"\ngoal: Beta plan\ndetails: Details for beta plan\ntasks: []\n'
      );

      const { generateNumericPlanId } = await import('./id_utils.js');
      const nextId = await generateNumericPlanId(tempPath);

      expect(nextId).toBe(1);
    } finally {
      await fs.rm(tempPath, { recursive: true, force: true });
    }
  });

  test('should handle mixed ID types including plans without IDs', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tempPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-test-'));

    try {
      // Create plan files with mixed ID types
      await Bun.write(
        `${tempPath}/5.yml`,
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\nid: 5\ngoal: Numeric plan 5\ndetails: Details for plan 5\ntasks: []\n'
      );
      await Bun.write(
        `${tempPath}/string-id.yml`,
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\nid: "string-id"\ngoal: String ID plan\ndetails: Details for string ID plan\ntasks: []\n'
      );
      await Bun.write(
        `${tempPath}/no-id.yml`,
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\ngoal: Plan without ID\ndetails: This plan has no ID field\ntasks: []\n'
      );
      await Bun.write(
        `${tempPath}/20.yml`,
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\nid: 20\ngoal: Numeric plan 20\ndetails: Details for plan 20\ntasks: []\n'
      );

      const { generateNumericPlanId } = await import('./id_utils.js');
      const nextId = await generateNumericPlanId(tempPath);

      // Should return 21 (max numeric ID 20 + 1)
      expect(nextId).toBe(21);
    } finally {
      await fs.rm(tempPath, { recursive: true, force: true });
    }
  });
});
