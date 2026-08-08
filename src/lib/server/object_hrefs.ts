export interface ObjectHref {
  href: string;
  external: boolean;
}

export function planHref(projectId: number | null, planUuid: string | null): string | null {
  if (projectId === null || !planUuid) {
    return null;
  }

  return `/projects/${projectId}/plans/${planUuid}`;
}

export function prHref(
  projectId: number | null,
  prNumber: number | null,
  prUrl: string | null
): ObjectHref | null {
  if (projectId !== null && prNumber !== null) {
    return { href: `/projects/${projectId}/prs/${prNumber}`, external: false };
  }

  if (prUrl) {
    return { href: prUrl, external: true };
  }

  return null;
}
