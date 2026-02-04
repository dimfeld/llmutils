// Command handler for 'tim done'
// Marks the next step/task in a plan YAML as done

import { getGitRoot } from '../../common/git.js';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanFile } from '../plans.js';
import { markStepDone } from '../plans/mark_done.js';
import { WorkspaceLock } from '../workspace/workspace_lock.js';

export async function handleDoneCommand(planFile: string, options: any, command: any) {
  const globalOpts = command.parent.opts();
  const gitRoot = (await getGitRoot()) || process.cwd();

  const config = await loadEffectiveConfig(globalOpts.config);
  const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
  const result = await markStepDone(
    resolvedPlanFile,
    {
      commit: options.commit,
    },
    undefined,
    gitRoot,
    config
  );

  // If plan is complete and we're in a workspace, release the lock
  if (result.planComplete) {
    try {
      const lockInfo = await WorkspaceLock.getLockInfo(gitRoot);

      if (lockInfo?.type === 'pid') {
        const released = await WorkspaceLock.releaseLock(gitRoot);
        if (released) {
          log('Released workspace lock');
        }
      } else if (lockInfo?.type === 'persistent') {
        log('Workspace remains locked. Use "tim workspace unlock" to release it.');
      }
    } catch (err) {
      // Ignore lock release errors - workspace might not be locked
    }
  }
}
