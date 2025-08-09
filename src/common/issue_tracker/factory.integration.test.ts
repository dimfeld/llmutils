import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getIssueTracker, getAvailableTrackers } from './factory.js';
import { GitHubIssueTrackerClient } from './github.js';
import { ModuleMocker } from '../../testing.js';

describe('Issue Tracker Factory Integration', () => {
  const moduleMocker = new ModuleMocker(import.meta);
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
    moduleMocker.clear();
  });

  describe('getIssueTracker with real implementations', () => {
    test('should create GitHub client when GitHub is configured and no config provided', async () => {
      process.env.GITHUB_TOKEN = 'ghp_test_token';
      
      // Mock the config loader to return default config
      await moduleMocker.mock('../../rmplan/configLoader.js', () => ({
        loadEffectiveConfig: async () => ({
          issueTracker: 'github',
        }),
      }));

      const client = await getIssueTracker();

      expect(client).toBeInstanceOf(GitHubIssueTrackerClient);
      expect(client.getDisplayName()).toBe('GitHub');
      expect(client.getConfig().type).toBe('github');
      expect(client.getConfig().apiKey).toBe('ghp_test_token');
    });

    test('should create GitHub client when explicitly configured', async () => {
      process.env.GITHUB_TOKEN = 'ghp_test_token';

      const client = await getIssueTracker({
        issueTracker: 'github',
      });

      expect(client).toBeInstanceOf(GitHubIssueTrackerClient);
      expect(client.getDisplayName()).toBe('GitHub');
      expect(client.getConfig().type).toBe('github');
      expect(client.getConfig().apiKey).toBe('ghp_test_token');
    });

    test('should create Linear client when Linear is configured', async () => {
      process.env.LINEAR_API_KEY = 'lin_test_key';

      // Mock the Linear client creation since we don't have it imported
      await moduleMocker.mock('../linear.js', () => ({
        createLinearClient: (config: any) => ({
          getDisplayName: () => 'Linear',
          getConfig: () => config,
          async fetchIssue() {
            return { issue: {} as any, comments: [] };
          },
          async fetchAllOpenIssues() {
            return [];
          },
          parseIssueIdentifier() {
            return null;
          },
        }),
      }));

      const client = await getIssueTracker({
        issueTracker: 'linear',
      });

      expect(client.getDisplayName()).toBe('Linear');
      expect(client.getConfig().type).toBe('linear');
      expect(client.getConfig().apiKey).toBe('lin_test_key');
    });

    test('should default to github when no issueTracker specified', async () => {
      process.env.GITHUB_TOKEN = 'ghp_test_token';

      const client = await getIssueTracker({});

      expect(client).toBeInstanceOf(GitHubIssueTrackerClient);
      expect(client.getDisplayName()).toBe('GitHub');
    });

    test('should throw error when GitHub is requested but not configured', async () => {
      await expect(getIssueTracker({ issueTracker: 'github' })).rejects.toThrow(
        'github issue tracker is not properly configured. Missing environment variable: GITHUB_TOKEN'
      );
    });

    test('should throw error when Linear is requested but not configured', async () => {
      await expect(getIssueTracker({ issueTracker: 'linear' })).rejects.toThrow(
        'linear issue tracker is not properly configured. Missing environment variable: LINEAR_API_KEY'
      );
    });

    test('should throw error for unsupported tracker type', async () => {
      await expect(getIssueTracker({ issueTracker: 'unsupported' as any })).rejects.toThrow(
        'Unsupported issue tracker: unsupported'
      );
    });

    test('should provide helpful error messages when alternative trackers are available', async () => {
      process.env.LINEAR_API_KEY = 'lin_test_key';

      await expect(getIssueTracker({ issueTracker: 'github' })).rejects.toThrow(
        'github issue tracker is not properly configured. Missing environment variable: GITHUB_TOKEN. Available trackers: linear'
      );
    });

    test('should handle environment variable changes during execution', async () => {
      // Initially no tokens
      expect(getAvailableTrackers().available).toEqual([]);

      // Set GitHub token
      process.env.GITHUB_TOKEN = 'github_token';
      const client1 = await getIssueTracker({ issueTracker: 'github' });
      expect(client1).toBeInstanceOf(GitHubIssueTrackerClient);

      // Add Linear token
      process.env.LINEAR_API_KEY = 'linear_key';
      
      // Mock the Linear client
      await moduleMocker.mock('../linear.js', () => ({
        createLinearClient: (config: any) => ({
          getDisplayName: () => 'Linear',
          getConfig: () => config,
          async fetchIssue() {
            return { issue: {} as any, comments: [] };
          },
          async fetchAllOpenIssues() {
            return [];
          },
          parseIssueIdentifier() {
            return null;
          },
        }),
      }));

      const client2 = await getIssueTracker({ issueTracker: 'linear' });
      expect(client2.getDisplayName()).toBe('Linear');

      // Both should be available
      const available = getAvailableTrackers();
      expect(available.available.sort()).toEqual(['github', 'linear']);
    });
  });

  describe('client functionality integration', () => {
    test('should create working GitHub client that can parse identifiers', async () => {
      process.env.GITHUB_TOKEN = 'ghp_test_token';

      const client = await getIssueTracker({ issueTracker: 'github' });

      // Test identifier parsing (doesn't require API calls)
      const parsed1 = client.parseIssueIdentifier('123');
      expect(parsed1).toEqual({ identifier: '123' });

      const parsed2 = client.parseIssueIdentifier('owner/repo#456');
      expect(parsed2).toEqual({
        identifier: '456',
        owner: 'owner',
        repo: 'repo',
      });

      const parsed3 = client.parseIssueIdentifier('https://github.com/facebook/react/issues/789');
      expect(parsed3).toEqual({
        identifier: '789',
        owner: 'facebook',
        repo: 'react',
        url: 'https://github.com/facebook/react/issues/789',
      });

      const invalid = client.parseIssueIdentifier('invalid-format');
      expect(invalid).toBeNull();
    });

    test('should create client with correct configuration properties', async () => {
      process.env.GITHUB_TOKEN = 'test-token-12345';

      const client = await getIssueTracker({
        issueTracker: 'github',
      });

      const config = client.getConfig();
      expect(config.type).toBe('github');
      expect(config.apiKey).toBe('test-token-12345');
    });

    test('should handle different API key formats', async () => {
      const testCases = [
        'ghp_standardGitHubToken123',
        'github_pat_longPersonalAccessToken456',
        'ghs_shortLivedToken789',
        'simple_token',
      ];

      for (const token of testCases) {
        process.env.GITHUB_TOKEN = token;

        const client = await getIssueTracker({ issueTracker: 'github' });
        expect(client.getConfig().apiKey).toBe(token);
      }
    });
  });

  describe('error handling integration', () => {
    test('should handle missing API keys gracefully', async () => {
      const testCases = [
        {
          tracker: 'github' as const,
          envVar: 'GITHUB_TOKEN',
        },
        {
          tracker: 'linear' as const,
          envVar: 'LINEAR_API_KEY',
        },
      ];

      for (const { tracker, envVar } of testCases) {
        try {
          await getIssueTracker({ issueTracker: tracker });
          expect.unreachable('Should have thrown an error');
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          const errorMessage = (error as Error).message;
          expect(errorMessage).toContain(`${tracker} issue tracker is not properly configured`);
          expect(errorMessage).toContain(`Missing environment variable: ${envVar}`);
        }
      }
    });

    test('should provide contextual error messages', async () => {
      // Test with no trackers available
      try {
        await getIssueTracker({ issueTracker: 'github' });
        expect.unreachable('Should have thrown an error');
      } catch (error) {
        const errorMessage = (error as Error).message;
        expect(errorMessage).toContain('Available trackers: none');
      }

      // Test with alternative tracker available
      process.env.LINEAR_API_KEY = 'linear_key';
      
      try {
        await getIssueTracker({ issueTracker: 'github' });
        expect.unreachable('Should have thrown an error');
      } catch (error) {
        const errorMessage = (error as Error).message;
        expect(errorMessage).toContain('Available trackers: linear');
      }
    });
  });

  describe('configuration loading integration', () => {
    test('should load effective config when no config provided', async () => {
      process.env.GITHUB_TOKEN = 'github_token';

      // Mock config loader with specific configuration
      await moduleMocker.mock('../../rmplan/configLoader.js', () => ({
        loadEffectiveConfig: async () => ({
          issueTracker: 'github',
          otherConfigProperty: 'value',
        }),
      }));

      const client = await getIssueTracker();

      expect(client.getDisplayName()).toBe('GitHub');
      expect(client.getConfig().type).toBe('github');
    });

    test('should use provided config instead of loading', async () => {
      process.env.LINEAR_API_KEY = 'linear_token';

      // Mock config loader - this should NOT be called
      await moduleMocker.mock('../../rmplan/configLoader.js', () => ({
        loadEffectiveConfig: async () => {
          throw new Error('Config loader should not be called');
        },
      }));

      // Mock Linear client
      await moduleMocker.mock('../linear.js', () => ({
        createLinearClient: (config: any) => ({
          getDisplayName: () => 'Linear',
          getConfig: () => config,
          async fetchIssue() {
            return { issue: {} as any, comments: [] };
          },
          async fetchAllOpenIssues() {
            return [];
          },
          parseIssueIdentifier() {
            return null;
          },
        }),
      }));

      // Should use provided config, not call config loader
      const client = await getIssueTracker({ issueTracker: 'linear' });

      expect(client.getDisplayName()).toBe('Linear');
    });
  });

  describe('concurrent usage', () => {
    test('should handle concurrent client creation', async () => {
      process.env.GITHUB_TOKEN = 'github_token';
      process.env.LINEAR_API_KEY = 'linear_token';

      // Mock Linear client
      await moduleMocker.mock('../linear.js', () => ({
        createLinearClient: (config: any) => ({
          getDisplayName: () => 'Linear',
          getConfig: () => config,
          async fetchIssue() {
            return { issue: {} as any, comments: [] };
          },
          async fetchAllOpenIssues() {
            return [];
          },
          parseIssueIdentifier() {
            return null;
          },
        }),
      }));

      const clientPromises = [
        getIssueTracker({ issueTracker: 'github' }),
        getIssueTracker({ issueTracker: 'linear' }),
        getIssueTracker({ issueTracker: 'github' }),
        getIssueTracker({ issueTracker: 'linear' }),
      ];

      const clients = await Promise.all(clientPromises);

      expect(clients[0].getDisplayName()).toBe('GitHub');
      expect(clients[1].getDisplayName()).toBe('Linear');
      expect(clients[2].getDisplayName()).toBe('GitHub');
      expect(clients[3].getDisplayName()).toBe('Linear');

      // Each client should be a separate instance
      expect(clients[0]).not.toBe(clients[2]);
      expect(clients[1]).not.toBe(clients[3]);
    });

    test('should handle environment changes during concurrent operations', async () => {
      // Start with GitHub token
      process.env.GITHUB_TOKEN = 'github_token';

      const githubPromise = getIssueTracker({ issueTracker: 'github' });

      // Add Linear token during GitHub client creation
      process.env.LINEAR_API_KEY = 'linear_token';

      // Mock Linear client
      await moduleMocker.mock('../linear.js', () => ({
        createLinearClient: (config: any) => ({
          getDisplayName: () => 'Linear',
          getConfig: () => config,
          async fetchIssue() {
            return { issue: {} as any, comments: [] };
          },
          async fetchAllOpenIssues() {
            return [];
          },
          parseIssueIdentifier() {
            return null;
          },
        }),
      }));

      const linearPromise = getIssueTracker({ issueTracker: 'linear' });

      const [githubClient, linearClient] = await Promise.all([githubPromise, linearPromise]);

      expect(githubClient.getDisplayName()).toBe('GitHub');
      expect(linearClient.getDisplayName()).toBe('Linear');
    });
  });

  describe('type safety validation', () => {
    test('should maintain type safety across factory and implementations', async () => {
      process.env.GITHUB_TOKEN = 'github_token';

      const client = await getIssueTracker({ issueTracker: 'github' });

      // These should all be available due to the interface contract
      expect(typeof client.fetchIssue).toBe('function');
      expect(typeof client.fetchAllOpenIssues).toBe('function');
      expect(typeof client.parseIssueIdentifier).toBe('function');
      expect(typeof client.getDisplayName).toBe('function');
      expect(typeof client.getConfig).toBe('function');

      // Return types should be correct
      expect(typeof client.getDisplayName()).toBe('string');
      expect(typeof client.getConfig()).toBe('object');
      expect(client.getConfig().type).toBe('github');

      // Methods should return correct types (tested without making actual API calls)
      const parsedResult = client.parseIssueIdentifier('123');
      if (parsedResult !== null) {
        expect(typeof parsedResult.identifier).toBe('string');
      }
    });
  });
});