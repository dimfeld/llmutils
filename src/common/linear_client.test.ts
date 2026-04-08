import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getLinearClient, isLinearConfigured, clearLinearClientCache } from './linear_client.ts';

// Mock the @linear/sdk module
vi.mock('@linear/sdk', () => ({
  LinearClient: vi.fn(),
}));

// Import the mocked constructor
import { LinearClient } from '@linear/sdk';

// Get the mocked constructor
const mockLinearClientConstructor = vi.mocked(LinearClient);

describe('Linear Client', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment to a clean state
    process.env = { ...originalEnv };
    // Clear any cached client instance
    clearLinearClientCache();
    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    // Restore mocks
    vi.restoreAllMocks();
  });

  describe('isLinearConfigured', () => {
    test('should return true when LINEAR_API_KEY is set', () => {
      process.env.LINEAR_API_KEY = 'test-api-key';
      expect(isLinearConfigured()).toBe(true);
    });

    test('should return false when LINEAR_API_KEY is not set', () => {
      delete process.env.LINEAR_API_KEY;
      expect(isLinearConfigured()).toBe(false);
    });

    test('should return false when LINEAR_API_KEY is empty string', () => {
      process.env.LINEAR_API_KEY = '';
      expect(isLinearConfigured()).toBe(false);
    });

    test('should return false when LINEAR_API_KEY is undefined', () => {
      process.env.LINEAR_API_KEY = undefined;
      expect(isLinearConfigured()).toBe(false);
    });

    test('should return false when LINEAR_API_KEY is whitespace only', () => {
      process.env.LINEAR_API_KEY = '   ';
      expect(isLinearConfigured()).toBe(false);
    });

    test('should prefer an explicit API key over environment configuration', () => {
      delete process.env.LINEAR_API_KEY;
      expect(isLinearConfigured('explicit-key')).toBe(true);
      expect(isLinearConfigured('   ')).toBe(false);
    });
  });

  describe('getLinearClient', () => {
    test('should throw descriptive error when LINEAR_API_KEY is not set', async () => {
      delete process.env.LINEAR_API_KEY;

      expect(() => getLinearClient()).toThrow(
        'LINEAR_API_KEY environment variable is not set. ' +
          'Please set your Linear API key to use Linear integration. ' +
          'You can obtain an API key from: https://linear.app/settings/api'
      );
    });

    test('should throw error when LINEAR_API_KEY is empty string', async () => {
      process.env.LINEAR_API_KEY = '';

      expect(() => getLinearClient()).toThrow('LINEAR_API_KEY environment variable is not set.');
    });

    test('should throw error when LINEAR_API_KEY is whitespace only', async () => {
      process.env.LINEAR_API_KEY = '   ';

      expect(() => getLinearClient()).toThrow('LINEAR_API_KEY environment variable is not set.');
    });

    test('should create LinearClient with valid API key', async () => {
      process.env.LINEAR_API_KEY = 'test-api-key';

      // Mock the LinearClient constructor
      const mockLinearClient = {
        apiKey: 'test-api-key',
        testMethod: vi.fn(() => 'mocked'),
      };

      mockLinearClientConstructor.mockImplementation(function (options: any) {
        expect(options.apiKey).toBe('test-api-key');
        return mockLinearClient;
      });

      const client = getLinearClient();
      expect(client).toBe(mockLinearClient);
    });

    test('should create LinearClient with an explicit API key', async () => {
      delete process.env.LINEAR_API_KEY;

      const mockLinearClient = {
        apiKey: 'explicit-api-key',
      };

      mockLinearClientConstructor.mockImplementation(function (options: any) {
        expect(options.apiKey).toBe('explicit-api-key');
        return mockLinearClient;
      });

      const client = getLinearClient('explicit-api-key');
      expect(client).toBe(mockLinearClient);
    });

    test('should cache the client instance and reuse it', async () => {
      process.env.LINEAR_API_KEY = 'test-api-key';

      const mockLinearClient = {
        apiKey: 'test-api-key',
        testMethod: vi.fn(() => 'mocked'),
      };

      mockLinearClientConstructor.mockImplementation(function (options: any) {
        return mockLinearClient;
      });

      // First call should create the client
      const client1 = getLinearClient();
      expect(mockLinearClientConstructor).toHaveBeenCalledTimes(1);
      expect(client1).toBe(mockLinearClient);

      // Second call should return the cached instance
      const client2 = getLinearClient();
      expect(mockLinearClientConstructor).toHaveBeenCalledTimes(1); // Should not be called again
      expect(client2).toBe(mockLinearClient);
      expect(client1).toBe(client2); // Same instance
    });

    test('should cache clients separately by API key', async () => {
      mockLinearClientConstructor.mockImplementation(function (options: any) {
        return { apiKey: options.apiKey };
      });

      const client1 = getLinearClient('key-1');
      const client2 = getLinearClient('key-2');
      const client1Again = getLinearClient('key-1');

      expect(mockLinearClientConstructor).toHaveBeenCalledTimes(2);
      expect(client1).toBe(client1Again);
      expect(client1).not.toBe(client2);
    });

    test('should reject a blank explicit API key', async () => {
      process.env.LINEAR_API_KEY = 'env-key';

      expect(() => getLinearClient('   ')).toThrow(
        'Linear API key is not set. ' +
          'Provide an explicit API key or set LINEAR_API_KEY to use Linear integration. ' +
          'You can obtain an API key from: https://linear.app/settings/api'
      );
    });

    test('should handle LinearClient constructor errors gracefully', async () => {
      process.env.LINEAR_API_KEY = 'invalid-api-key';

      mockLinearClientConstructor.mockImplementation(function (options: any) {
        throw new Error('Invalid API key format');
      });

      expect(() => getLinearClient()).toThrow(
        'Failed to initialize Linear client: Invalid API key format. ' +
          'Please check that your LINEAR_API_KEY is valid.'
      );
    });

    test('should handle non-Error exceptions from LinearClient constructor', async () => {
      process.env.LINEAR_API_KEY = 'invalid-api-key';

      mockLinearClientConstructor.mockImplementation(function (options: any) {
        throw 'Some non-Error exception';
      });

      expect(() => getLinearClient()).toThrow(
        'Failed to initialize Linear client: Some non-Error exception. ' +
          'Please check that your LINEAR_API_KEY is valid.'
      );
    });
  });

  describe('clearLinearClientCache', () => {
    test('should clear the cached client instance', async () => {
      process.env.LINEAR_API_KEY = 'test-api-key';

      const mockLinearClient1 = {
        apiKey: 'test-api-key',
        id: 'client1',
      };

      const mockLinearClient2 = {
        apiKey: 'test-api-key',
        id: 'client2',
      };

      let callCount = 0;
      mockLinearClientConstructor.mockImplementation(function (options: any) {
        callCount++;
        return callCount === 1 ? mockLinearClient1 : mockLinearClient2;
      });

      // Get first client instance
      const client1 = getLinearClient();
      expect(client1).toBe(mockLinearClient1);
      expect(mockLinearClientConstructor).toHaveBeenCalledTimes(1);

      // Clear cache
      clearLinearClientCache();

      // Get client again - should create a new instance
      const client2 = getLinearClient();
      expect(client2).toBe(mockLinearClient2);
      expect(mockLinearClientConstructor).toHaveBeenCalledTimes(2);
      expect(client1).not.toBe(client2);
    });

    test('should handle clearing cache when no client was created', () => {
      // Should not throw even if no client was cached
      expect(() => clearLinearClientCache()).not.toThrow();
    });
  });

  describe('integration behavior', () => {
    test('should work correctly across different API keys', async () => {
      process.env.LINEAR_API_KEY = 'key1';

      let constructorCallCount = 0;
      mockLinearClientConstructor.mockImplementation(function (options: any) {
        constructorCallCount++;
        return { apiKey: options.apiKey };
      });

      const client1 = getLinearClient();
      process.env.LINEAR_API_KEY = 'key2';
      const client2 = getLinearClient();

      expect(constructorCallCount).toBe(2);
      expect(client1.apiKey).toBe('key1');
      expect(client2.apiKey).toBe('key2');
      expect(client1).not.toBe(client2);
    });

    test('should pass through all configuration options to LinearClient constructor', async () => {
      process.env.LINEAR_API_KEY = 'test-key-with-config';

      const mockClient = { configured: true };
      mockLinearClientConstructor.mockImplementation(function (options: any) {
        // Verify the constructor receives the expected configuration structure
        expect(options).toEqual({
          apiKey: 'test-key-with-config',
        });
        return mockClient;
      });

      const client = getLinearClient();
      expect(client).toBe(mockClient);
      expect(mockLinearClientConstructor).toHaveBeenCalledTimes(1);
    });
  });
});
