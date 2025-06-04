// Command handler for 'rmplan edit'
// Opens a plan file in your editor

import { error } from '../../logging.js';
import { logSpawn } from '../../rmfilter/utils.js';
import { resolvePlanFile } from '../plans.js';

export async function handleEditCommand(planArg: string, options: any) {
  const globalOpts = options.parent.opts();
  try {
    const resolvedPlanFile = await resolvePlanFile(planArg, globalOpts.config);
    const editor = options.editor || process.env.EDITOR || 'nano';

    const editorProcess = logSpawn([editor, resolvedPlanFile], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    await editorProcess.exited;
  } catch (err) {
    error(`Failed to open plan file: ${err as Error}`);
    process.exit(1);
  }
}
