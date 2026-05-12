import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { getServerContext } from '$lib/server/init.js';
import { addArtifact } from '$tim/artifacts/service.js';
import { MAX_ARTIFACT_BYTES } from '$tim/artifacts/constants.js';
import { PlanNotFoundError } from '$tim/plans.js';

function safeUploadFilename(filename: string): string {
  const basename = path.basename(filename.trim() || 'artifact');
  return basename.length > 0 && basename !== '.' && basename !== '..' ? basename : 'artifact';
}

export const POST: RequestHandler = async ({ request }) => {
  const form = await request.formData();
  const planIdValue = form.get('planId');
  const fileValue = form.get('file');
  const messageValue = form.get('message');

  if (typeof planIdValue !== 'string') {
    error(400, 'Missing planId');
  }
  const planId = Number(planIdValue);
  if (!Number.isInteger(planId) || planId <= 0) {
    error(400, 'Invalid planId');
  }
  if (!(fileValue instanceof File)) {
    error(400, 'Missing file');
  }
  if (fileValue.size > MAX_ARTIFACT_BYTES) {
    return json(
      {
        error: 'artifact_too_large',
        maxBytes: MAX_ARTIFACT_BYTES,
      },
      { status: 413 }
    );
  }
  const message =
    typeof messageValue === 'string' && messageValue.length > 0 ? messageValue : undefined;
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tim-artifact-'));
  const tempPath = path.join(tempDir, safeUploadFilename(fileValue.name));

  try {
    // The 25 MB cap makes formData() acceptable here; use direct streaming if this cap grows.
    await fsp.writeFile(tempPath, Buffer.from(await fileValue.arrayBuffer()));

    const { db, config } = await getServerContext();
    const artifact = await addArtifact({
      db,
      config,
      planId,
      sourcePath: tempPath,
      message,
    });

    return json({
      uuid: artifact.uuid,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      size: artifact.size,
    });
  } catch (caught) {
    if (caught instanceof PlanNotFoundError) {
      error(404, caught.message);
    }
    const messageText = caught instanceof Error ? caught.message : String(caught);
    if (messageText.includes('too large')) {
      return json(
        {
          error: 'artifact_too_large',
          maxBytes: MAX_ARTIFACT_BYTES,
        },
        { status: 413 }
      );
    }
    throw caught;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
};
