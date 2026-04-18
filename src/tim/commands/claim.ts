import { claimPlan } from '../assignments/claim_plan.js';
import { logClaimOutcome } from '../assignments/claim_logging.js';
import { resolvePlanWithUuid } from '../assignments/uuid_lookup.js';
import { getRepositoryIdentity, getUserIdentity } from '../assignments/workspace_identifier.js';
import { getRootCommandOptions } from './command_context.js';

export interface ClaimCommandOptions {
  // Placeholder for future flags (e.g., --quiet)
}

export async function handleClaimCommand(
  planId: number,
  _options: ClaimCommandOptions,
  command: any
): Promise<void> {
  const globalOpts = getRootCommandOptions(command);
  const { plan, repoRoot, uuid } = await resolvePlanWithUuid(planId, {
    configPath: globalOpts.config,
  });

  const repository = await getRepositoryIdentity({ cwd: repoRoot });
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
