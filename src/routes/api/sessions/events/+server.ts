import type { RequestHandler } from './$types';

import { getSessionManager } from '$lib/server/session_context.js';
import {
  createSessionEventsResponse,
  createSessionTranscriptResponse,
} from '$lib/server/session_routes.js';

export const GET: RequestHandler = ({ request }) => {
  const connectionId = new URL(request.url).searchParams.get('connectionId');
  return connectionId
    ? createSessionTranscriptResponse(getSessionManager(), connectionId, request.signal)
    : createSessionEventsResponse(getSessionManager(), request.signal);
};
