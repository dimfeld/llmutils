import { describe, expect, it } from 'bun:test';
import { generatePlanId } from './id_generator';

describe('generatePlanId', () => {
  it('should return a string', () => {
    const id = generatePlanId();
    expect(typeof id).toBe('string');
  });

  it('should return a string consisting only of base36 characters (0-9, a-z)', () => {
    const id = generatePlanId();
    expect(id).toMatch(/^[0-9a-z]+$/);
  });

  it('should generate different IDs when called a few milliseconds apart', async () => {
    const id1 = generatePlanId();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const id2 = generatePlanId();
    expect(id1).not.toBe(id2);
  });

  it('should generate sortable IDs (later IDs should be lexicographically greater)', async () => {
    const ids: string[] = [];

    // Generate several IDs with small delays
    for (let i = 0; i < 5; i++) {
      ids.push(generatePlanId());
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    // Check that each ID is greater than or equal to the previous one
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] >= ids[i - 1]).toBe(true);
    }
  });

  it('should produce a valid base36 string even when Date.now() - EPOCH is negative', () => {
    // Mock Date.now to return a time before the epoch
    const originalDateNow = Date.now;
    const mockedTime = new Date('2025-04-01T00:00:00.000Z').getTime();

    Date.now = () => mockedTime;

    try {
      const id = generatePlanId();
      // Should still be a valid base36 string
      expect(id).toMatch(/^[0-9a-z]+$/);
      // Should not be empty
      expect(id.length).toBeGreaterThan(0);
    } finally {
      // Restore original Date.now
      Date.now = originalDateNow;
    }
  });

  it('should generate reasonably short IDs for dates close to the epoch', () => {
    const originalDateNow = Date.now;
    // Set time to 1 hour after epoch
    const mockedTime = new Date('2025-05-01T01:00:00.000Z').getTime();

    Date.now = () => mockedTime;

    try {
      const id = generatePlanId();
      // ID should be relatively short for times close to epoch
      expect(id.length).toBeLessThanOrEqual(6);
    } finally {
      Date.now = originalDateNow;
    }
  });
});
