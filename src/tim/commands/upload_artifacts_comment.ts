import * as path from 'node:path';

import type { Image, Link, Root, RootContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { formatByteSize } from '../../common/formatting.js';

const GITHUB_COMMENT_BODY_LIMIT = 65_536;
const TRUNCATION_NOTICE =
  '> Some artifact comment content was omitted because the generated comment exceeded GitHub limits.';
const markdownParser = unified().use(remarkParse).use(remarkGfm);

export interface UploadedArtifactForComment {
  filename: string;
  mimeType: string;
  url: string;
  size: number;
  relativePath?: string;
}

export interface BuildArtifactCommentBodyInput {
  marker: string;
  planId: number | string;
  planTitle: string;
  reportMarkdown?: string;
  artifacts: UploadedArtifactForComment[];
  updatedAt: string;
}

interface RewriteResult {
  markdown: string;
  referencedArtifactIndexes: Set<number>;
}

export function buildPlanArtifactsCommentMarker(planUuid: string): string {
  return `<!-- tim:plan-artifacts:${planUuid} -->`;
}

export function isReportArtifactFilename(filename: string): boolean {
  return filename.toLowerCase() === 'report.md';
}

export function buildArtifactCommentBody(input: BuildArtifactCommentBodyInput): string {
  const artifacts = input.artifacts.filter((artifact) => !isReportMarkdownArtifact(artifact));
  const reportRewrite =
    input.reportMarkdown !== undefined
      ? rewriteReportMarkdownReferences(input.reportMarkdown, artifacts)
      : { markdown: undefined, referencedArtifactIndexes: new Set<number>() };

  const body = assembleArtifactCommentBody({
    ...input,
    reportMarkdown: reportRewrite.markdown,
    artifacts,
    referencedArtifactIndexes: reportRewrite.referencedArtifactIndexes,
    linksOnly: false,
    includeTruncationNotice: false,
  });

  if (body.length <= GITHUB_COMMENT_BODY_LIMIT) {
    return body;
  }

  const truncated = buildTruncatedArtifactCommentBody({
    ...input,
    artifacts,
    referencedArtifactIndexes: reportRewrite.referencedArtifactIndexes,
  });

  return clampToCommentLimit(truncated);
}

/**
 * Final safety net guaranteeing the returned body never exceeds GitHub's comment limit, even when
 * caller-provided fields embedded in the header (e.g. an extreme `planTitle`) are themselves larger
 * than the limit. The marker is always at the front, so a front-truncation preserves it.
 */
function clampToCommentLimit(body: string): string {
  if (body.length <= GITHUB_COMMENT_BODY_LIMIT) {
    return body;
  }
  const suffix = '\n\n…';
  return body.slice(0, GITHUB_COMMENT_BODY_LIMIT - suffix.length) + suffix;
}

function buildTruncatedArtifactCommentBody(input: {
  marker: string;
  planId: number | string;
  planTitle: string;
  artifacts: UploadedArtifactForComment[];
  referencedArtifactIndexes: Set<number>;
  updatedAt: string;
}): string {
  const linksOnlyBody = assembleArtifactCommentBody({
    ...input,
    reportMarkdown: undefined,
    linksOnly: true,
    includeTruncationNotice: true,
  });

  if (linksOnlyBody.length <= GITHUB_COMMENT_BODY_LIMIT) {
    return linksOnlyBody;
  }

  const footer = buildUpdatedAtFooter(input.updatedAt);
  const header = [
    input.marker,
    '',
    buildPlanHeading(input.planId, input.planTitle),
    '',
    TRUNCATION_NOTICE,
    '',
    '## Artifacts',
    '',
  ].join('\n');

  const omissionNotice = '- Additional artifacts omitted.';
  const lines: string[] = [];
  let truncated = false;
  for (const artifact of input.artifacts) {
    const nextLine = renderDownloadLink(artifact);
    const candidate = `${header}${[...lines, nextLine].join('\n')}\n\n${footer}`;
    if (candidate.length > GITHUB_COMMENT_BODY_LIMIT) {
      truncated = true;
      break;
    }
    lines.push(nextLine);
  }

  if (truncated) {
    // Ensure the omission notice itself still fits, dropping already-included
    // links until it does so the final body never exceeds the limit.
    while (lines.length > 0) {
      const candidate = `${header}${[...lines, omissionNotice].join('\n')}\n\n${footer}`;
      if (candidate.length <= GITHUB_COMMENT_BODY_LIMIT) {
        break;
      }
      lines.pop();
    }
    lines.push(omissionNotice);
  }

  return `${header}${lines.join('\n')}\n\n${footer}`;
}

function assembleArtifactCommentBody(input: {
  marker: string;
  planId: number | string;
  planTitle: string;
  reportMarkdown?: string;
  artifacts: UploadedArtifactForComment[];
  referencedArtifactIndexes: Set<number>;
  updatedAt: string;
  linksOnly: boolean;
  includeTruncationNotice: boolean;
}): string {
  const sections: string[] = [input.marker];

  if (input.includeTruncationNotice) {
    sections.push(TRUNCATION_NOTICE);
  }

  if (input.reportMarkdown !== undefined && !input.linksOnly) {
    sections.push(input.reportMarkdown.trim());
  } else {
    sections.push(buildPlanHeading(input.planId, input.planTitle));
  }

  const trailingArtifacts = input.linksOnly
    ? input.artifacts
    : input.artifacts.filter((_, index) => !input.referencedArtifactIndexes.has(index));

  if (trailingArtifacts.length > 0) {
    sections.push(
      ['## Artifacts', '', renderArtifactList(trailingArtifacts, input.linksOnly)].join('\n')
    );
  }

  sections.push(buildUpdatedAtFooter(input.updatedAt));

  return `${sections.filter((section) => section.trim().length > 0).join('\n\n')}\n`;
}

function buildPlanHeading(planId: number | string, planTitle: string): string {
  return `# Artifacts for plan ${planId}: ${planTitle}`;
}

function buildUpdatedAtFooter(updatedAt: string): string {
  return `---\n<sub>Updated at ${updatedAt}</sub>`;
}

function renderArtifactList(artifacts: UploadedArtifactForComment[], linksOnly: boolean): string {
  return artifacts
    .map((artifact) => (linksOnly ? renderDownloadLink(artifact) : renderArtifact(artifact)))
    .join('\n\n');
}

function renderArtifact(artifact: UploadedArtifactForComment): string {
  if (artifact.mimeType.startsWith('image/')) {
    return `![${escapeMarkdownText(artifact.filename)}](${escapeMarkdownUrl(artifact.url)})`;
  }

  if (artifact.mimeType.startsWith('video/') && isEmbeddableVideo(artifact)) {
    return `<video src="${escapeHtmlAttribute(artifact.url)}" controls></video>\n\n${renderDownloadLink(artifact)}`;
  }

  return renderDownloadLink(artifact);
}

function renderDownloadLink(artifact: UploadedArtifactForComment): string {
  return `- [${escapeMarkdownText(artifact.filename)}](${escapeMarkdownUrl(artifact.url)}) (${formatByteSize(artifact.size)})`;
}

/**
 * Make a URL safe to drop into a Markdown link/image destination. The media host encodes path
 * segments with encodeURIComponent, which leaves `(`/`)` (and spaces) intact — those characters
 * terminate or break a Markdown `(...)` destination, so percent-encode them here.
 */
function escapeMarkdownUrl(url: string): string {
  return url.replaceAll('(', '%28').replaceAll(')', '%29').replaceAll(' ', '%20');
}

function isEmbeddableVideo(artifact: UploadedArtifactForComment): boolean {
  return artifact.mimeType === 'video/mp4' || artifact.mimeType === 'video/webm';
}

function rewriteReportMarkdownReferences(
  markdown: string,
  artifacts: UploadedArtifactForComment[]
): RewriteResult {
  const referencedArtifactIndexes = new Set<number>();
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const tree = markdownParser.parse(markdown) as Root;

  visitMarkdownReferenceNodes(tree, (node) => {
    const target = node.url;
    if (isAbsoluteMarkdownTarget(target)) {
      return;
    }

    const artifactIndex = findReferencedArtifactIndex(target, artifacts);
    if (artifactIndex === null) {
      return;
    }

    const destinationSpan = findMarkdownDestinationSpan(markdown, node);
    if (!destinationSpan) {
      return;
    }

    referencedArtifactIndexes.add(artifactIndex);
    replacements.push({
      ...destinationSpan,
      value: escapeMarkdownUrl(artifacts[artifactIndex]!.url),
    });
  });

  let rewritten = markdown;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    rewritten =
      rewritten.slice(0, replacement.start) + replacement.value + rewritten.slice(replacement.end);
  }

  return { markdown: rewritten, referencedArtifactIndexes };
}

function visitMarkdownReferenceNodes(
  node: Root | RootContent,
  visitor: (node: Image | Link) => void
): void {
  if (node.type === 'image' || node.type === 'link') {
    visitor(node);
  }

  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      visitMarkdownReferenceNodes(child as RootContent, visitor);
    }
  }
}

function findMarkdownDestinationSpan(
  markdown: string,
  node: Image | Link
): { start: number; end: number } | null {
  const startOffset = node.position?.start.offset;
  const endOffset = node.position?.end.offset;
  if (startOffset === undefined || endOffset === undefined) {
    return null;
  }

  const source = markdown.slice(startOffset, endOffset);
  const labelEnd = source.indexOf('](');
  if (labelEnd < 0) {
    return null;
  }

  const destinationStart = labelEnd + 2;
  const destinationSource = source.slice(destinationStart, -1);
  if (destinationSource.length === 0) {
    return null;
  }

  if (destinationSource.startsWith('<')) {
    const closeAngle = destinationSource.indexOf('>');
    if (closeAngle < 0) {
      return null;
    }
    return {
      start: startOffset + destinationStart + 1,
      end: startOffset + destinationStart + closeAngle,
    };
  }

  const destinationEnd = findUnbracketedMarkdownDestinationEnd(destinationSource, node.title);
  return {
    start: startOffset + destinationStart,
    end: startOffset + destinationStart + destinationEnd,
  };
}

function findUnbracketedMarkdownDestinationEnd(
  destinationSource: string,
  title: string | null | undefined
): number {
  if (title == null) {
    return destinationSource.length;
  }

  let depth = 0;
  for (let index = 0; index < destinationSource.length; index += 1) {
    const char = destinationSource[index]!;
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')' && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0 && /\s/.test(char)) {
      return index;
    }
  }

  return destinationSource.length;
}

function findReferencedArtifactIndex(
  target: string,
  artifacts: UploadedArtifactForComment[]
): number | null {
  const normalizedTarget = normalizeReferencePath(target);
  if (!normalizedTarget) {
    return null;
  }

  const relativePathIndex = artifacts.findIndex(
    (artifact) =>
      artifact.relativePath !== undefined &&
      normalizeReferencePath(artifact.relativePath) === normalizedTarget
  );
  if (relativePathIndex >= 0) {
    return relativePathIndex;
  }

  const targetBasename = normalizeReferencePath(path.posix.basename(normalizedTarget));
  const filenameIndex = artifacts.findIndex(
    (artifact) => normalizeReferencePath(artifact.filename) === targetBasename
  );

  return filenameIndex >= 0 ? filenameIndex : null;
}

function normalizeReferencePath(referencePath: string): string | null {
  const withoutFragment = referencePath.split('#', 1)[0] ?? '';
  const withoutQuery = withoutFragment.split('?', 1)[0] ?? '';
  const decoded = decodeUriComponentSafely(withoutQuery).replaceAll('\\', '/');
  const normalized = path.posix.normalize(decoded);
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    return null;
  }
  return normalized.replace(/^\.\//, '');
}

function decodeUriComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isAbsoluteMarkdownTarget(target: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(target) ||
    target.startsWith('//') ||
    target.startsWith('/') ||
    target.startsWith('#')
  );
}

function isReportMarkdownArtifact(artifact: UploadedArtifactForComment): boolean {
  return isReportArtifactFilename(artifact.filename);
}

function escapeMarkdownText(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll(']', '\\]');
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
