// Command handler for 'rmplan done'
// Marks the next step/task in a plan YAML as done

import { log } from '../../logging.js';
import { getGitRoot } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { markStepDone } from '../actions.js';
import { resolvePlanFile } from '../plans.js';
import { WorkspaceLock } from '../workspace/workspace_lock.js';

export async function handleDoneCommand(planFile: string, options: any, command: any) {
  const globalOpts = command.parent.opts();
  const gitRoot = (await getGitRoot()) || process.cwd();

  const config = await loadEffectiveConfig(globalOpts.config);
  const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
  const result = await markStepDone(
    resolvedPlanFile,
    {
      task: options.task,
      steps: options.steps ? parseInt(options.steps, 10) : 1,
      commit: options.commit,
    },
    undefined,
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
