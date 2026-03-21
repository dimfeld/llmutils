interface ParsedSessionGroupKey {
  remote: string;
  workspacePath: string;
}

function parseSessionGroupKey(groupKey: string): ParsedSessionGroupKey {
  const separatorIndex = groupKey.indexOf('|');
  if (separatorIndex === -1) {
    return {
      remote: groupKey,
      workspacePath: '',
    };
  }

  return {
    remote: groupKey.slice(0, separatorIndex),
    workspacePath: groupKey.slice(separatorIndex + 1),
  };
}

export function getSessionGroupKey(projectId: number | null, groupKey: string): string {
  const { remote, workspacePath } = parseSessionGroupKey(groupKey);
  if (remote) {
    return remote;
  }

  if (projectId == null) {
    return groupKey;
  }

  const workingDirectory = workspacePath || '';
  return `${projectId}|${workingDirectory}`;
}

function getWorkspacePathFromSessionGroupKey(groupKey: string): string {
  return parseSessionGroupKey(groupKey).workspacePath;
}

function formatSessionWorkspaceLabel(groupKey: string): string {
  const workspacePath = getWorkspacePathFromSessionGroupKey(groupKey);
  if (!workspacePath) return 'Unknown';
  const segments = workspacePath.replace(/\/+$/, '').split('/');
  return segments.slice(-2).join('/');
}

function getRepositoryLabelFromSessionGroupKey(groupKey: string): string {
  const repositoryPart = parseSessionGroupKey(groupKey).remote;
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
  const repositoryLabel = getRepositoryLabelFromSessionGroupKey(groupKey);
  const workspaceLabel = formatSessionWorkspaceLabel(groupKey);

  if (projectName) {
    if (repositoryLabel || workspaceLabel === 'Unknown') {
      return projectName;
    }
    return `${projectName} (${workspaceLabel})`;
  }

  if (!repositoryLabel) {
    return workspaceLabel;
  }
  if (workspaceLabel === 'Unknown' || workspaceLabel === repositoryLabel) {
    return repositoryLabel;
  }
  return repositoryLabel;
}
