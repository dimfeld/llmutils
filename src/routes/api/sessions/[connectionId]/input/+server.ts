import type { RequestHandler } from './$types';

import { getSessionManager } from '$lib/server/session_context.js';
import {
  badRequest,
  isRecord,
  isString,
  notFound,
  parseJsonBody,
  success,
} from '$lib/server/session_routes.js';

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await parseJsonBody(request);
  if (!isRecord(body) || !isString(body.content)) {
    return badRequest('Expected JSON body with string content');
  }

  const sent = getSessionManager().sendUserInput(params.connectionId, body.content);
  return sent ? success() : notFound('Session not found');
};
