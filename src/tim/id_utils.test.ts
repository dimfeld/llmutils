import { afterEach, beforeEach, describe, test, expect } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { slugify, timestamp } from './id_utils.js';
import { closeDatabaseForTesting } from './db/database.js';
import { ModuleMocker, stringifyPlanWithFrontmatter } from '../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// These tests need isolated config directories for shared ID storage
describe('generateNumericPlanId with shared storage', () => {
  let tempDir: string;
  let fakeConfigDir: string;
  const originalEnv: Partial<Record<string, string>> = {};

  beforeEach(async () => {
    closeDatabaseForTesting();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-id-utils-test-'));
    fakeConfigDir = path.join(tempDir, 'config');
    await fs.mkdir(fakeConfigDir, { recursive: true });

    originalEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
    originalEnv.APPDATA = process.env.APPDATA;

    process.env.XDG_CONFIG_HOME = fakeConfigDir;
    delete process.env.APPDATA;

    const realOs = await import('node:os');
    await moduleMocker.mock('node:os', () => ({
      ...realOs,
      homedir: () => path.join(tempDir, 'home'),
    }));
  });

  afterEach(async () => {
    closeDatabaseForTesting();
    moduleMocker.clear();
    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }

    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('should return next ID after maximum numeric ID', async () => {
    const planDir = path.join(tempDir, 'plans');
    await fs.mkdir(planDir, { recursive: true });

    // Create mock plan files
    await Bun.write(
      `${planDir}/1.yml`,
      stringifyPlanWithFrontmatter({
        id: 1,
        goal: 'Test plan 1',
        details: 'Details for test plan 1',
        tasks: [],
      })
    );
    await Bun.write(
      `${planDir}/100.yml`,
      stringifyPlanWithFrontmatter({
        id: 100,
        goal: 'Test plan 100',
        details: 'Details for test plan 100',
        tasks: [],
      })
    );
    await Bun.write(
      `${planDir}/old.yml`,
      stringifyPlanWithFrontmatter({
        id: 'abc',
        goal: 'Old alphanumeric plan',
        details: 'Details for old plan',
        tasks: [],
      })
    );

    const { generateNumericPlanId } = await import('./id_utils.js');
    const nextId = await generateNumericPlanId(planDir);

    expect(nextId).toBe(101);
  });

  test('should return 1 for empty directory', async () => {
    const planDir = path.join(tempDir, 'plans-empty');
    await fs.mkdir(planDir, { recursive: true });

    const { generateNumericPlanId } = await import('./id_utils.js');
    const nextId = await generateNumericPlanId(planDir);

    expect(nextId).toBe(1);
  });

  test('should return 1 when only non-numeric IDs exist', async () => {
    const planDir = path.join(tempDir, 'plans-non-numeric');
    await fs.mkdir(planDir, { recursive: true });

    // Create plan files with only non-numeric IDs
    await Bun.write(
      `${planDir}/alpha.yml`,
      stringifyPlanWithFrontmatter({
        id: 'alpha123',
        goal: 'Alpha plan',
        details: 'Details for alpha plan',
        tasks: [],
      })
    );
    await Bun.write(
      `${planDir}/beta.yml`,
      stringifyPlanWithFrontmatter({
        id: 'beta456',
        goal: 'Beta plan',
        details: 'Details for beta plan',
        tasks: [],
      })
    );

    const { generateNumericPlanId } = await import('./id_utils.js');
    const nextId = await generateNumericPlanId(planDir);

    expect(nextId).toBe(1);
  });

  test('should handle mixed ID types including plans without IDs', async () => {
    const planDir = path.join(tempDir, 'plans-mixed');
    await fs.mkdir(planDir, { recursive: true });

    // Create plan files with mixed ID types
    await Bun.write(
      `${planDir}/5.yml`,
      stringifyPlanWithFrontmatter({
        id: 5,
        goal: 'Numeric plan 5',
        details: 'Details for plan 5',
        tasks: [],
      })
    );
    await Bun.write(
      `${planDir}/string-id.yml`,
      stringifyPlanWithFrontmatter({
        id: 'string-id',
        goal: 'String ID plan',
        details: 'Details for string ID plan',
        tasks: [],
      })
    );
    await Bun.write(
      `${planDir}/no-id.yml`,
      stringifyPlanWithFrontmatter({
        goal: 'Plan without ID',
        details: 'This plan has no ID field',
        tasks: [],
      })
    );
    await Bun.write(
      `${planDir}/20.yml`,
      stringifyPlanWithFrontmatter({
        id: 20,
        goal: 'Numeric plan 20',
        details: 'Details for plan 20',
        tasks: [],
      })
    );

    const { generateNumericPlanId } = await import('./id_utils.js');
    const nextId = await generateNumericPlanId(planDir);

    // Should return 21 (max numeric ID 20 + 1)
    expect(nextId).toBe(21);
  });
});

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
