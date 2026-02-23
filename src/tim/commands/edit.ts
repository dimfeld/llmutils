// Command handler for 'tim edit'
// Opens a plan file in your editor

import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { logSpawn } from '../../common/process.js';
import { readPlanFile, resolvePlanFile, writePlanFile } from '../plans.js';

export async function handleEditCommand(planArg: string, options: any, command: Command) {
  const globalOpts = command.parent!.opts();
  const resolvedPlanFile = await resolvePlanFile(planArg, globalOpts.config);
  const editor = options.editor || process.env.EDITOR || 'nano';
  const beforeEditContent = await readFile(resolvedPlanFile, 'utf-8');

  const editorProcess = logSpawn([editor, resolvedPlanFile], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  await editorProcess.exited;

  const afterEditContent = await readFile(resolvedPlanFile, 'utf-8');
  if (afterEditContent !== beforeEditContent) {
    const editedPlan = await readPlanFile(resolvedPlanFile);
    editedPlan.updatedAt = new Date().toISOString();
    await writePlanFile(resolvedPlanFile, editedPlan);
  }
}
