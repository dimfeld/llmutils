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
  if (!isRecord(body) || !isString(body.requestId) || !('value' in body)) {
    return badRequest('Expected JSON body with string requestId and a value field');
  }

  const result = getSessionManager().sendPromptResponse(
    params.connectionId,
    body.requestId,
    body.value
  );

  if (result === 'sent') {
    return success();
  } else if (result === 'no_prompt') {
    return badRequest('No active prompt with that requestId');
  } else {
    return notFound('Session not found');
  }
};
