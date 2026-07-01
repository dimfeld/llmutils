export const PROOF_ARTIFACT_PREFIX = 'tim-proof:';

export function buildProofArtifactMessage(description?: string): string {
  return PROOF_ARTIFACT_PREFIX + (description ?? '');
}

export function isProofArtifact(message: string | null | undefined): boolean {
  return message?.startsWith(PROOF_ARTIFACT_PREFIX) === true;
}
