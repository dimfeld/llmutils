import path from 'node:path';
import { getGitRoot } from '../common/git.js';

const TIM_CONFIG_CANDIDATES = [
  '.tim.yml',
  'tim.yml',
  'tim.local.yml',
  '.rmfilter/tim.yml',
  '.rmfilter/config/tim.yml',
  '.rmfilter/tim.local.yml',
  '.rmfilter/config/tim.local.yml',
];

async function findRepoRootFromConfig(startDir: string): Promise<string | null> {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidatePatterns = [...TIM_CONFIG_CANDIDATES].sort(
      (left, right) => right.split('/').length - left.split('/').length
    );
    for (const candidate of candidatePatterns) {
      const candidatePath = path.join(currentDir, candidate);
      const exists = await Bun.file(candidatePath)
        .stat()
        .then((stats) => stats.isFile())
        .catch(() => false);
      if (exists) {
        return currentDir;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function resolvePlanPathForBase(planArg: string, baseDir?: string): string {
  if (path.isAbsolute(planArg)) {
    return planArg;
  }

  return path.resolve(baseDir ?? process.cwd(), planArg);
}

export async function resolveRepoRootForPlanArg(
  planArg: string,
  fallbackDir?: string,
  configPath?: string
): Promise<string> {
  // Absolute plan paths are authoritative — derive repo root from the file's
  // location regardless of configPath. This prevents syncing a plan from repo B
  // into repo A's DB when configPath points at repo A.
  if (path.isAbsolute(planArg)) {
    const directExists = await Bun.file(planArg)
      .stat()
      .then((stats) => stats.isFile())
      .catch(() => false);
    if (directExists) {
      const configuredRoot = await findRepoRootFromConfig(path.dirname(planArg));
      if (configuredRoot) {
        return configuredRoot;
      }
      return (await getGitRoot(path.dirname(planArg))) ?? path.dirname(planArg);
    }
  }

  if (configPath) {
    const resolvedConfigPath = path.resolve(configPath);
    const configDir = path.dirname(resolvedConfigPath);
    const configFile = path.basename(resolvedConfigPath);
    if (configFile === '.tim.yml') {
      return configDir;
    }
    if (configFile === 'tim.yml' || configFile === 'tim.local.yml') {
      if (path.basename(configDir) === '.rmfilter') {
        return path.dirname(configDir);
      }
      if (
        path.basename(configDir) === 'config' &&
        path.basename(path.dirname(configDir)) === '.rmfilter'
      ) {
        return path.dirname(path.dirname(configDir));
      }
      return configDir;
    }

    return (await findRepoRootFromConfig(configDir)) ?? configDir;
  }

  const directPath = resolvePlanPathForBase(planArg);
  const directExists = await Bun.file(directPath)
    .stat()
    .then((stats) => stats.isFile())
    .catch(() => false);
  if (directExists) {
    const configuredRoot = await findRepoRootFromConfig(path.dirname(directPath));
    if (configuredRoot) {
      return configuredRoot;
    }
    return (await getGitRoot(path.dirname(directPath))) ?? path.dirname(directPath);
  }

  if (fallbackDir) {
    return (await getGitRoot(fallbackDir)) ?? fallbackDir;
  }

  return (await getGitRoot()) || process.cwd();
}
