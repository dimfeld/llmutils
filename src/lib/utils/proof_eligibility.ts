export interface ProofEligiblePlan {
  status: string;
  tasks?: ReadonlyArray<{ done: boolean }>;
  taskCounts?: { done: number; total: number };
}

export interface ProofEligibleConfig {
  proofGeneration?: {
    instructions?: string;
  };
}

export function isProofConfigured(projectConfig: ProofEligibleConfig | null | undefined): boolean {
  const instructions = projectConfig?.proofGeneration?.instructions;
  return typeof instructions === 'string' && instructions.trim().length > 0;
}

export function isPlanProofReady(plan: ProofEligiblePlan | null | undefined): boolean {
  if (!plan) return false;
  if (plan.status === 'needs_review' || plan.status === 'reviewed' || plan.status === 'done')
    return true;
  if (plan.tasks?.some((task) => task.done)) return true;
  if (plan.taskCounts && plan.taskCounts.done > 0) return true;
  return false;
}

export function isPlanEligibleForProofWithConfigured(
  plan: ProofEligiblePlan | null | undefined,
  proofConfigured: boolean
): boolean {
  return proofConfigured && isPlanProofReady(plan);
}

export function isPlanEligibleForProof(
  plan: ProofEligiblePlan | null | undefined,
  projectConfig: ProofEligibleConfig | null | undefined
): boolean {
  return isPlanEligibleForProofWithConfigured(plan, isProofConfigured(projectConfig));
}
