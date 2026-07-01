import * as fs from 'node:fs/promises';

import { error, redirect } from '@sveltejs/kit';

import { compareArtifactsByFilename } from '$common/artifact_sort.js';
import { getServerContext } from '$lib/server/init.js';
import { getPlanDetailRouteData } from '$lib/server/plans_browser.js';
import { classifyArtifactPreview, type ArtifactViewKind } from '$lib/utils/artifact_preview.js';
import { isProofArtifact } from '$tim/artifacts/proof.js';
import type { PlanArtifactWithTransferState } from '$tim/artifacts/service.js';
import type { PageServerLoad } from './$types';

interface ArtifactViewFile {
  uuid: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  viewKind: ArtifactViewKind;
  content: string | null;
  url: string;
  downloadUrl: string;
}

async function toViewFile(artifact: PlanArtifactWithTransferState): Promise<ArtifactViewFile> {
  const viewKind = classifyArtifactPreview(artifact);
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
    downloadUrl: `/api/artifacts/${artifact.uuid}`,
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
    .filter((artifact) => artifact.deletedAt === null && isProofArtifact(artifact.message))
    .sort(compareArtifactsByFilename);

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
