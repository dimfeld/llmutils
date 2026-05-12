import type { Command } from 'commander';
import { log } from '../../../logging.js';
import { artifactFileExists } from '../../artifacts/storage.js';
import { getArtifact } from '../../artifacts/service.js';
import { printJson, resolveArtifactCommandContext, serializeArtifactForCli } from './common.js';

export interface ArtifactShowOptions {
  json?: boolean;
}

export async function handleArtifactShowCommand(
  artifactUuid: string,
  options: ArtifactShowOptions = {},
  command?: Command
): Promise<void> {
  await resolveArtifactCommandContext(command);
  const artifact = getArtifact(artifactUuid);
  const fileExists = await artifactFileExists(artifact.storagePath);

  if (options.json) {
    printJson(serializeArtifactForCli(artifact, { fileExists }));
    return;
  }

  log(`UUID: ${artifact.uuid}`);
  log(`Plan UUID: ${artifact.planUuid}`);
  log(`Filename: ${artifact.filename}`);
  log(`MIME: ${artifact.mimeType}`);
  log(`Size: ${artifact.size}`);
  log(`Message: ${artifact.message ?? '-'}`);
  log(`Created: ${artifact.createdAt}`);
  log(`Deleted: ${artifact.deletedAt ?? '-'}`);
  log(`Path: ${artifact.storagePath}`);
  log(`File exists: ${fileExists ? 'yes' : 'no'}`);
}
