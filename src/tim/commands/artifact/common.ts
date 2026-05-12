import type { Command } from 'commander';
import { getGitRoot } from '../../../common/git.js';
import { loadEffectiveConfig } from '../../configLoader.js';
import type { TimConfig } from '../../configSchema.js';
import { resolveRepoRoot } from '../../plan_repo_root.js';

export interface ArtifactCommandContext {
  config: TimConfig;
  repoRoot: string;
}

export async function resolveArtifactCommandContext(
  command?: Command
): Promise<ArtifactCommandContext> {
  const globalOptions = command?.parent?.parent?.opts?.() ?? command?.parent?.opts?.() ?? {};
  const configPath = globalOptions.config as string | undefined;
  const config = await loadEffectiveConfig(configPath, { quiet: true });
  const repoRoot = await resolveRepoRoot(configPath, (await getGitRoot()) ?? process.cwd());
  return { config, repoRoot };
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
