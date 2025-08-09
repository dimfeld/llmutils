/**
 * Issue tracker factory implementation
 *
 * This module provides a factory for creating issue tracker clients based on
 * configuration, following the same pattern as model_factory.ts. It handles
 * client instantiation, API key validation, and provides helpful error messages.
 */

import { createGitHubClient } from './github.js';
import { createLinearClient } from '../linear.js';
import { loadEffectiveConfig } from '../../rmplan/configLoader.js';
import { debugLog } from '../../logging.js';
import type { RmplanConfig } from '../../rmplan/configSchema.js';
import type {
  IssueTrackerClient,
  IssueTrackerConfig,
  IssueTrackerRegistry,
} from './types.js';

/**
 * Registry of available issue tracker client factories
 */
const issueTrackerRegistry: IssueTrackerRegistry = {
  github: createGitHubClient,
  linear: createLinearClient,
};

/**
 * Check which issue trackers are available based on configured API keys
 *
 * @returns Object indicating which trackers have API keys configured
 */
export function getAvailableTrackers(): {
  github: boolean;
  linear: boolean;
  available: Array<'github' | 'linear'>;
  unavailable: Array<'github' | 'linear'>;
} {
  const github = !!process.env.GITHUB_TOKEN;
  const linear = !!process.env.LINEAR_API_KEY;

  const available: Array<'github' | 'linear'> = [];
  const unavailable: Array<'github' | 'linear'> = [];

  if (github) available.push('github');
  else unavailable.push('github');

  if (linear) available.push('linear');
  else unavailable.push('linear');

  return {
    github,
    linear,
    available,
    unavailable,
  };
}

/**
 * Get an issue tracker client based on configuration
 *
 * @param config Optional configuration. If not provided, loads from the effective config
 * @returns Promise resolving to an IssueTrackerClient instance
 * @throws Error if the tracker is not supported or not properly configured
 */
export async function getIssueTracker(config?: RmplanConfig): Promise<IssueTrackerClient> {
  // Load configuration if not provided
  if (!config) {
    config = await loadEffectiveConfig();
  }

  const trackerType = config.issueTracker || 'github';
  debugLog(`Creating issue tracker client for: ${trackerType}`);

  // Check if the tracker type is supported
  if (!issueTrackerRegistry[trackerType]) {
    throw new Error(`Unsupported issue tracker: ${trackerType}`);
  }

  // Validate that the required API key is present
  const availableTrackers = getAvailableTrackers();
  if (!availableTrackers[trackerType]) {
    const envVarName = trackerType === 'github' ? 'GITHUB_TOKEN' : 'LINEAR_API_KEY';
    throw new Error(
      `${trackerType} issue tracker is not properly configured. ` +
      `Missing environment variable: ${envVarName}. ` +
      `Available trackers: ${availableTrackers.available.join(', ') || 'none'}`
    );
  }

  // Get the appropriate API key
  const apiKey = trackerType === 'github' 
    ? process.env.GITHUB_TOKEN 
    : process.env.LINEAR_API_KEY;

  // Create the tracker configuration
  const trackerConfig: IssueTrackerConfig = {
    type: trackerType,
    apiKey,
  };

  // Create and return the client
  const factory = issueTrackerRegistry[trackerType];
  const client = factory(trackerConfig);

  debugLog(`Successfully created ${trackerType} issue tracker client`);
  return client;
}

/**
 * Get a helpful error message for missing tracker configurations
 *
 * @param requestedTracker The tracker type that was requested
 * @returns A user-friendly error message with suggestions
 */
export function getMissingTrackerError(requestedTracker: 'github' | 'linear'): string {
  const availableTrackers = getAvailableTrackers();
  const envVarName = requestedTracker === 'github' ? 'GITHUB_TOKEN' : 'LINEAR_API_KEY';
  
  let message = `${requestedTracker} issue tracker is not properly configured.\n`;
  message += `Missing environment variable: ${envVarName}\n\n`;
  
  if (availableTrackers.available.length > 0) {
    message += `Available trackers: ${availableTrackers.available.join(', ')}\n`;
    message += `Consider changing your issueTracker config to one of the available options, `;
    message += `or configure the ${envVarName} environment variable.`;
  } else {
    message += `No issue trackers are currently configured.\n`;
    message += `To use GitHub: Set the GITHUB_TOKEN environment variable\n`;
    message += `To use Linear: Set the LINEAR_API_KEY environment variable`;
  }
  
  return message;
}

/**
 * Check if a specific issue tracker is available and configured
 *
 * @param tracker The tracker type to check
 * @returns true if the tracker is available and configured
 */
export function isTrackerAvailable(tracker: 'github' | 'linear'): boolean {
  const available = getAvailableTrackers();
  return available[tracker];
}

/**
 * Get the default issue tracker based on what's available
 *
 * @returns The best available tracker, preferring GitHub if both are available
 */
export function getDefaultTracker(): 'github' | 'linear' | null {
  const available = getAvailableTrackers();
  
  if (available.github) return 'github';
  if (available.linear) return 'linear';
  
  return null;
}