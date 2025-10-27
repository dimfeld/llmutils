import chalk from 'chalk';

import { log, warn } from '../../logging.js';
import { releasePlan } from '../assignments/release_plan.js';
import { resolvePlanWithUuid } from '../assignments/uuid_lookup.js';
import { getRepositoryIdentity, getUserIdentity } from '../assignments/workspace_identifier.js';
import { writePlanFile } from '../plans.js';

export interface ReleaseCommandOptions {
  resetStatus?: boolean;
}

export async function handleReleaseCommand(
  planArg: string,
  options: ReleaseCommandOptions,
  command: any
): Promise<void> {
  if (!planArg) {
    throw new Error('Plan identifier is required');
  }

  const globalOpts = command?.parent?.opts?.() ?? {};
  const { plan, uuid } = await resolvePlanWithUuid(planArg, {
    configPath: globalOpts.config,
  });

  const repository = await getRepositoryIdentity();
  const user = getUserIdentity();

  const planId = typeof plan.id === 'number' && !Number.isNaN(plan.id) ? plan.id : undefined;
  const planLabel = planId !== undefined ? String(planId) : uuid;

  const result = await releasePlan(planId, {
    uuid,
    repositoryId: repository.repositoryId,
    repositoryRemoteUrl: repository.remoteUrl,
    workspacePath: repository.gitRoot,
    user,
  });

  for (const message of result.warnings) {
    warn(`${chalk.yellow('⚠')} ${message}`);
  }

  if (!result.existed) {
    log(`${chalk.yellow('•')} Plan ${planLabel} has no assignments to release`);
  } else if (!result.persisted) {
    log(`${chalk.yellow('•')} Plan ${planLabel} is not claimed in workspace ${repository.gitRoot}`);
    if (user && result.removedUser) {
      log(`  Removed user ${user} from assignment`);
    }
  } else if (result.entryRemoved) {
    const actionDetails: string[] = [];
    if (result.removedWorkspace) {
      actionDetails.push('removed workspace');
    }
    if (result.removedUser && user) {
      actionDetails.push(`removed user ${user}`);
    }
    const suffix = actionDetails.length > 0 ? ` (${actionDetails.join(', ')})` : '';
    log(
      `${chalk.green('✓')} Released plan ${planLabel} from workspace ${repository.gitRoot}${suffix}`
    );
  } else {
    const actionDetails: string[] = [];
    if (result.removedWorkspace) {
      actionDetails.push('removed workspace');
    }
    if (result.removedUser && user) {
      actionDetails.push(`removed user ${user}`);
    }
    const suffix = actionDetails.length > 0 ? ` (${actionDetails.join(', ')})` : '';
    log(
      `${chalk.green('✓')} Updated assignment for plan ${planLabel} in workspace ${repository.gitRoot}${suffix}`
    );
  }

  if (options.resetStatus) {
    const originalStatus = plan.status;
    if (originalStatus !== 'pending') {
      plan.status = 'pending';
      await writePlanFile(plan.filename, plan);
      log(`${chalk.green('✓')} Reset status for plan ${planLabel} to pending`);
    } else {
      log(`${chalk.yellow('•')} Plan ${planLabel} is already pending`);
    }
  }
}
