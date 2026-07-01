export const REFERENCE_ARTIFACT_PREFIX = 'tim-reference:';

export function buildReferenceArtifactMessage(description?: string): string {
  return REFERENCE_ARTIFACT_PREFIX + (description ?? '');
}

export function isReferenceArtifact(message: string | null | undefined): boolean {
  return message?.startsWith(REFERENCE_ARTIFACT_PREFIX) === true;
}

export function parseReferenceArtifactDescription(
  message: string | null | undefined
): string | undefined {
  if (message?.startsWith(REFERENCE_ARTIFACT_PREFIX) !== true) {
    return undefined;
  }

  return message.slice(REFERENCE_ARTIFACT_PREFIX.length);
}
