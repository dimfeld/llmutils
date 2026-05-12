import chalk from 'chalk';
import type { Command } from 'commander';
import { log } from '../../../logging.js';
import { parsePlanIdFromCliArg } from '../../plans.js';
import { addArtifact } from '../../artifacts/service.js';
import { printJson, resolveArtifactCommandContext } from './common.js';

export interface ArtifactAddOptions {
  message?: string;
  json?: boolean;
}

export async function handleArtifactAddCommand(
  planIdArg: string,
  file: string,
  options: ArtifactAddOptions = {},
  command?: Command
): Promise<void> {
  const planId = parsePlanIdFromCliArg(planIdArg);
  const context = await resolveArtifactCommandContext(command);
  const artifact = await addArtifact({
    planId,
    sourcePath: file,
    message: options.message,
    config: context.config,
    repoRoot: context.repoRoot,
  });

  if (options.json) {
    printJson({
      uuid: artifact.uuid,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      size: artifact.size,
      planUuid: artifact.planUuid,
    });
    return;
  }

  log(
    `${chalk.green('Attached artifact:')} ${artifact.uuid} (${artifact.size} bytes, ${artifact.mimeType})`
  );
}
