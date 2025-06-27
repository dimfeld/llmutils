// Command handler for 'rmplan next'
// Prepares the next step(s) from a plan YAML for execution

import * as clipboard from '../../common/clipboard.ts';
import { log, warn } from '../../logging.js';
import { logSpawn } from '../../common/process.js';
import { getGitRoot } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { prepareNextStep } from '../plans/prepare_step.js';
import { resolvePlanFile } from '../plans.js';
import type { Command } from 'commander';

export async function handleNextCommand(planFile: string, options: any, command: Command) {
  const globalOpts = command.parent!.opts();
  // Find '--' in process.argv to get extra args for rmfilter
  const doubleDashIdx = process.argv.indexOf('--');
  const cmdLineRmfilterArgs = doubleDashIdx !== -1 ? process.argv.slice(doubleDashIdx + 1) : [];
  const config = await loadEffectiveConfig(globalOpts.config);
  const gitRoot = (await getGitRoot()) || process.cwd();

  const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
  const result = await prepareNextStep(
    config,
    resolvedPlanFile,
    {
      rmfilter: options.rmfilter,
      previous: options.previous,
      withImports: options.withImports,
      withAllImports: options.withAllImports,
      withImporters: options.withImporters,
      selectSteps: true,
      autofind: options.autofind,
      rmfilterArgs: cmdLineRmfilterArgs,
    },
    gitRoot
  );

  if (options.rmfilter && result.promptFilePath && result.rmfilterArgs) {
    try {
      const proc = logSpawn(['rmfilter', '--copy', ...result.rmfilterArgs], {
        cwd: gitRoot,
        stdio: ['inherit', 'inherit', 'inherit'],
      });
      const exitRes = await proc.exited;
      if (exitRes !== 0) {
        throw new Error(`rmfilter exited with code ${exitRes}`);
      }
    } finally {
      try {
        await Bun.file(result.promptFilePath).unlink();
      } catch (e) {
        warn('Warning: failed to clean up temp file:', result.promptFilePath);
      }
    }
  } else {
    log('\n----- LLM PROMPT -----\n');
    log(result.prompt);
    log('\n---------------------\n');
    await clipboard.write(result.prompt);
    log('Prompt copied to clipboard');
  }
}
