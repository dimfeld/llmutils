import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { error, redirect } from '@sveltejs/kit';

import { getServerContext } from '$lib/server/init.js';
import { getPlanDetailRouteData } from '$lib/server/plans_browser.js';
import type { PlanArtifactWithTransferState } from '$tim/artifacts/service.js';
import type { PageServerLoad } from './$types';

const TEXT_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown']);
const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.json',
  '.jsonl',
  '.jsx',
  '.log',
  '.mjs',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.svelte',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

type ArtifactViewKind =
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

interface ArtifactViewFile {
  uuid: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  viewKind: ArtifactViewKind;
  content: string | null;
  url: string;
}

function basename(filename: string): string {
  return path.basename(filename).toLowerCase();
}

function artifactSortKey(artifact: PlanArtifactWithTransferState): [number, string] {
  return [basename(artifact.filename) === 'report.md' ? 0 : 1, artifact.filename.toLowerCase()];
}

function compareArtifacts(
  left: PlanArtifactWithTransferState,
  right: PlanArtifactWithTransferState
): number {
  const [leftPriority, leftName] = artifactSortKey(left);
  const [rightPriority, rightName] = artifactSortKey(right);
  return leftPriority - rightPriority || leftName.localeCompare(rightName);
}

function classifyArtifact(artifact: PlanArtifactWithTransferState): ArtifactViewKind {
  if (artifact.transferState === 'file-missing') return 'missing';
  if (artifact.size > TEXT_PREVIEW_MAX_BYTES && isTextLikeArtifact(artifact)) return 'too_large';
  if (artifact.mimeType.startsWith('image/')) return 'image';
  if (artifact.mimeType.startsWith('video/')) return 'video';
  if (artifact.mimeType.startsWith('audio/')) return 'audio';
  if (artifact.mimeType === 'application/pdf') return 'pdf';

  const extension = path.extname(artifact.filename).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(extension) || artifact.mimeType === 'text/markdown') {
    return 'markdown';
  }
  if (HTML_EXTENSIONS.has(extension) || artifact.mimeType === 'text/html') {
    return 'html';
  }
  if (
    SOURCE_EXTENSIONS.has(extension) ||
    artifact.mimeType.startsWith('text/') ||
    artifact.mimeType === 'application/json'
  ) {
    return 'source';
  }
  return 'unsupported';
}

function isTextLikeArtifact(artifact: PlanArtifactWithTransferState): boolean {
  const extension = path.extname(artifact.filename).toLowerCase();
  return (
    MARKDOWN_EXTENSIONS.has(extension) ||
    HTML_EXTENSIONS.has(extension) ||
    SOURCE_EXTENSIONS.has(extension) ||
    artifact.mimeType.startsWith('text/') ||
    artifact.mimeType === 'application/json'
  );
}

async function toViewFile(artifact: PlanArtifactWithTransferState): Promise<ArtifactViewFile> {
  const viewKind = classifyArtifact(artifact);
  const shouldReadContent = viewKind === 'markdown' || viewKind === 'html' || viewKind === 'source';

  return {
    uuid: artifact.uuid,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    size: artifact.size,
    createdAt: artifact.createdAt,
    viewKind,
    content: shouldReadContent ? await fs.readFile(artifact.storagePath, 'utf8') : null,
    url: `/api/artifacts/${artifact.uuid}?view=1`,
  };
}

export const load: PageServerLoad = async ({ params }) => {
  const { db } = await getServerContext();
  const result = await getPlanDetailRouteData(db, params.planId, params.projectId, 'plans');

  if (!result) {
    error(404, 'Plan not found');
  }

  if (result.redirectTo) {
    redirect(302, `${result.redirectTo}/artifacts`);
  }

  const artifacts = [...(result.planDetail.artifacts ?? [])]
    .filter((artifact) => artifact.deletedAt === null)
    .sort(compareArtifacts);

  return {
    plan: {
      uuid: result.planDetail.uuid,
      planId: result.planDetail.planId,
      title: result.planDetail.title,
      projectId: result.planDetail.projectId,
    },
    artifacts: await Promise.all(artifacts.map(toViewFile)),
  };
};
