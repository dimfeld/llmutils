// Command handler for 'rmplan set-task-done'
// Marks a specific task in a plan YAML as done by title or index

import { getGitRoot } from '../../common/git.js';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanFile } from '../plans.js';
import { setTaskDone } from '../plans/mark_done.js';
import { WorkspaceLock } from '../workspace/workspace_lock.js';

export interface SetTaskDoneOptions {
  title?: string;
  index?: number;
  commit?: boolean;
}

export async function handleSetTaskDoneCommand(
  planFile: string,
  options: SetTaskDoneOptions,
  command: any
) {
  const globalOpts = command.parent.opts();
  const gitRoot = (await getGitRoot()) || process.cwd();

  // Validate that exactly one of title or index is provided
  if (!options.title && !options.index) {
    throw new Error('You must specify either --title or --index to identify the task');
  }
  if (options.title && options.index) {
    throw new Error('Please specify either --title or --index, not both');
  }

  const config = await loadEffectiveConfig(globalOpts.config);
  const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
  
  const result = await setTaskDone(
    resolvedPlanFile,
    {
      taskIdentifier: options.title || options.index!,
      commit: options.commit,
    },
    gitRoot,
    config
  );

  // If plan is complete and we're in a workspace, release the lock
  if (result.planComplete) {
    try {
      await WorkspaceLock.releaseLock(gitRoot);
      log('Released workspace lock');
    } catch (err) {
      // Ignore lock release errors - workspace might not be locked
    }
  }
}