import type { RequestHandler } from './$types';

import { getSessionManager } from '$lib/server/session_context.js';
import { createSessionEventsResponse } from '$lib/server/session_routes.js';

export const GET: RequestHandler = ({ request }) =>
  createSessionEventsResponse(getSessionManager(), request.signal);
