import chalk from 'chalk';
import type { Command } from 'commander';
import { log } from '../../../logging.js';
import {
  ArtifactNotFoundError,
  hardDeleteArtifact,
  softDeleteArtifact,
} from '../../artifacts/service.js';
import { resolveArtifactCommandContext } from './common.js';

export interface ArtifactDeleteOptions {
  hard?: boolean;
}

export async function handleArtifactDeleteCommand(
  artifactUuid: string,
  options: ArtifactDeleteOptions = {},
  command?: Command
): Promise<void> {
  const context = await resolveArtifactCommandContext(command);

  if (options.hard) {
    const result = await hardDeleteArtifact(artifactUuid, { config: context.config });
    log(
      result.changed
        ? chalk.green(`Hard-deleted artifact ${artifactUuid}.`)
        : `Artifact ${artifactUuid} is already deleted.`
    );
    return;
  }

  try {
    const result = await softDeleteArtifact(artifactUuid, { config: context.config });
    log(
      result.changed
        ? chalk.green(`Deleted artifact ${artifactUuid}.`)
        : `Artifact ${artifactUuid} is already deleted.`
    );
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) {
      log(`Artifact ${artifactUuid} is already deleted.`);
      return;
    }
    throw error;
  }
}
