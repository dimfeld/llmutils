export interface ArtifactFilenameLike {
  filename: string;
}

function artifactBasename(filename: string): string {
  return filename.slice(filename.lastIndexOf('/') + 1).toLowerCase();
}

export function artifactSortKey(artifact: ArtifactFilenameLike): [number, string] {
  return [
    artifactBasename(artifact.filename) === 'report.md' ? 0 : 1,
    artifact.filename.toLowerCase(),
  ];
}

export function compareArtifactsByFilename(
  left: ArtifactFilenameLike,
  right: ArtifactFilenameLike
): number {
  const [leftPriority, leftName] = artifactSortKey(left);
  const [rightPriority, rightName] = artifactSortKey(right);
  return leftPriority - rightPriority || leftName.localeCompare(rightName);
}
