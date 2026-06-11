import * as path from 'node:path';

import type { Image, Link, Root, RootContent } from 'mdast';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

import { formatByteSize } from '../../common/formatting.js';

const GITHUB_COMMENT_BODY_LIMIT = 65_536;
const TRUNCATION_NOTICE =
  '> Some artifact comment content was omitted because the generated comment exceeded GitHub limits.';
const markdownParser = unified().use(remarkParse).use(remarkGfm);
const markdownToHtmlProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeStringify);

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
  fullReportUrl?: string;
  updatedAt: string;
}

interface RewriteResult {
  markdown: string;
  referencedArtifactIndexes: Set<number>;
}

interface PreparedReportMarkdown {
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
  const preparedReport = prepareReportMarkdown({
    planId: input.planId,
    planTitle: input.planTitle,
    reportMarkdown: input.reportMarkdown,
    artifacts,
  });

  const body = assembleArtifactCommentBody({
    ...input,
    reportMarkdown: preparedReport.markdown,
    artifacts,
    referencedArtifactIndexes: preparedReport.referencedArtifactIndexes,
    linksOnly: false,
    includeTruncationNotice: false,
  });

  if (body.length <= GITHUB_COMMENT_BODY_LIMIT) {
    return body;
  }

  const truncated = buildTruncatedArtifactCommentBody({
    ...input,
    artifacts,
    referencedArtifactIndexes: preparedReport.referencedArtifactIndexes,
  });

  return clampToCommentLimit(truncated);
}

export function buildFullReportHtml(input: {
  planId: number | string;
  planTitle: string;
  reportMarkdown?: string;
  artifacts: UploadedArtifactForComment[];
  updatedAt: string;
}): string {
  const artifacts = input.artifacts.filter((artifact) => !isReportMarkdownArtifact(artifact));
  const preparedReport = prepareReportMarkdown({
    planId: input.planId,
    planTitle: input.planTitle,
    reportMarkdown: input.reportMarkdown,
    artifacts,
    includeTrailingArtifacts: false,
  });
  const trailingArtifacts = artifacts.filter(
    (_, index) => !preparedReport.referencedArtifactIndexes.has(index)
  );
  const renderedReport = wrapStandaloneImagesWithLinks(
    String(markdownToHtmlProcessor.processSync(preparedReport.markdown))
  );
  const renderedArtifacts = renderFullReportArtifactsHtml(trailingArtifacts);
  const title = `Artifacts for plan ${input.planId}: ${input.planTitle}`;

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtmlText(title)}</title>`,
    '<style>',
    ':root{color-scheme:light dark;--page-bg:#f6f8fa;--text:#24292f;--panel-bg:#fff;--border:#d0d7de;--muted:#57606a;--code-bg:#f6f8fa;--link:#0969da;}',
    'body{margin:0;background:var(--page-bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
    'a{color:var(--link);}',
    '.container{box-sizing:border-box;width:min(1600px,100%);margin:0 auto;padding:32px 20px 48px;}',
    '.report-shell{display:grid;gap:20px;}',
    '.report{background:var(--panel-bg);border:1px solid var(--border);border-radius:8px;padding:24px;overflow-wrap:anywhere;}',
    '.report img,.report video{max-width:100%;height:auto;}',
    '.report pre{overflow:auto;background:var(--code-bg);padding:16px;border-radius:6px;}',
    '.report code{background:var(--code-bg);border-radius:4px;padding:.125em .25em;}',
    '.report pre code{background:transparent;padding:0;}',
    '.report blockquote{border-left:4px solid var(--border);color:var(--muted);margin-left:0;padding-left:16px;}',
    '.report hr{border:0;border-top:1px solid var(--border);}',
    '.report table{border-collapse:collapse;display:block;overflow:auto;}',
    '.report th,.report td{border:1px solid var(--border);padding:6px 13px;}',
    '.artifact-panel{display:grid;align-content:start;gap:20px;}',
    '.artifact-grid{display:grid;gap:24px;}',
    '.artifact-name{font-weight:600;margin-bottom:8px;}',
    '.artifact-meta{color:var(--muted);font-weight:400;}',
    '.artifact-image a{display:inline-block;}',
    '@media (min-width: 900px){.container{height:100vh;padding-block:24px;}.report-shell{grid-template-columns:minmax(420px,1fr) minmax(420px,min(58%,720px));height:100%;}.report{overflow:auto;}.report-body{min-height:0;}.artifact-panel{min-height:0;}}',
    '.footer{margin-top:20px;color:var(--muted);font-size:12px;}',
    '@media (prefers-color-scheme: dark){:root{--page-bg:#0d1117;--text:#e6edf3;--panel-bg:#161b22;--border:#30363d;--muted:#8b949e;--code-bg:#0d1117;--link:#58a6ff;}.report img,.report video{background:#0d1117;border-color:var(--border);}}',
    '</style>',
    '</head>',
    '<body>',
    '<main class="container">',
    '<div class="report-shell">',
    `<article class="report report-body">${renderedReport}</article>`,
    renderedArtifacts,
    '</div>',
    `<div class="footer">Updated at ${escapeHtmlText(input.updatedAt)}</div>`,
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
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
  fullReportUrl?: string;
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
  const headerSections = [input.marker, ''];
  if (input.fullReportUrl) {
    headerSections.push(renderFullReportLink(input.fullReportUrl), '');
  }
  headerSections.push(
    buildPlanHeading(input.planId, input.planTitle),
    '',
    TRUNCATION_NOTICE,
    '',
    '## Artifacts',
    ''
  );
  const header = headerSections.join('\n');

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
  fullReportUrl?: string;
  updatedAt: string;
  linksOnly: boolean;
  includeTruncationNotice: boolean;
}): string {
  const sections: string[] = [input.marker];

  if (input.fullReportUrl) {
    sections.push(renderFullReportLink(input.fullReportUrl));
  }

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
      [
        '## Artifacts',
        '',
        input.linksOnly
          ? renderDownloadLinkList(trailingArtifacts)
          : renderArtifactList(trailingArtifacts),
      ].join('\n')
    );
  }

  if (input.fullReportUrl) {
    sections.push(renderFullReportLink(input.fullReportUrl));
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

function renderFullReportLink(url: string): string {
  return `[View full report](${escapeMarkdownUrl(url)})`;
}

function prepareReportMarkdown(input: {
  planId: number | string;
  planTitle: string;
  reportMarkdown?: string;
  artifacts: UploadedArtifactForComment[];
  includeTrailingArtifacts?: boolean;
}): PreparedReportMarkdown {
  const reportRewrite =
    input.reportMarkdown !== undefined
      ? rewriteReportMarkdownReferences(input.reportMarkdown, input.artifacts)
      : {
          markdown: buildPlanHeading(input.planId, input.planTitle),
          referencedArtifactIndexes: new Set<number>(),
        };
  const trailingArtifacts = input.artifacts.filter(
    (_, index) => !reportRewrite.referencedArtifactIndexes.has(index)
  );

  if (trailingArtifacts.length === 0 || input.includeTrailingArtifacts === false) {
    return reportRewrite;
  }

  return {
    markdown: [
      reportRewrite.markdown.trim(),
      '## Artifacts',
      renderArtifactList(trailingArtifacts),
    ].join('\n\n'),
    referencedArtifactIndexes: new Set(input.artifacts.map((_, index) => index)),
  };
}

function renderArtifactList(artifacts: UploadedArtifactForComment[]): string {
  return artifacts.map((artifact) => renderArtifact(artifact)).join('\n\n');
}

function renderDownloadLinkList(artifacts: UploadedArtifactForComment[]): string {
  return artifacts.map((artifact) => renderDownloadLink(artifact)).join('\n\n');
}

function renderArtifact(artifact: UploadedArtifactForComment): string {
  if (artifact.mimeType.startsWith('image/')) {
    return `**${escapeMarkdownText(artifact.filename)}**\n\n![${escapeMarkdownText(artifact.filename)}](${escapeMarkdownUrl(artifact.url)})`;
  }

  return renderDownloadLink(artifact);
}

function renderFullReportArtifactsHtml(artifacts: UploadedArtifactForComment[]): string {
  if (artifacts.length === 0) {
    return '';
  }

  return [
    '<aside class="report artifact-panel">',
    '<h2>Artifacts</h2>',
    '<div class="artifact-grid">',
    ...artifacts.map((artifact) => renderFullReportArtifactHtml(artifact)),
    '</div>',
    '</aside>',
  ].join('\n');
}

function renderFullReportArtifactHtml(artifact: UploadedArtifactForComment): string {
  const escapedFilename = escapeHtmlText(artifact.filename);
  const escapedUrl = escapeHtmlAttribute(artifact.url);
  const size = formatByteSize(artifact.size);

  if (artifact.mimeType.startsWith('image/')) {
    return [
      '<div class="artifact artifact-image">',
      `<div class="artifact-name">${escapedFilename} <span class="artifact-meta">(${size})</span></div>`,
      `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer"><img src="${escapedUrl}" alt="${escapedFilename}"></a>`,
      '</div>',
    ].join('\n');
  }

  return [
    '<div class="artifact">',
    `<div class="artifact-name"><a href="${escapedUrl}">${escapedFilename}</a> <span class="artifact-meta">(${size})</span></div>`,
    '</div>',
  ].join('\n');
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

function wrapStandaloneImagesWithLinks(html: string): string {
  return html.replace(/<img\b([^>]*\bsrc="([^"]+)"[^>]*)>/g, (match, attributes, src, offset) => {
    if (isInsideOpenAnchor(html, offset)) {
      return match;
    }
    return `<a href="${src}" target="_blank" rel="noopener noreferrer">${match}</a>`;
  });
}

function isInsideOpenAnchor(html: string, offset: number): boolean {
  const before = html.slice(0, offset);
  const lastOpenAnchor = before.lastIndexOf('<a ');
  if (lastOpenAnchor < 0) {
    return false;
  }

  const lastCloseAnchor = before.lastIndexOf('</a>');
  return lastOpenAnchor > lastCloseAnchor;
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

function escapeHtmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replaceAll('"', '&quot;');
}
