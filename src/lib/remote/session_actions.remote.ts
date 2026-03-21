import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getSessionManager } from '$lib/server/session_context.js';
import { focusTerminalPane } from '$lib/server/terminal_control.js';

const terminalPaneSchema = z.object({
  terminalPaneId: z.string(),
  terminalType: z.string(),
});

const sessionTargetSchema = z.object({
  connectionId: z.string(),
});

const promptResponseSchema = sessionTargetSchema.extend({
  requestId: z.string(),
  value: z.unknown(),
});

const userInputSchema = sessionTargetSchema.extend({
  content: z.string(),
});

export const activateSessionTerminalPane = command(terminalPaneSchema, async (target) => {
  await focusTerminalPane(target);
});

export const sendSessionPromptResponse = command(promptResponseSchema, async (target) => {
  const result = getSessionManager().sendPromptResponse(
    target.connectionId,
    target.requestId,
    target.value
  );

  if (result === 'sent') {
    return;
  }

  if (result === 'no_prompt') {
    error(400, 'No active prompt with that requestId');
  }

  error(404, 'Session not found');
});

export const sendSessionUserInput = command(userInputSchema, async (target) => {
  const sent = getSessionManager().sendUserInput(target.connectionId, target.content);
  if (!sent) {
    error(404, 'Session not found');
  }
});

export const dismissSession = command(sessionTargetSchema, async (target) => {
  const dismissed = getSessionManager().dismissSession(target.connectionId);
  if (!dismissed) {
    error(404, 'Session not found');
  }
});

export const dismissInactiveSessions = command(async () => {
  const dismissed = getSessionManager().dismissInactiveSessions();
  return { dismissed };
});
