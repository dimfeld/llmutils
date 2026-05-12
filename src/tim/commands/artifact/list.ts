import type { Command } from 'commander';
import { log } from '../../../logging.js';
import { parsePlanIdFromCliArg } from '../../plans.js';
import { listArtifacts, type PlanArtifactWithTransferState } from '../../artifacts/service.js';
import { printJson, resolveArtifactCommandContext } from './common.js';

export interface ArtifactListOptions {
  includeDeleted?: boolean;
  json?: boolean;
}

function truncate(value: string | null, max: number): string {
  if (!value) {
    return '-';
  }
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function renderRow(artifact: PlanArtifactWithTransferState): string {
  const createdOrDeleted = artifact.deletedAt
    ? `DELETED ${artifact.deletedAt}`
    : artifact.createdAt;
  return [
    artifact.uuid,
    truncate(artifact.filename, 28),
    String(artifact.size),
    artifact.mimeType,
    truncate(artifact.message, 36),
    createdOrDeleted,
    artifact.transferState ?? '-',
  ].join('\t');
}

export async function handleArtifactListCommand(
  planIdArg: string,
  options: ArtifactListOptions = {},
  command?: Command
): Promise<void> {
  const planId = parsePlanIdFromCliArg(planIdArg);
  const context = await resolveArtifactCommandContext(command);
  const artifacts = await listArtifacts({
    planId,
    includeDeleted: options.includeDeleted,
    config: context.config,
    repoRoot: context.repoRoot,
  });

  if (options.json) {
    printJson(artifacts);
    return;
  }

  if (artifacts.length === 0) {
    log('No artifacts found.');
    return;
  }

  log(['UUID', 'FILENAME', 'SIZE', 'MIME', 'MESSAGE', 'CREATED/DELETED', 'TRANSFER'].join('\t'));
  for (const artifact of artifacts) {
    log(renderRow(artifact));
  }
}
