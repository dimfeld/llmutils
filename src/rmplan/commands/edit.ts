// Command handler for 'rmplan edit'
// Opens a plan file in your editor

import type { Command } from 'commander';
import { logSpawn } from '../../common/process.js';
import { resolvePlanFile } from '../plans.js';

export async function handleEditCommand(planArg: string, options: any, command: Command) {
  const globalOpts = command.parent!.opts();
  const resolvedPlanFile = await resolvePlanFile(planArg, globalOpts.config);
  const editor = options.editor || process.env.EDITOR || 'nano';

  const editorProcess = logSpawn([editor, resolvedPlanFile], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  await editorProcess.exited;
}
