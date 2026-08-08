function getInboxQueryScopes(projectIds: ReadonlyArray<number>): string[] {
  return [
    'all',
    ...Array.from(new Set(projectIds))
      .sort((left, right) => left - right)
      .map(String),
  ];
}

export async function refreshInboxQueryScopes(
  projectIds: ReadonlyArray<number>,
  refreshQuery: (projectId: string) => Promise<void>
): Promise<void> {
  for (const projectId of getInboxQueryScopes(projectIds)) {
    await refreshQuery(projectId);
  }
}
