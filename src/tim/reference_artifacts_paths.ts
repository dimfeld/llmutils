import * as path from 'node:path';

export const REFERENCE_ARTIFACTS_DIR = path.join('.tim', 'reference-artifacts');

export function getReferenceArtifactsDir(repoRoot: string, planId: number | string): string {
  return path.join(repoRoot, REFERENCE_ARTIFACTS_DIR, toReferenceArtifactPlanIdSegment(planId));
}

export function toReferenceArtifactPlanIdSegment(planId: number | string): string {
  if (typeof planId === 'number') {
    if (!Number.isInteger(planId) || !Number.isFinite(planId)) {
      throw new Error(`Invalid reference artifact plan id: ${planId}`);
    }
    return String(planId);
  }

  if (!isSafePathSegment(planId)) {
    throw new Error(`Invalid reference artifact plan id segment: ${planId}`);
  }
  return planId;
}

function isSafePathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\')
  );
}
