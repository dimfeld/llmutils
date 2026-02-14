import { claimPlan } from '../assignments/claim_plan.js';
import { logClaimOutcome } from '../assignments/claim_logging.js';
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

  const repository = await getRepositoryIdentity();
  const user = getUserIdentity();

  const planLabel = String(plan.id);

  const result = await claimPlan(plan.id, {
    uuid,
    repositoryId: repository.repositoryId,
    repositoryRemoteUrl: repository.remoteUrl,
    workspacePath: repository.gitRoot,
    user,
  });

  logClaimOutcome(result, {
    planLabel,
    workspacePath: repository.gitRoot,
    user,
  });
}
