// Command handler for 'rmplan update'
// Updates an existing plan with new information from a linked GitHub issue or other sources

import * as os from 'os';
import * as path from 'path';
import { log, error } from '../../logging.js';
import { getGitRoot } from '../../common/git.js';
import { logSpawn } from '../../common/process.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanFile } from '../plans.js';

export async function handleUpdateCommand(planFile: string, options: any, command: any) {
  const globalOpts = command.parent.opts();
  const gitRoot = (await getGitRoot()) || process.cwd();

  const config = await loadEffectiveConfig(globalOpts.config);
  const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);

  log(`Update command called with plan file: ${resolvedPlanFile}`);

  // Get the update description either from command line or editor
  let updateDescription: string;

  if (options.description) {
    // Use the description provided via command line
    updateDescription = options.description;
  } else {
    // Open editor to get the update description
    const tmpDescPath = path.join(os.tmpdir(), `rmplan-update-desc-${Date.now()}.md`);

    try {
      // Create empty temp file
      await Bun.write(tmpDescPath, '');

      // Open editor with the temporary file
      const editor = process.env.EDITOR || 'nano';
      const editorProcess = logSpawn([editor, tmpDescPath], {
        stdio: ['inherit', 'inherit', 'inherit'],
      });
      await editorProcess.exited;

      // Read the description from the temporary file
      try {
        updateDescription = await Bun.file(tmpDescPath).text();
      } catch (err) {
        throw new Error('Failed to read update description from editor.');
      }

      if (!updateDescription || !updateDescription.trim()) {
        throw new Error('No update description was provided from the editor.');
      }
    } catch (err) {
      throw new Error(`Failed to get update description from editor: ${err as Error}`);
    } finally {
      // Clean up the temporary file
      try {
        await Bun.file(tmpDescPath).unlink();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }

  log(
    `Update description: ${updateDescription.substring(0, 100)}${updateDescription.length > 100 ? '...' : ''}`
  );

  // TODO: Implement update functionality
  // - Read existing plan from resolvedPlanFile
  // - Use LLM to update the plan based on updateDescription
  // - Write updated plan back to file
}
