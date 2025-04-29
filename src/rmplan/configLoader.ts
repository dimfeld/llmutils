import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { getGitRoot } from '../rmfilter/utils.js'; // Assuming logging exists
import { debugLog } from '../logging.js';
import { type RmplanConfig, rmplanConfigSchema, getDefaultConfig } from './configSchema.js';

/**
 * Finds the absolute path to the rmplan configuration file.
 *
 * It searches in the following order:
 * 1. The path specified by `overridePath` (if provided).
 * 2. The default path `.rmfilter/rmplan.yml` in the Git repository root.
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
    const defaultPath = path.join(gitRoot, '.rmfilter', 'rmplan.yml');
    const fileExists = await Bun.file(defaultPath).exists();
    debugLog(`Checking for default configuration file at: ${defaultPath}`);
    return fileExists ? defaultPath : null;
  } catch (error: any) {
    debugLog(`Error finding Git root or checking default config: ${error.message}`);
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
  } catch (error: any) {
    // Handle file reading errors (e.g., permissions)
    console.error(`Error reading configuration file ${configPath}: ${error.message}`);
    debugLog('File reading failed. Falling back to default configuration.');
    // Return default here as the file might be inaccessible temporarily, similar to parsing errors.
    return getDefaultConfig();
  }

  let parsedYaml: any;
  try {
    parsedYaml = yaml.load(fileContent);
    // Handle cases where YAML parsing results in null or undefined for an empty file
    if (parsedYaml === null || typeof parsedYaml === 'undefined') {
      parsedYaml = {}; // Treat empty file as empty object for validation
    }
  } catch (error: any) {
    console.error(`Error parsing YAML file ${configPath}: ${error.message}`);
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
 * Orchestrates finding, loading, parsing, and validating the rmplan configuration.
 * Handles errors gracefully and logs user-friendly messages.
 *
 * @param overridePath - An optional path explicitly provided by the user (e.g., via CLI flag).
 * @returns The effective RmplanConfig object (either loaded or default).
 * @throws {Error} If configuration loading fails due to file not found (for override) or validation errors.
 */
export async function loadEffectiveConfig(overridePath?: string): Promise<RmplanConfig> {
  let configPath: string | null = null;
  try {
    configPath = await findConfigPath(overridePath);
  } catch (error: any) {
    // findConfigPath only throws if overridePath is specified and not found
    console.error(`Error finding configuration file: ${error.message}`);
    // Re-throw to halt execution as the user explicitly requested a file that doesn't exist.
    throw error;
  }

  try {
    const config = await loadConfig(configPath);
    return config;
  } catch (error: any) {
    // loadConfig only throws on validation errors. Read/parse errors return default config.
    console.error(`Error loading or validating configuration: ${error.message}`);
    // Re-throw validation errors to halt execution.
    throw error;
  }
}
