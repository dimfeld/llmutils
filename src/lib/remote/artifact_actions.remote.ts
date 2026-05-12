import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import {
  ArtifactNotFoundError,
  hardDeleteArtifact as hardDeleteArtifactService,
  restoreArtifact as restoreArtifactService,
  softDeleteArtifact as softDeleteArtifactService,
} from '$tim/artifacts/service.js';

const artifactUuidSchema = z.object({
  uuid: z.string().uuid(),
});

export const softDeleteArtifact = command(artifactUuidSchema, async ({ uuid }) => {
  const { db, config } = await getServerContext();
  try {
    return await softDeleteArtifactService(uuid, { db, config });
  } catch (caught) {
    if (caught instanceof ArtifactNotFoundError) {
      error(404, 'Artifact not found');
    }
    throw caught;
  }
});

export const restoreArtifact = command(artifactUuidSchema, async ({ uuid }) => {
  const { db, config } = await getServerContext();
  try {
    return await restoreArtifactService(uuid, { db, config });
  } catch (caught) {
    if (caught instanceof ArtifactNotFoundError) {
      error(404, 'Artifact not found');
    }
    throw caught;
  }
});

export const hardDeleteArtifact = command(artifactUuidSchema, async ({ uuid }) => {
  const { db, config } = await getServerContext();
  try {
    return await hardDeleteArtifactService(uuid, { db, config });
  } catch (caught) {
    if (caught instanceof ArtifactNotFoundError) {
      error(404, 'Artifact not found');
    }
    throw caught;
  }
});
