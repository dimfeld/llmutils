import { getServerContext } from '$lib/server/init.js';
import { listLatestReviewGuideSummaries } from '$tim/db/review.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
  const { projectId } = await parent();
  const { db } = await getServerContext();

  return {
    reviews: listLatestReviewGuideSummaries(db, {
      projectId: projectId === 'all' ? 'all' : Number(projectId),
    }),
  };
};
