import chalk from 'chalk';
import type { Command } from 'commander';
import { log } from '../../../logging.js';
import { parsePlanIdFromCliArg } from '../../plans.js';
import { addArtifact } from '../../artifacts/service.js';
import { printJson, resolveArtifactCommandContext, serializeArtifactForCli } from './common.js';

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
    printJson(serializeArtifactForCli(artifact));
    return;
  }

  log(
    `${chalk.green('Attached artifact:')} ${artifact.uuid} (${artifact.size} bytes, ${artifact.mimeType})`
  );
}
