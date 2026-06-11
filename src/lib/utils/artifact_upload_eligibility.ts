export interface ArtifactUploadEligiblePlan {
  artifacts?: ReadonlyArray<{ deletedAt: string | null }> | null;
}

export function hasUploadableArtifacts(
  plan: ArtifactUploadEligiblePlan | null | undefined
): boolean {
  if (!plan) return false;
  return (plan.artifacts ?? []).some((artifact) => artifact.deletedAt === null);
}
