import type { Command } from 'commander';
import { getGitRoot } from '../../../common/git.js';
import { loadEffectiveConfig } from '../../configLoader.js';
import type { TimConfig } from '../../configSchema.js';
import { resolveRepoRoot } from '../../plan_repo_root.js';
import type { ArtifactTransferState } from '../../artifacts/service.js';
import type { PlanArtifact } from '../../artifacts/types.js';

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

export interface CliArtifactJson {
  uuid: string;
  planUuid: string;
  projectUuid: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  message: string | null;
  storagePath: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revision: number;
  transferState: ArtifactTransferState | null;
  fileExists: boolean | null;
}

export interface SerializeArtifactForCliOptions {
  transferState?: ArtifactTransferState | null;
  fileExists?: boolean | null;
}

export function serializeArtifactForCli(
  artifact: PlanArtifact,
  options: SerializeArtifactForCliOptions = {}
): CliArtifactJson {
  return {
    ...artifact,
    transferState: options.transferState ?? null,
    fileExists: options.fileExists ?? null,
  };
}
