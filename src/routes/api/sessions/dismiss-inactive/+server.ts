import type { RequestHandler } from './$types';

import { getSessionManager } from '$lib/server/session_context.js';
import { json } from '@sveltejs/kit';

export const POST: RequestHandler = () => {
  const dismissed = getSessionManager().dismissInactiveSessions();
  return json({ success: true, dismissed });
};
