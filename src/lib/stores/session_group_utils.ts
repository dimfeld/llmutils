export function getSessionGroupKey(projectId: number | null, groupKey: string): string {
  if (projectId == null) {
    return groupKey;
  }
  const parts = groupKey.split('|');
  const workingDirectory = parts[1] || parts[0] || '';
  return `${projectId}|${workingDirectory}`;
}

function getWorkspacePathFromSessionGroupKey(groupKey: string): string {
  const parts = groupKey.split('|');
  return parts[1] || '';
}

function formatSessionWorkspaceLabel(groupKey: string): string {
  const workspacePath = getWorkspacePathFromSessionGroupKey(groupKey);
  if (!workspacePath) return 'Unknown';
  const segments = workspacePath.replace(/\/+$/, '').split('/');
  return segments.slice(-2).join('/');
}

function getRepositoryLabelFromSessionGroupKey(groupKey: string): string {
  const parts = groupKey.split('|');
  const repositoryPart = parts[0] ?? '';
  if (!repositoryPart) {
    return '';
  }

  const withoutScheme = repositoryPart.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const pathPart = withoutScheme;
  const scpParts = pathPart.split(':');
  const normalizedPath =
    scpParts.length > 1
      ? scpParts.slice(1).join(':').replace(/\/+$/, '')
      : pathPart.replace(/\/+$/, '');

  const segments = normalizedPath.split('/').filter(Boolean);
  const last = segments.at(-1);
  if (!last) {
    return '';
  }
  return last.replace(/\.git$/, '');
}

export function getSessionGroupLabel(groupKey: string, projectName?: string): string {
  const workspaceLabel = formatSessionWorkspaceLabel(groupKey);
  if (projectName) {
    if (workspaceLabel === 'Unknown') {
      return projectName;
    }
    return `${projectName} (${workspaceLabel})`;
  }

  const repositoryLabel = getRepositoryLabelFromSessionGroupKey(groupKey);
  if (!repositoryLabel) {
    return workspaceLabel;
  }
  if (workspaceLabel === 'Unknown' || workspaceLabel === repositoryLabel) {
    return repositoryLabel;
  }
  return `${repositoryLabel} (${workspaceLabel})`;
}
