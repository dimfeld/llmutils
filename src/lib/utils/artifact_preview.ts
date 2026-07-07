export const TEXT_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

export type ArtifactViewKind =
  | 'markdown'
  | 'html'
  | 'source'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'unsupported'
  | 'missing'
  | 'too_large';

export interface ArtifactPreviewInput {
  filename: string;
  mimeType: string;
  size: number;
  transferState?: string | null;
}

export const inlineArtifactMimeTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

export const viewInlineArtifactMimeTypes = new Set([
  ...inlineArtifactMimeTypes,
  'application/json',
  'text/markdown',
  'text/plain',
]);

export const markdownArtifactExtensions = new Set(['.md', '.markdown', '.mdown']);
export const htmlArtifactExtensions = new Set(['.html', '.htm']);
export const sourceArtifactExtensions = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.csv',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsonl',
  '.jsx',
  '.log',
  '.md',
  '.mjs',
  '.mts',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.svelte',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

export function artifactFileExtension(filename: string): string {
  const lastSlash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const basename = filename.slice(lastSlash + 1);
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(dot).toLowerCase() : '';
}

export function isArtifactTextLike(filename: string, mimeType: string): boolean {
  const extension = artifactFileExtension(filename);
  return (
    markdownArtifactExtensions.has(extension) ||
    htmlArtifactExtensions.has(extension) ||
    sourceArtifactExtensions.has(extension) ||
    mimeType.startsWith('text/') ||
    mimeType === 'application/json'
  );
}

export function canPreviewArtifactAsText(filename: string, mimeType: string): boolean {
  return isArtifactTextLike(filename, mimeType);
}

export function classifyArtifactPreview(artifact: ArtifactPreviewInput): ArtifactViewKind {
  if (artifact.transferState === 'file-missing') return 'missing';
  if (
    artifact.size > TEXT_PREVIEW_MAX_BYTES &&
    isArtifactTextLike(artifact.filename, artifact.mimeType)
  ) {
    return 'too_large';
  }
  if (artifact.mimeType.startsWith('image/')) return 'image';
  if (artifact.mimeType.startsWith('video/')) return 'video';
  if (artifact.mimeType.startsWith('audio/')) return 'audio';
  if (artifact.mimeType === 'application/pdf') return 'pdf';

  const extension = artifactFileExtension(artifact.filename);
  if (markdownArtifactExtensions.has(extension) || artifact.mimeType === 'text/markdown') {
    return 'markdown';
  }
  if (htmlArtifactExtensions.has(extension) || artifact.mimeType === 'text/html') {
    return 'html';
  }
  if (
    sourceArtifactExtensions.has(extension) ||
    artifact.mimeType.startsWith('text/') ||
    artifact.mimeType === 'application/json'
  ) {
    return 'source';
  }
  return 'unsupported';
}
