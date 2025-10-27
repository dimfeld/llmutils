import type { PlanSchemaWithFilename } from '../planSchema.js';
import { claimPlan, type ClaimPlanResult } from './claim_plan.js';
import { logClaimOutcome } from './claim_logging.js';
import {
  getRepositoryIdentity,
  type RepositoryIdentity,
  getUserIdentity,
} from './workspace_identifier.js';

export interface AutoClaimPlanInput {
  plan: PlanSchemaWithFilename;
  uuid: string;
}

export interface AutoClaimOptions {
  cwdForIdentity?: string;
  now?: Date;
  quiet?: boolean;
}

let autoClaimEnabled = false;

export interface AutoClaimResult {
  result: ClaimPlanResult;
  repository: RepositoryIdentity;
  user: string | null;
}

export function enableAutoClaim(): void {
  autoClaimEnabled = true;
}

export function disableAutoClaim(): void {
  autoClaimEnabled = false;
}

export function isAutoClaimEnabled(): boolean {
  return autoClaimEnabled && !isAutoClaimDisabled();
}

export function isAutoClaimDisabled(): boolean {
  const value = process.env.RMPLAN_SKIP_AUTO_CLAIM;
  if (!value) {
    return false;
  }

  switch (value.trim().toLowerCase()) {
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return true;
  }
}

export async function autoClaimPlan(
  input: AutoClaimPlanInput,
  options: AutoClaimOptions = {}
): Promise<AutoClaimResult | null> {
  if (!isAutoClaimEnabled()) {
    return null;
  }

  const repository = await getRepositoryIdentity({ cwd: options.cwdForIdentity });
  const user = getUserIdentity();

  const planId =
    typeof input.plan.id === 'number' && !Number.isNaN(input.plan.id) ? input.plan.id : undefined;
  const planLabel = planId !== undefined ? String(planId) : input.uuid;

  const result = await claimPlan(planId, {
    uuid: input.uuid,
    repositoryId: repository.repositoryId,
    repositoryRemoteUrl: repository.remoteUrl,
    workspacePath: repository.gitRoot,
    user,
    now: options.now,
  });

  logClaimOutcome(result, {
    planLabel,
    workspacePath: repository.gitRoot,
    user,
    quiet: options.quiet ?? false,
  });

  return {
    result,
    repository,
    user,
  };
}
