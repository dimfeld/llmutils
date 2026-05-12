import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { getServerContext } from '$lib/server/init.js';
import { addArtifactByPlanUuid } from '$tim/artifacts/service.js';
import { MAX_ARTIFACT_BYTES } from '$tim/artifacts/constants.js';
import { ArtifactTooLargeError } from '$tim/artifacts/errors.js';
import { getPlanByUuid } from '$tim/db/plan.js';
import { PlanNotFoundError } from '$tim/plans.js';

const MULTIPART_OVERHEAD_ALLOWANCE_BYTES = 64 * 1024;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeUploadFilename(filename: string): string {
  const basename = path.basename(filename.trim() || 'artifact');
  return basename.length > 0 && basename !== '.' && basename !== '..' ? basename : 'artifact';
}

export const POST: RequestHandler = async ({ request }) => {
  const contentLength = request.headers.get('content-length');
  const parsedContentLength = contentLength === null ? NaN : Number(contentLength);
  if (!Number.isFinite(parsedContentLength)) {
    return json({ error: 'length_required' }, { status: 411 });
  }
  if (parsedContentLength > MAX_ARTIFACT_BYTES + MULTIPART_OVERHEAD_ALLOWANCE_BYTES) {
    return json(
      {
        error: 'artifact_too_large',
        maxBytes: MAX_ARTIFACT_BYTES,
      },
      { status: 413 }
    );
  }

  const form = await request.formData();
  const planUuidValue = form.get('planUuid');
  const projectIdValue = form.get('projectId');
  const fileValue = form.get('file');
  const messageValue = form.get('message');

  if (typeof planUuidValue !== 'string') {
    error(400, 'Missing planUuid');
  }
  const planUuid = planUuidValue.trim();
  if (!UUID_REGEX.test(planUuid)) {
    error(400, 'Invalid planUuid');
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
    const { db, config } = await getServerContext();
    const plan = getPlanByUuid(db, planUuid);
    if (!plan) {
      error(404, `Plan not found: ${planUuid}`);
    }
    if (typeof projectIdValue === 'string' && projectIdValue.length > 0) {
      const projectId = Number(projectIdValue);
      if (!Number.isInteger(projectId) || projectId <= 0) {
        error(400, 'Invalid projectId');
      }
      if (plan.project_id !== projectId) {
        error(404, `Plan not found in project: ${planUuid}`);
      }
    }

    // SvelteKit's formData() buffers the multipart body; the artifact cap keeps that bounded.
    // Write the File stream directly to disk to avoid an extra arrayBuffer()/Buffer copy.
    await fsp.writeFile(
      tempPath,
      Readable.fromWeb(fileValue.stream() as unknown as NodeReadableStream<Uint8Array>)
    );

    const artifact = await addArtifactByPlanUuid({
      db,
      config,
      planUuid,
      sourcePath: tempPath,
      originalFilename: fileValue.name,
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
    if (caught instanceof ArtifactTooLargeError) {
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
