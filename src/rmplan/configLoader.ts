import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { quiet } from '../common/process.js';
import { getGitRoot } from '../common/git.js'; // Assuming logging exists
import { debugLog, error, log, warn } from '../logging.js';
import { type RmplanConfig, rmplanConfigSchema, getDefaultConfig } from './configSchema.js';

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

  mergeConfigKey('postApplyCommands');
  mergeConfigKey('paths');
  mergeConfigKey('autoexamples');
  mergeConfigKey('models');
  mergeConfigKey('modelApiKeys');

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
  if (overridePath) {
    const absoluteOverridePath = path.resolve(overridePath);
    const fileExists = await Bun.file(absoluteOverridePath).exists();
    if (!fileExists) {
      throw new Error(`Specified configuration file not found: ${absoluteOverridePath}`);
    }
    debugLog(`Using configuration file specified via override: ${absoluteOverridePath}`);
    return absoluteOverridePath;
  }

  try {
    const gitRoot = await getGitRoot();
    if (!gitRoot) {
      debugLog('Could not determine Git repository root. Skipping default config search.');
      return null;
    }
    const defaultPath = path.join(gitRoot, '.rmfilter', 'config', 'rmplan.yml');
    const fileExists = await Bun.file(defaultPath).exists();
    debugLog(`Checking for default configuration file at: ${defaultPath}`);
    return fileExists ? defaultPath : null;
  } catch (err: any) {
    debugLog(`Error finding Git root or checking default config: ${err.message}`);
    return null; // Gracefully handle errors like not being in a git repo
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
  if (foundConfigs.has(overridePath || '')) {
    return foundConfigs.get(overridePath || '')!;
  }

  let configPath: string | null = null;
  try {
    configPath = await findConfigPath(overridePath);
  } catch (err: any) {
    // findConfigPath only throws if overridePath is specified and not found
    error(`Error finding configuration file: ${err.message}`);
    // Re-throw to halt execution as the user explicitly requested a file that doesn't exist.
    throw err;
  }

  try {
    // Load the main configuration
    const config = await loadConfig(configPath);

    // Find and load local override configuration if it exists
    const localConfigPath = await findLocalConfigPath(configPath);
    let effectiveConfig: RmplanConfig;

    if (localConfigPath) {
      try {
        // Load the local override configuration
        const localConfig = await loadConfig(localConfigPath);

        // Merge the configurations with local overriding main
        effectiveConfig = mergeConfigs(config, localConfig);

        debugLog(
          'Loaded configuration files',
          configPath ? `Main: ${configPath}` : 'Default config',
          `\nLocal override: ${localConfigPath}`
        );
      } catch (localErr: any) {
        // If there's a validation error in the local config, log it but continue with the main config
        warn(`Error loading local override configuration: ${localErr.message}`);
        warn('Continuing with main configuration only');

        if (!quiet) {
          log('Loaded configuration file', configPath);
        }

        effectiveConfig = config;
      }
    } else {
      debugLog('Loaded configuration file', configPath);
      effectiveConfig = config;
    }

    foundConfigs.set(overridePath || '', effectiveConfig);
    return effectiveConfig;
  } catch (err: any) {
    // loadConfig only throws on validation errors. Read/parse errors return default config.
    error(`Error loading or validating configuration: ${err.message}`);
    // Re-throw validation errors to halt execution.
    throw err;
  }
}
