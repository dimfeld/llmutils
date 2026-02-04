import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { quiet } from '../common/process.js';
import { debugLog, error, log, warn } from '../logging.js';
import { describeRemoteForLogging } from './external_storage_utils.js';
import { type TimConfig, timConfigSchema, getDefaultConfig } from './configSchema.js';
import {
  RepositoryConfigResolver,
  type RepositoryConfigResolution,
} from './repository_config_resolver.js';

/**
 * Deeply merges two TimConfig objects, with localConfig overriding mainConfig.
 * Handles special cases like arrays and nested objects appropriately.
 */
function mergeConfigs(mainConfig: TimConfig, localConfig: TimConfig): TimConfig {
  const merged: TimConfig = { ...mainConfig, ...localConfig };

  function mergeConfigKey<KEY extends keyof TimConfig>(key: KEY) {
    let mainValue: TimConfig[KEY] = mainConfig[key];
    let localValue: TimConfig[KEY] = localConfig[key];

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
  mergeConfigKey('notifications');
  mergeConfigKey('paths');
  mergeConfigKey('postApplyCommands');
  mergeConfigKey('planning');
  mergeConfigKey('tags');
  mergeConfigKey('updateDocs');

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

/**
 * Finds the absolute path to the tim configuration file.
 *
 * It searches in the following order:
 * 1. The path specified by `overridePath` (if provided).
 * 2. The default path `.rmfilter/config/tim.yml` in the Git repository root.
 *
 * @param overridePath - An optional path explicitly provided by the user (e.g., via CLI flag).
 * @returns The absolute path to the configuration file if found, otherwise `null`.
 * @throws {Error} If `overridePath` is provided but the file does not exist.
 */
export async function findConfigPath(overridePath?: string): Promise<string | null> {
  const resolver = await RepositoryConfigResolver.create({ overridePath });
  const resolution = await resolver.resolve();
  return resolution.configPath;
}

/**
 * Finds the path to the global tim configuration file in ~/.config/tim/config.yml.
 * Skips loading if TIM_LOAD_GLOBAL_CONFIG env var is '0' or 'false'.
 */
export async function findGlobalConfigPath(): Promise<string | null> {
  const loadGlobalConfig = process.env.TIM_LOAD_GLOBAL_CONFIG;
  if (loadGlobalConfig === '0' || loadGlobalConfig === 'false') {
    debugLog('Skipping global configuration (TIM_LOAD_GLOBAL_CONFIG is disabled)');
    return null;
  }

  const configPath = path.join(os.homedir(), '.config', 'tim', 'config.yml');
  const fileExists = await Bun.file(configPath).exists();

  if (fileExists) {
    debugLog(`Found global configuration at: ${configPath}`);
    return configPath;
  }

  return null;
}

/**
 * Loads, parses, and validates the tim configuration from a given file path.
 *
 * @param configPath - The absolute path to the configuration file, or null if none was found/specified.
 * @returns The validated configuration object. Returns default configuration if configPath is null or YAML parsing fails.
 * @throws {Error} If the configuration file exists but fails schema validation.
 */
export async function loadConfig(configPath: string | null): Promise<TimConfig> {
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

  const result = timConfigSchema.safeParse(parsedYaml);

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
 * Finds the path to a local override configuration file, which is tim.local.yml
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
  // Check for tim.local.yml first, then fall back to the old rmplan.local.yml name
  for (const localName of ['tim.local.yml', 'rmplan.local.yml']) {
    const localConfigPath = path.join(dir, localName);
    const fileExists = await Bun.file(localConfigPath).exists();

    if (fileExists) {
      debugLog(`Found local override configuration at: ${localConfigPath}`);
      return localConfigPath;
    }
  }

  return null;
}

let foundConfigs: Map<string, TimConfig> = new Map();

/**
 * Clears the configuration cache. This is primarily for testing purposes.
 */
export function clearConfigCache(): void {
  foundConfigs.clear();
}

export interface LoadEffectiveConfigOptions {
  /** When true, suppress informational messages like "Using external tim storage at ..." */
  quiet?: boolean;
}

function assertNotificationCommandConfigured(config: TimConfig): void {
  const notificationConfig = config.notifications;
  if (!notificationConfig) {
    return;
  }
  if (notificationConfig.enabled === false) {
    return;
  }
  if (!notificationConfig.command) {
    throw new Error('Notification command is required unless notifications are disabled.');
  }
}

/**
 * Orchestrates finding, loading, parsing, and validating the tim configuration.
 * Handles errors gracefully and logs user-friendly messages.
 * If a tim.local.yml file exists in the same directory as the main config,
 * its settings will override the main config.
 *
 * @param overridePath - An optional path explicitly provided by the user (e.g., via CLI flag).
 * @param options - Optional configuration options (e.g., quiet mode)
 * @returns The effective TimConfig object (either loaded or default).
 * @throws {Error} If configuration loading fails due to file not found (for override) or validation errors.
 */
export async function loadEffectiveConfig(
  overridePath?: string,
  options: LoadEffectiveConfigOptions = {}
): Promise<TimConfig> {
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
    const globalConfigPath = await findGlobalConfigPath();
    const resolvedConfigPath = configPath ? path.resolve(configPath) : null;
    const resolvedGlobalConfigPath = globalConfigPath ? path.resolve(globalConfigPath) : null;
    const shouldLoadGlobal = Boolean(
      globalConfigPath && (!resolvedConfigPath || resolvedGlobalConfigPath !== resolvedConfigPath)
    );
    const globalConfig =
      shouldLoadGlobal && globalConfigPath ? await loadConfig(globalConfigPath) : undefined;
    const configExists = configPath ? await Bun.file(configPath).exists() : false;
    const baseConfig = getDefaultConfig();
    const config = configExists ? await loadConfig(configPath) : undefined;
    const localConfigPath = await findLocalConfigPath(configPath);
    let effectiveConfig: TimConfig;

    if (globalConfig) {
      effectiveConfig = mergeConfigs(baseConfig, globalConfig);
    } else {
      effectiveConfig = baseConfig;
    }

    if (config) {
      effectiveConfig = mergeConfigs(effectiveConfig, config);
    }

    if (localConfigPath) {
      try {
        const localConfig = await loadConfig(localConfigPath);
        effectiveConfig = mergeConfigs(effectiveConfig, localConfig);

        const configSources = [
          configPath && config ? `Main: ${configPath}` : 'Default config',
          shouldLoadGlobal && globalConfigPath ? `\nGlobal: ${globalConfigPath}` : null,
          `\nLocal override: ${localConfigPath}`,
        ].filter((entry): entry is string => entry !== null);

        debugLog('Loaded configuration files', ...configSources);
      } catch (localErr: any) {
        warn(`Error loading local override configuration: ${localErr.message}`);
        warn('Continuing with main configuration only');

        if (!quiet && configPath && config) {
          log('Loaded configuration file', configPath);
        } else if (!quiet && globalConfigPath) {
          log('Loaded configuration file', globalConfigPath);
        }
      }
    } else {
      if (configPath && config) {
        debugLog('Loaded configuration file', configPath);
      } else if (shouldLoadGlobal && globalConfigPath) {
        debugLog('Loaded configuration file', globalConfigPath);
      }
    }

    assertNotificationCommandConfigured(effectiveConfig);

    const configWithMetadata: TimConfig = {
      ...effectiveConfig,
      isUsingExternalStorage: resolution.usingExternalStorage,
      externalRepositoryConfigDir: resolution.repositoryConfigDir,
      resolvedConfigPath: configPath,
      repositoryConfigName: resolution.repositoryName,
      repositoryRemoteUrl: resolution.remoteUrl ?? null,
    };

    if (resolution.usingExternalStorage && resolution.repositoryConfigDir && !options.quiet) {
      log(`Using external tim storage at ${resolution.repositoryConfigDir}`);
    }

    foundConfigs.set(cacheKey, configWithMetadata);
    return configWithMetadata;
  } catch (err: any) {
    error(`Error loading or validating configuration: ${err.message}`);
    throw err;
  }
}

/**
 * Best-effort loader for global configuration, intended for notification fallbacks.
 * Returns the default config when the global config is missing or invalid.
 */
export async function loadGlobalConfigForNotifications(overridePath?: string): Promise<TimConfig> {
  const baseConfig = getDefaultConfig();
  try {
    const globalConfigPath = await findGlobalConfigPath();
    if (!globalConfigPath) {
      return baseConfig;
    }

    const resolvedGlobalPath = path.resolve(globalConfigPath);
    if (overridePath && path.resolve(overridePath) === resolvedGlobalPath) {
      return baseConfig;
    }

    const globalConfig = await loadConfig(globalConfigPath);
    return mergeConfigs(baseConfig, globalConfig);
  } catch (err) {
    debugLog('Failed to load global configuration for notification fallback:', err);
    return baseConfig;
  }
}
