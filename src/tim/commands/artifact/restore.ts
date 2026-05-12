import chalk from 'chalk';
import type { Command } from 'commander';
import { log } from '../../../logging.js';
import { restoreArtifact } from '../../artifacts/service.js';
import { resolveArtifactCommandContext } from './common.js';

export async function handleArtifactRestoreCommand(
  artifactUuid: string,
  _options: Record<string, never> = {},
  command?: Command
): Promise<void> {
  const context = await resolveArtifactCommandContext(command);
  const result = await restoreArtifact(artifactUuid, { config: context.config });
  log(
    result.changed
      ? chalk.green(`Restored artifact ${artifactUuid}.`)
      : `Artifact ${artifactUuid} is already active.`
  );
}
