import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { parseGitRemoteUrl } from '../common/git_url_parser.js';
import { quiet } from '../common/process.js';
import { debugLog, error, log, warn } from '../logging.js';
import { type RmplanConfig, rmplanConfigSchema, getDefaultConfig } from './configSchema.js';
import {
  RepositoryConfigResolver,
  type RepositoryConfigResolution,
} from './repository_config_resolver.js';

/**
 * Deeply merges two RmplanConfig objects, with localConfig overriding mainConfig.
 * Handles special cases like arrays and nested objects appropriately.
 */
function mergeConfigs(mainConfig: RmplanConfig, localConfig: RmplanConfig): RmplanConfig {
  const merged: RmplanConfig = { ...mainConfig, ...localConfig };

  function mergeConfigKey<KEY extends keyof RmplanConfig>(key: KEY) {
    let mainValue: RmplanConfig[KEY] = mainConfig[key];
    let localValue: RmplanConfig[KEY] = localConfig[key];

    if (localValue === undefined) {
      return;
    }

    if (Array.isArray(localValue)) {
      if (mainValue) {
        // @ts-expect-error hard to specify this is an array
        merged[key] = [...(mainValue as any[]), ...localValue];
      } else {
        merged[key] = localValue;
      }
    } else if (typeof localValue === 'object') {
      if (mainValue) {
        merged[key] = { ...(mainValue as object), ...localValue };
      } else {
        merged[key] = localValue;
      }
    } else {
      merged[key] = localValue;
    }
  }

  // Do deep merge for select paths

  mergeConfigKey('answerPr');
  mergeConfigKey('autoexamples');
  mergeConfigKey('modelApiKeys');
  mergeConfigKey('models');
  mergeConfigKey('paths');
  mergeConfigKey('postApplyCommands');
  mergeConfigKey('planning');

  // Handle executors: deep merge objects
  if (localConfig.executors !== undefined) {
    if (mainConfig.executors && localConfig.executors) {
      // Deep merge executor options
      const mergedExecutors: Record<string, any> = { ...mainConfig.executors };

      for (const [executorName, localOptions] of Object.entries(localConfig.executors)) {
        if (
          mergedExecutors[executorName] &&
          typeof localOptions === 'object' &&
          !Array.isArray(localOptions)
        ) {
          // If the executor exists in main config and local options is an object, merge them
          mergedExecutors[executorName] = {
            ...mergedExecutors[executorName],
            ...localOptions,
          };
        } else {
          // Otherwise, use the local config value directly
          mergedExecutors[executorName] = localOptions;
        }
      }

      merged.executors = mergedExecutors;
    } else {
      merged.executors = localConfig.executors;
    }
  }

  return merged;
}

function trimQueryAndFragment(value: string): string {
  return value.replace(/[?#].*$/, '');
}

function describeRemoteForLogging(remoteUrl?: string | null): string {
  if (!remoteUrl) {
    return 'none detected';
  }

  const parsed = parseGitRemoteUrl(remoteUrl);
  if (parsed) {
    if (parsed.host && parsed.fullName) {
      return trimQueryAndFragment(`${parsed.host}/${parsed.fullName}`);
    }

    if (parsed.host && parsed.path) {
      return trimQueryAndFragment(`${parsed.host}/${parsed.path}`);
    }

    if (parsed.fullName) {
      return trimQueryAndFragment(parsed.fullName);
    }

    if (parsed.host) {
      return trimQueryAndFragment(parsed.host);
    }
  }

  return trimQueryAndFragment(stripRemoteCredentials(remoteUrl));
}

function stripRemoteCredentials(remote: string): string {
  if (remote.includes('://')) {
    try {
      const parsedUrl = new URL(remote);
      return `${parsedUrl.host}${parsedUrl.pathname}` || parsedUrl.host;
    } catch {
      // Fall through to best-effort sanitisation below when URL parsing fails.
    }
  }

  const atIndex = remote.indexOf('@');
  if (atIndex !== -1) {
    return remote.slice(atIndex + 1);
  }

  return remote;
}

/**
 * Finds the absolute path to the rmplan configuration file.
 *
 * It searches in the following order:
 * 1. The path specified by `overridePath` (if provided).
 * 2. The default path `.rmfilter/config/rmplan.yml` in the Git repository root.
 *
 * @param overridePath - An optional path explicitly provided by the user (e.g., via CLI flag).
 * @returns The absolute path to the configuration file if found, otherwise `null`.
 * @throws {Error} If `overridePath` is provided but the file does not exist.
 */
export async function findConfigPath(overridePath?: string): Promise<string | null> {
  const resolver = await RepositoryConfigResolver.create({ overridePath });
  try {
    const resolution = await resolver.resolve();
    return resolution.configPath;
  } catch (error) {
    // Maintain legacy behavior when override path is missing.
    throw error;
  }
}

/**
 * Loads, parses, and validates the rmplan configuration from a given file path.
 *
 * @param configPath - The absolute path to the configuration file, or null if none was found/specified.
 * @returns The validated configuration object. Returns default configuration if configPath is null or YAML parsing fails.
 * @throws {Error} If the configuration file exists but fails schema validation.
 */
export async function loadConfig(configPath: string | null): Promise<RmplanConfig> {
  if (configPath === null) {
    debugLog('No configuration file specified or found. Using default configuration.');
    return getDefaultConfig();
  }

  debugLog(`Loading configuration from: ${configPath}`);
  let fileContent: string;
  try {
    fileContent = await Bun.file(configPath).text();
  } catch (err: any) {
    debugLog('File reading failed. Falling back to default configuration.');
    // Return default here as the file might just not exist.
    return getDefaultConfig();
  }

  let parsedYaml: any;
  try {
    parsedYaml = yaml.load(fileContent);
    // Handle cases where YAML parsing results in null or undefined for an empty file
    if (parsedYaml === null || typeof parsedYaml === 'undefined') {
      parsedYaml = {}; // Treat empty file as empty object for validation
    }
  } catch (err: any) {
    error(`Error parsing YAML file ${configPath}: ${err.message}`);
    debugLog('YAML parsing failed. Falling back to default configuration.');
    return getDefaultConfig(); // Return default on YAML parse error as requested
  }

  const result = rmplanConfigSchema.safeParse(parsedYaml);

  if (!result.success) {
    const errorDetails = result.error.issues
      .map((issue) => `- ${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('\n');
    const errorMessage = `Invalid configuration in ${configPath}:\n${errorDetails}`;
    // Throw an error for validation failures as requested
    throw new Error(errorMessage);
  }

  debugLog(`Successfully loaded and validated configuration from ${configPath}`);

  return result.data;
}

/**
 * Finds the path to a local override configuration file, which is rmplan.local.yml
 * in the same directory as the main config file.
 *
 * @param mainConfigPath - The path to the main configuration file
 * @returns The path to the local override config if it exists, null otherwise
 */
export async function findLocalConfigPath(mainConfigPath: string | null): Promise<string | null> {
  if (!mainConfigPath) {
    return null;
  }

  const dir = path.dirname(mainConfigPath);
  const localConfigPath = path.join(dir, 'rmplan.local.yml');
  const fileExists = await Bun.file(localConfigPath).exists();

  if (fileExists) {
    debugLog(`Found local override configuration at: ${localConfigPath}`);
    return localConfigPath;
  }

  return null;
}

let foundConfigs: Map<string, RmplanConfig> = new Map();

/**
 * Clears the configuration cache. This is primarily for testing purposes.
 */
export function clearConfigCache(): void {
  foundConfigs.clear();
}

/**
 * Orchestrates finding, loading, parsing, and validating the rmplan configuration.
 * Handles errors gracefully and logs user-friendly messages.
 * If a rmplan.local.yml file exists in the same directory as the main config,
 * its settings will override the main config.
 *
 * @param overridePath - An optional path explicitly provided by the user (e.g., via CLI flag).
 * @returns The effective RmplanConfig object (either loaded or default).
 * @throws {Error} If configuration loading fails due to file not found (for override) or validation errors.
 */
export async function loadEffectiveConfig(overridePath?: string): Promise<RmplanConfig> {
  let resolution: RepositoryConfigResolution;
  try {
    const resolver = await RepositoryConfigResolver.create({ overridePath });
    resolution = await resolver.resolve();
  } catch (err: any) {
    error(`Error finding configuration file: ${err.message}`);
    throw err;
  }

  const cacheKey = overridePath ? path.resolve(overridePath) : (resolution.gitRoot ?? '');
  const cachedConfig = foundConfigs.get(cacheKey);
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = resolution.configPath;

  try {
    const config = await loadConfig(configPath);
    const localConfigPath = await findLocalConfigPath(configPath);
    let effectiveConfig: RmplanConfig;

    if (localConfigPath) {
      try {
        const localConfig = await loadConfig(localConfigPath);
        effectiveConfig = mergeConfigs(config, localConfig);

        debugLog(
          'Loaded configuration files',
          configPath ? `Main: ${configPath}` : 'Default config',
          `\nLocal override: ${localConfigPath}`
        );
      } catch (localErr: any) {
        warn(`Error loading local override configuration: ${localErr.message}`);
        warn('Continuing with main configuration only');

        if (!quiet && configPath) {
          log('Loaded configuration file', configPath);
        }

        effectiveConfig = config;
      }
    } else {
      debugLog('Loaded configuration file', configPath);
      effectiveConfig = config;
    }

    const configWithMetadata: RmplanConfig = {
      ...effectiveConfig,
      isUsingExternalStorage: resolution.usingExternalStorage,
      externalRepositoryConfigDir: resolution.repositoryConfigDir,
      resolvedConfigPath: configPath,
      repositoryConfigName: resolution.repositoryName,
      repositoryRemoteUrl: resolution.remoteUrl ?? null,
    };

    if (resolution.usingExternalStorage && resolution.repositoryConfigDir) {
      const externalConfigPath =
        resolution.externalConfigPath ??
        path.join(resolution.repositoryConfigDir, '.rmfilter', 'config', 'rmplan.yml');
      const externalTasksDir =
        resolution.externalTasksDir ?? path.join(resolution.repositoryConfigDir, 'tasks');
      const localConfigPath = resolution.gitRoot
        ? path.join(resolution.gitRoot, '.rmfilter', 'config', 'rmplan.yml')
        : '.rmfilter/config/rmplan.yml';
      const remoteDetails = describeRemoteForLogging(resolution.remoteUrl);
      const repositoryLabel = resolution.repositoryName ?? 'this repository';

      const messageLines = [
        `Using external rmplan storage for ${repositoryLabel}:`,
        `  Base directory: ${resolution.repositoryConfigDir}`,
        `  Configuration file: ${externalConfigPath}`,
        `  Plan directory: ${externalTasksDir}`,
        `  Remote origin: ${remoteDetails}`,
        `  Add ${localConfigPath} to store rmplan data inside the repository.`,
      ];

      log(messageLines.join('\n'));
    }

    foundConfigs.set(cacheKey, configWithMetadata);
    return configWithMetadata;
  } catch (err: any) {
    error(`Error loading or validating configuration: ${err.message}`);
    throw err;
  }
}
