import type { RequestHandler } from './$types';

import { getSessionManager } from '$lib/server/session_context.js';
import { notFound, success } from '$lib/server/session_routes.js';

export const POST: RequestHandler = ({ params }) => {
  const dismissed = getSessionManager().dismissSession(params.connectionId);
  return dismissed ? success() : notFound('Session not found');
};
