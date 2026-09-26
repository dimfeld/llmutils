import { randomUUID } from 'node:crypto';
import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import { getPrimaryWorkspacePath } from '$tim/db/workspace.js';
import { spawnProjectChatProcess } from '$lib/server/plan_actions.js';
import { getSessionManager } from '$lib/server/session_context.js';
import { getRemoteTrunkBranch } from '$common/git.js';
import { loadEffectiveConfig } from '$tim/configLoader.js';
import {
  finishProjectChat as finishProjectChatBranch,
  remoteProjectChatBranchExists,
  type ProjectChatWorkflow,
} from '$lib/server/project_chat_finish.js';

const startProjectChatSchema = z.object({
  projectId: z.number().int().positive(),
  executor: z.enum(['claude', 'codex', 'claude-code', 'codex-cli']),
  model: z.string().min(1).optional(),
});

export const startProjectChat = command(
  startProjectChatSchema,
  async ({ projectId, executor, model }) => {
    const { db } = await getServerContext();
    const cwd = getPrimaryWorkspacePath(db, projectId);
    if (!cwd) error(400, 'Project has no primary workspace');

    const chatId = randomUUID();
    const result = await spawnProjectChatProcess(chatId, cwd, executor, model);
    if (!result.success) error(500, result.error);
    return { status: 'started' as const, chatId };
  }
);

const projectChatTargetSchema = z.object({ connectionId: z.string().min(1) });

async function getProjectChatContext(connectionId: string): Promise<{
  cwd: string;
  branch: string;
  chatId: string;
  trunk: string;
  workflow: ProjectChatWorkflow;
}> {
  const session = getSessionManager().getSessionTranscript(connectionId);
  const chatId = session?.sessionInfo.projectChatId;
  if (
    !session ||
    session.sessionInfo.command !== 'chat' ||
    !chatId ||
    !z.string().uuid().safeParse(chatId).success ||
    !session.projectId
  ) {
    error(404, 'Project chat not found');
  }
  const branch = `chat/${chatId}`;
  if (session.sessionInfo.projectChatBranch !== branch) {
    error(400, 'Project chat branch is not available');
  }

  const { db } = await getServerContext();
  const cwd = getPrimaryWorkspacePath(db, session.projectId);
  if (!cwd) error(400, 'Project has no primary workspace');
  const config = await loadEffectiveConfig(undefined, { cwd, quiet: true });
  return {
    cwd,
    branch,
    chatId,
    trunk: await getRemoteTrunkBranch(cwd),
    workflow: config.developmentWorkflow ?? 'pr-based',
  };
}

export const getProjectChatFinishInfo = query(projectChatTargetSchema, async ({ connectionId }) => {
  const context = await getProjectChatContext(connectionId);
  const session = getSessionManager().getSessionTranscript(connectionId);
  return {
    workflow: context.workflow,
    branch: context.branch,
    trunk: context.trunk,
    hasPushedChanges: await remoteProjectChatBranchExists(context.cwd, context.branch),
    sessionEnded: session?.status === 'offline',
  };
});

export const finishProjectChat = command(
  projectChatTargetSchema.extend({ summary: z.string().trim().min(1) }),
  async ({ connectionId, summary }) => {
    const context = await getProjectChatContext(connectionId);
    const session = getSessionManager().getSessionTranscript(connectionId);
    if (session?.status !== 'offline') error(400, 'End this chat before finishing its work');
    try {
      return await finishProjectChatBranch({ ...context, summary });
    } catch (cause) {
      error(500, cause instanceof Error ? cause.message : String(cause));
    }
  }
);
