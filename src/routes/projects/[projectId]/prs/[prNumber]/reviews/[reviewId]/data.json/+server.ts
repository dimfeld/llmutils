import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { getServerContext } from '$lib/server/init.js';
import { getReviewDetailData } from '../review_data.server.js';

export const GET: RequestHandler = async ({ params }) => {
  const { db, config } = await getServerContext();
  return json(await getReviewDetailData(db, params, config), {
    headers: {
      'Cache-Control': 'private, no-cache',
    },
  });
};
