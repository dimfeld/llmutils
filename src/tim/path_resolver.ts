import * as path from 'node:path';
import { getGitRoot } from '../common/git.js';
import type { TimConfig } from './configSchema.js';

export interface PlanPathContext {
  gitRoot: string;
  repositoryConfigDir?: string;
  configBaseDir: string;
}

export async function resolvePlanPathContext(config: TimConfig): Promise<PlanPathContext> {
  const gitRoot = (await getGitRoot()) || process.cwd();

  const configBaseDir =
    config.isUsingExternalStorage && config.externalRepositoryConfigDir
      ? config.externalRepositoryConfigDir
      : gitRoot;

  return {
    gitRoot,
    repositoryConfigDir: config.externalRepositoryConfigDir,
    configBaseDir,
  };
}

/**
 * Returns the canonical on-disk directory for plan files.
 */
export function getPlanStorageDir(gitRoot: string): string {
  return path.join(gitRoot, '.tim', 'plans');
}

export function getLegacyAwareSearchDir(gitRoot: string, _configBaseDir?: string): string {
  return getPlanStorageDir(gitRoot);
}

export function resolveConfiguredPath(
  context: PlanPathContext,
  configuredPath?: string | null
): string | undefined {
  if (!configuredPath) {
    return undefined;
  }

  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }

  return path.join(context.configBaseDir, configuredPath);
}
