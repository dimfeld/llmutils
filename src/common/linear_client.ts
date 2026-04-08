import { LinearClient } from '@linear/sdk';
import { debugLog } from '../logging.ts';

/** Cached Linear client instances, keyed by API key */
const cachedLinearClients = new Map<string, LinearClient>();

function resolveLinearApiKey(explicitApiKey?: string): string {
  if (explicitApiKey !== undefined) {
    const trimmedExplicitApiKey = explicitApiKey.trim();
    if (!trimmedExplicitApiKey) {
      throw new Error(
        'Linear API key is not set. ' +
          'Provide an explicit API key or set LINEAR_API_KEY to use Linear integration. ' +
          'You can obtain an API key from: https://linear.app/settings/api'
      );
    }

    return trimmedExplicitApiKey;
  }

  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'LINEAR_API_KEY environment variable is not set. ' +
        'Please set your Linear API key to use Linear integration. ' +
        'You can obtain an API key from: https://linear.app/settings/api'
    );
  }

  return apiKey;
}

/**
 * Checks if Linear is configured by verifying that an explicit API key or
 * the LINEAR_API_KEY environment variable is set.
 * @returns {boolean} True if an API key is present and not just whitespace, false otherwise
 */
export function isLinearConfigured(explicitApiKey?: string): boolean {
  const apiKey =
    explicitApiKey !== undefined ? explicitApiKey.trim() : process.env.LINEAR_API_KEY?.trim();
  return Boolean(apiKey);
}

/**
 * Gets or creates a Linear SDK client instance.
 *
 * This function uses an explicit API key when provided, otherwise it reads
 * LINEAR_API_KEY from environment variables. Client instances are cached by API key
 * for reuse across multiple calls.
 *
 * @returns {LinearClient} The Linear SDK client instance
 * @throws {Error} When no API key is available
 *
 * @example
 * ```typescript
 * import { getLinearClient } from './linear_client';
 *
 * try {
 *   const client = getLinearClient();
 *   const issue = await client.issue('TEAM-123');
 * } catch (error) {
 *   console.error('Failed to get Linear client:', error);
 * }
 * ```
 */
export function getLinearClient(explicitApiKey?: string): LinearClient {
  const apiKey = resolveLinearApiKey(explicitApiKey);

  const cachedLinearClient = cachedLinearClients.get(apiKey);
  if (cachedLinearClient) {
    debugLog('Using cached Linear client instance');
    return cachedLinearClient;
  }

  debugLog('Initializing new Linear client with API key');

  try {
    const client = new LinearClient({
      apiKey,
    });
    cachedLinearClients.set(apiKey, client);

    debugLog('Linear client initialized successfully');
    return client;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to initialize Linear client: ${errorMessage}. ` +
        'Please check that your LINEAR_API_KEY is valid.'
    );
  }
}

/**
 * Clears the cached Linear client instance.
 * This is primarily useful for testing scenarios where you need to reset the client state.
 *
 * @internal
 */
export function clearLinearClientCache(): void {
  debugLog('Clearing cached Linear client instances');
  cachedLinearClients.clear();
}
