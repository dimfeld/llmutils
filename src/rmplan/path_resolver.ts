import * as path from 'node:path';
import { getGitRoot } from '../common/git.js';
import { resolveTasksDir, type RmplanConfig } from './configSchema.js';

export interface PlanPathContext {
  gitRoot: string;
  tasksDir: string;
  repositoryConfigDir?: string;
  configBaseDir: string;
}

function computeTasksDir(config: RmplanConfig, gitRoot: string): string {
  if (config.isUsingExternalStorage && config.externalRepositoryConfigDir) {
    const baseDir = config.externalRepositoryConfigDir;
    if (config.paths?.tasks) {
      return path.isAbsolute(config.paths.tasks)
        ? config.paths.tasks
        : path.join(baseDir, config.paths.tasks);
    }
    return path.join(baseDir, 'tasks');
  }

  if (config.paths?.tasks) {
    return path.isAbsolute(config.paths.tasks)
      ? config.paths.tasks
      : path.join(gitRoot, config.paths.tasks);
  }

  return gitRoot;
}

export async function resolvePlanPathContext(config: RmplanConfig): Promise<PlanPathContext> {
  const gitRoot = (await getGitRoot()) || process.cwd();
  const tasksDir = await resolveTasksDir(config);

  const configBaseDir =
    config.isUsingExternalStorage && config.externalRepositoryConfigDir
      ? config.externalRepositoryConfigDir
      : gitRoot;

  return {
    gitRoot,
    tasksDir,
    repositoryConfigDir: config.externalRepositoryConfigDir,
    configBaseDir,
  };
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

export function resolveConfiguredTasksPath(
  config: RmplanConfig,
  gitRoot: string
): string {
  return computeTasksDir(config, gitRoot);
}
