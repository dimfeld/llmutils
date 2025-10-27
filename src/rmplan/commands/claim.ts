import chalk from 'chalk';

import { log, warn } from '../../logging.js';
import { claimPlan } from '../assignments/claim_plan.js';
import { resolvePlanWithUuid } from '../assignments/uuid_lookup.js';
import { getRepositoryIdentity, getUserIdentity } from '../assignments/workspace_identifier.js';

export interface ClaimCommandOptions {
  // Placeholder for future flags (e.g., --quiet)
}

export async function handleClaimCommand(
  planArg: string,
  _options: ClaimCommandOptions,
  command: any
): Promise<void> {
  if (!planArg) {
    throw new Error('Plan identifier is required');
  }

  const globalOpts = command?.parent?.opts?.() ?? {};
  const { plan, uuid } = await resolvePlanWithUuid(planArg, {
    configPath: globalOpts.config,
  });

  if (typeof plan.id !== 'number' || Number.isNaN(plan.id)) {
    throw new Error(`Plan ${planArg} does not have a numeric ID and cannot be claimed`);
  }

  const repository = await getRepositoryIdentity();
  const user = getUserIdentity();

  const result = await claimPlan(plan.id, {
    uuid,
    repositoryId: repository.repositoryId,
    repositoryRemoteUrl: repository.remoteUrl,
    workspacePath: repository.gitRoot,
    user,
  });

  for (const message of result.warnings) {
    warn(`${chalk.yellow('⚠')} ${message}`);
  }

  if (result.persisted) {
    const actionDetails: string[] = [];
    if (result.created) {
      actionDetails.push('created assignment');
    } else if (result.addedWorkspace) {
      actionDetails.push('added workspace');
    }
    if (result.addedUser && user) {
      actionDetails.push(`added user ${user}`);
    }
    const suffix = actionDetails.length > 0 ? ` (${actionDetails.join(', ')})` : '';
    log(`${chalk.green('✓')} Claimed plan ${plan.id} in workspace ${repository.gitRoot}${suffix}`);
  } else {
    log(
      `${chalk.yellow('•')} Plan ${plan.id} is already claimed in workspace ${repository.gitRoot}`
    );
    if (user) {
      log(`  User: ${user}`);
    }
  }
}
