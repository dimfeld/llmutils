export interface MarkdownImageArtifact {
  filename: string;
  url: string;
  viewKind: string;
}

function normalizeMarkdownImagePath(imageUrl: string): string | null {
  if (
    imageUrl === '' ||
    imageUrl.startsWith('#') ||
    imageUrl.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(imageUrl)
  ) {
    return null;
  }

  const suffixIndex = imageUrl.search(/[?#]/);
  const pathOnly = suffixIndex === -1 ? imageUrl : imageUrl.slice(0, suffixIndex);
  if (pathOnly === '') return null;

  try {
    return decodeURIComponent(pathOnly)
      .replace(/^\.?\//, '')
      .toLowerCase();
  } catch {
    return pathOnly.replace(/^\.?\//, '').toLowerCase();
  }
}

function imageUrlFragment(imageUrl: string): string {
  const fragmentIndex = imageUrl.indexOf('#');
  return fragmentIndex === -1 ? '' : imageUrl.slice(fragmentIndex);
}

export function createArtifactImageUrlResolver(
  artifacts: readonly MarkdownImageArtifact[]
): (imageUrl: string) => string {
  const exact = new Map<string, string>();
  const basenameCounts = new Map<string, number>();
  const basenameUrls = new Map<string, string>();

  for (const artifact of artifacts) {
    if (artifact.viewKind !== 'image') continue;

    const normalized = artifact.filename.replace(/^\.?\//, '').toLowerCase();
    const base = normalized.slice(normalized.lastIndexOf('/') + 1);
    exact.set(normalized, artifact.url);
    basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
    basenameUrls.set(base, artifact.url);
  }

  return (imageUrl: string): string => {
    const normalized = normalizeMarkdownImagePath(imageUrl);
    if (normalized === null) return imageUrl;

    const exactMatch = exact.get(normalized);
    if (exactMatch) return `${exactMatch}${imageUrlFragment(imageUrl)}`;

    const base = normalized.slice(normalized.lastIndexOf('/') + 1);
    if (basenameCounts.get(base) === 1) {
      const basenameMatch = basenameUrls.get(base);
      if (basenameMatch) return `${basenameMatch}${imageUrlFragment(imageUrl)}`;
    }

    return imageUrl;
  };
}
