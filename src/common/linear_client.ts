import { LinearClient } from '@linear/sdk';
import { debugLog } from '../logging.ts';

/** Cached Linear client instance */
let cachedLinearClient: LinearClient | null = null;

/**
 * Checks if Linear is configured by verifying that the LINEAR_API_KEY environment variable is set.
 * @returns {boolean} True if LINEAR_API_KEY is present and not just whitespace, false otherwise
 */
export function isLinearConfigured(): boolean {
  return Boolean(process.env.LINEAR_API_KEY?.trim());
}

/**
 * Gets or creates a Linear SDK client instance.
 * 
 * This function reads the LINEAR_API_KEY from environment variables and initializes
 * the LinearClient from @linear/sdk. The client instance is cached for reuse across
 * multiple calls to avoid unnecessary reinitialization.
 * 
 * @returns {LinearClient} The Linear SDK client instance
 * @throws {Error} When LINEAR_API_KEY environment variable is not set
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
export function getLinearClient(): LinearClient {
  // Return cached instance if available
  if (cachedLinearClient) {
    debugLog('Using cached Linear client instance');
    return cachedLinearClient;
  }

  // Check if Linear API key is configured
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'LINEAR_API_KEY environment variable is not set. ' +
      'Please set your Linear API key to use Linear integration. ' +
      'You can obtain an API key from: https://linear.app/settings/api'
    );
  }

  debugLog('Initializing new Linear client with API key');

  try {
    // Initialize the Linear client with the API key
    cachedLinearClient = new LinearClient({
      apiKey,
    });

    debugLog('Linear client initialized successfully');
    return cachedLinearClient;
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
  debugLog('Clearing cached Linear client instance');
  cachedLinearClient = null;
}