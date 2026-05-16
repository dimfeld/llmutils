import { getServerContext } from '$lib/server/init.js';
import type { PageServerLoad } from './$types';
import { getReviewDetailData } from './review_data.server.js';

export const load: PageServerLoad = async ({ params }) => {
  const { db } = await getServerContext();
  return getReviewDetailData(db, params);
};
