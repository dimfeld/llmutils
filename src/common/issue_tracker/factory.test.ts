import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  getAvailableTrackers,
  getMissingTrackerError,
  isTrackerAvailable,
  getDefaultTracker,
} from './factory.js';

describe('Issue Tracker Factory', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment to a clean state
    process.env = { ...originalEnv };
    // Clear any API keys
    delete process.env.GITHUB_TOKEN;
    delete process.env.LINEAR_API_KEY;
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('getAvailableTrackers', () => {
    test('should return no trackers when no API keys are set', () => {
      const available = getAvailableTrackers();

      expect(available.github).toBe(false);
      expect(available.linear).toBe(false);
      expect(available.available).toEqual([]);
      expect(available.unavailable).toEqual(['github', 'linear']);
    });

    test('should return only GitHub when GITHUB_TOKEN is set', () => {
      process.env.GITHUB_TOKEN = 'ghp_test_token';

      const available = getAvailableTrackers();

      expect(available.github).toBe(true);
      expect(available.linear).toBe(false);
      expect(available.available).toEqual(['github']);
      expect(available.unavailable).toEqual(['linear']);
    });

    test('should return only Linear when LINEAR_API_KEY is set', () => {
      process.env.LINEAR_API_KEY = 'lin_test_key';

      const available = getAvailableTrackers();

      expect(available.github).toBe(false);
      expect(available.linear).toBe(true);
      expect(available.available).toEqual(['linear']);
      expect(available.unavailable).toEqual(['github']);
    });

    test('should return both trackers when both API keys are set', () => {
      process.env.GITHUB_TOKEN = 'ghp_test_token';
      process.env.LINEAR_API_KEY = 'lin_test_key';

      const available = getAvailableTrackers();

      expect(available.github).toBe(true);
      expect(available.linear).toBe(true);
      expect(available.available).toEqual(['github', 'linear']);
      expect(available.unavailable).toEqual([]);
    });

    test('should handle empty string API keys as unavailable', () => {
      process.env.GITHUB_TOKEN = '';
      process.env.LINEAR_API_KEY = '';

      const available = getAvailableTrackers();

      expect(available.github).toBe(false);
      expect(available.linear).toBe(false);
      expect(available.available).toEqual([]);
      expect(available.unavailable).toEqual(['github', 'linear']);
    });
  });

  describe('isTrackerAvailable', () => {
    test('should return true for GitHub when GITHUB_TOKEN is set', () => {
      process.env.GITHUB_TOKEN = 'ghp_test_token';

      expect(isTrackerAvailable('github')).toBe(true);
      expect(isTrackerAvailable('linear')).toBe(false);
    });

    test('should return true for Linear when LINEAR_API_KEY is set', () => {
      process.env.LINEAR_API_KEY = 'lin_test_key';

      expect(isTrackerAvailable('github')).toBe(false);
      expect(isTrackerAvailable('linear')).toBe(true);
    });

    test('should return false when neither API key is set', () => {
      expect(isTrackerAvailable('github')).toBe(false);
      expect(isTrackerAvailable('linear')).toBe(false);
    });
  });

  describe('getDefaultTracker', () => {
    test('should return null when no trackers are available', () => {
      expect(getDefaultTracker()).toBeNull();
    });

    test('should return github when only GitHub is available', () => {
      process.env.GITHUB_TOKEN = 'ghp_test_token';

      expect(getDefaultTracker()).toBe('github');
    });

    test('should return linear when only Linear is available', () => {
      process.env.LINEAR_API_KEY = 'lin_test_key';

      expect(getDefaultTracker()).toBe('linear');
    });

    test('should prefer GitHub when both trackers are available', () => {
      process.env.GITHUB_TOKEN = 'ghp_test_token';
      process.env.LINEAR_API_KEY = 'lin_test_key';

      expect(getDefaultTracker()).toBe('github');
    });
  });

  describe('getMissingTrackerError', () => {
    test('should provide helpful error message for missing GitHub configuration', () => {
      const error = getMissingTrackerError('github');

      expect(error).toContain('github issue tracker is not properly configured');
      expect(error).toContain('GITHUB_TOKEN');
      expect(error).toContain('No issue trackers are currently configured');
    });

    test('should provide helpful error message for missing Linear configuration', () => {
      const error = getMissingTrackerError('linear');

      expect(error).toContain('linear issue tracker is not properly configured');
      expect(error).toContain('LINEAR_API_KEY');
      expect(error).toContain('No issue trackers are currently configured');
    });

    test('should suggest available alternatives when other trackers are configured', () => {
      process.env.LINEAR_API_KEY = 'lin_test_key';

      const error = getMissingTrackerError('github');

      expect(error).toContain('Available trackers: linear');
      expect(error).toContain('Consider changing your issueTracker config');
    });

    test('should list multiple available trackers', () => {
      process.env.GITHUB_TOKEN = 'ghp_test_token';
      process.env.LINEAR_API_KEY = 'lin_test_key';

      const error = getMissingTrackerError('github'); // This wouldn't normally happen but tests the logic

      expect(error).toContain('Available trackers: github, linear');
    });
  });

  describe('API key validation edge cases', () => {
    test('should handle various truthy and falsy API key values', () => {
      const testCases = [
        { value: 'valid_token', expected: true },
        { value: '0', expected: true }, // Truthy string
        { value: 'false', expected: true }, // Truthy string
        { value: '', expected: false }, // Falsy
        { value: undefined, expected: false }, // Falsy
      ];

      for (const testCase of testCases) {
        // Reset environment
        delete process.env.GITHUB_TOKEN;

        if (testCase.value !== undefined) {
          process.env.GITHUB_TOKEN = testCase.value;
        }

        expect(isTrackerAvailable('github')).toBe(testCase.expected);
      }
    });
  });

  describe('environment edge cases', () => {
    test('should handle multiple API keys being set and unset', () => {
      // Start with both unset
      expect(getAvailableTrackers().available).toEqual([]);

      // Set GitHub
      process.env.GITHUB_TOKEN = 'github_token';
      expect(getAvailableTrackers().available).toEqual(['github']);

      // Add Linear
      process.env.LINEAR_API_KEY = 'linear_key';
      expect(getAvailableTrackers().available).toEqual(['github', 'linear']);

      // Remove GitHub
      delete process.env.GITHUB_TOKEN;
      expect(getAvailableTrackers().available).toEqual(['linear']);

      // Remove Linear
      delete process.env.LINEAR_API_KEY;
      expect(getAvailableTrackers().available).toEqual([]);
    });

    test('should handle whitespace in API keys', () => {
      process.env.GITHUB_TOKEN = '   github_token_with_spaces   ';
      process.env.LINEAR_API_KEY = '\n\tlinear_key_with_whitespace\n\t';

      // Current implementation treats any truthy string as valid
      expect(isTrackerAvailable('github')).toBe(true);
      expect(isTrackerAvailable('linear')).toBe(true);
    });
  });

  describe('error message formatting', () => {
    test('should format error messages consistently', () => {
      const githubError = getMissingTrackerError('github');
      const linearError = getMissingTrackerError('linear');

      // Both should have similar structure
      expect(githubError).toMatch(/^github issue tracker is not properly configured/);
      expect(linearError).toMatch(/^linear issue tracker is not properly configured/);

      // Both should mention environment variables
      expect(githubError).toContain('GITHUB_TOKEN');
      expect(linearError).toContain('LINEAR_API_KEY');

      // Both should end with configuration advice
      expect(githubError).toContain('environment variable');
      expect(linearError).toContain('environment variable');
    });

    test('should provide different suggestions based on available trackers', () => {
      // No trackers available
      const errorNoTrackers = getMissingTrackerError('github');
      expect(errorNoTrackers).toContain('No issue trackers are currently configured');

      // One tracker available
      process.env.LINEAR_API_KEY = 'lin_key';
      const errorWithAlternative = getMissingTrackerError('github');
      expect(errorWithAlternative).toContain('Available trackers: linear');
      expect(errorWithAlternative).toContain('Consider changing');

      // Both trackers available (edge case)
      process.env.GITHUB_TOKEN = 'gh_key';
      const errorBothAvailable = getMissingTrackerError('linear'); // Asking for linear when we have github
      expect(errorBothAvailable).toContain('Available trackers: github, linear');
    });
  });

  describe('concurrent access', () => {
    test('should handle concurrent calls to getAvailableTrackers', () => {
      process.env.GITHUB_TOKEN = 'github_token';
      process.env.LINEAR_API_KEY = 'linear_key';

      // Call multiple times concurrently
      const promises = Array(10)
        .fill(0)
        .map(() => Promise.resolve(getAvailableTrackers()));

      return Promise.all(promises).then((results) => {
        // All results should be identical
        results.forEach((result) => {
          expect(result.available).toEqual(['github', 'linear']);
          expect(result.github).toBe(true);
          expect(result.linear).toBe(true);
        });
      });
    });

    test('should handle environment changes during execution', () => {
      // Start with no tokens
      let available1 = getAvailableTrackers();
      expect(available1.available).toEqual([]);

      // Set a token mid-execution
      process.env.GITHUB_TOKEN = 'new_token';
      let available2 = getAvailableTrackers();
      expect(available2.available).toEqual(['github']);

      // The function should reflect current environment state
      expect(available1.available).not.toEqual(available2.available);
    });
  });

  describe('type safety and contract validation', () => {
    test('getAvailableTrackers should return expected object structure', () => {
      const result = getAvailableTrackers();

      expect(typeof result).toBe('object');
      expect(typeof result.github).toBe('boolean');
      expect(typeof result.linear).toBe('boolean');
      expect(Array.isArray(result.available)).toBe(true);
      expect(Array.isArray(result.unavailable)).toBe(true);

      // available and unavailable should be complementary
      expect(result.available.length + result.unavailable.length).toBe(2);

      // Check that arrays contain only valid tracker names
      result.available.forEach((tracker) => {
        expect(['github', 'linear']).toContain(tracker);
      });
      result.unavailable.forEach((tracker) => {
        expect(['github', 'linear']).toContain(tracker);
      });

      // No duplicates
      const allTrackers = [...result.available, ...result.unavailable];
      expect(new Set(allTrackers).size).toBe(allTrackers.length);
    });

    test('isTrackerAvailable should only accept valid tracker names', () => {
      // Valid calls
      expect(() => isTrackerAvailable('github')).not.toThrow();
      expect(() => isTrackerAvailable('linear')).not.toThrow();

      // The function should handle any string input gracefully
      // TypeScript will catch invalid inputs at compile time
      expect(typeof isTrackerAvailable('github')).toBe('boolean');
      expect(typeof isTrackerAvailable('linear')).toBe('boolean');
    });

    test('getDefaultTracker should return valid values', () => {
      const result = getDefaultTracker();

      // Should be null or a valid tracker name
      if (result !== null) {
        expect(['github', 'linear']).toContain(result);
      }

      expect(typeof result === 'string' || result === null).toBe(true);
    });
  });
});
