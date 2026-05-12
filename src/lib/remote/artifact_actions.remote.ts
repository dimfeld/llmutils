import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import { getArtifactByUuid } from '$tim/db/artifact.js';
import { removeArtifactFile } from '$tim/artifacts/storage.js';
import {
  writePlanArtifactHardDelete,
  writePlanArtifactRestore,
  writePlanArtifactSoftDelete,
} from '$tim/sync/write_router.js';

const artifactUuidSchema = z.object({
  uuid: z.string().uuid(),
});

export const softDeleteArtifact = command(artifactUuidSchema, async ({ uuid }) => {
  const { db, config } = await getServerContext();
  const artifact = getArtifactByUuid(db, uuid);
  if (!artifact) {
    error(404, 'Artifact not found');
  }

  await writePlanArtifactSoftDelete(db, config, artifact.projectUuid, {
    planUuid: artifact.planUuid,
    artifactUuid: artifact.uuid,
  });

  const updated = getArtifactByUuid(db, uuid);
  if (!updated) {
    error(404, 'Artifact not found');
  }
  return updated;
});

export const restoreArtifact = command(artifactUuidSchema, async ({ uuid }) => {
  const { db, config } = await getServerContext();
  const artifact = getArtifactByUuid(db, uuid);
  if (!artifact) {
    error(404, 'Artifact not found');
  }

  await writePlanArtifactRestore(db, config, artifact.projectUuid, {
    planUuid: artifact.planUuid,
    artifactUuid: artifact.uuid,
  });

  const updated = getArtifactByUuid(db, uuid);
  if (!updated) {
    error(404, 'Artifact not found');
  }
  return updated;
});

export const hardDeleteArtifact = command(artifactUuidSchema, async ({ uuid }) => {
  const { db, config } = await getServerContext();
  const artifact = getArtifactByUuid(db, uuid);
  if (!artifact) {
    error(404, 'Artifact not found');
  }

  await writePlanArtifactHardDelete(db, config, artifact.projectUuid, {
    planUuid: artifact.planUuid,
    artifactUuid: artifact.uuid,
  });

  const changed = !getArtifactByUuid(db, uuid);
  if (changed) {
    await removeArtifactFile(artifact.storagePath);
  }
  return { changed };
});
