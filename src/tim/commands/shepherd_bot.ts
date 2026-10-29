import type { Database } from 'bun:sqlite';

import { isTunnelActive } from '../../logging/tunnel_client.js';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import { upsertInboxItem } from '../db/inbox_item.js';
import {
  finishShepherdBotRun,
  getShepherdBotRun,
  heartbeatShepherdBotRun,
  insertShepherdBotAction,
  insertShepherdBotTrigger,
  listShepherdBotTriggersForRun,
  type ShepherdBotRunRow,
} from '../db/shepherd_bot.js';
import { buildTimWorkspaceCommandEnvironmentOptionsForPath } from '../environment_options.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import {
  buildShepherdBotPrompt,
  loadShepherdBotContext,
  parseShepherdBotOutput,
  type ShepherdBotContext,
  type ShepherdBotOutput,
  type ShepherdBotStackEntry,
} from '../shepherd_bot/prompt.js';
import {
  getShepherdBotStatePaths,
  readShepherdBotState,
  resolveShepherdBotSettings,
  writeShepherdBotState,
} from '../shepherd_bot/settings.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface ShepherdBotGlobalOptions {
  config?: string;
}

function findWatchedPr(
  context: ShepherdBotContext,
  prNumber: number
): ShepherdBotStackEntry | null {
  for (const group of context.stacks) {
    const entry = group.find((candidate) => candidate.pr.status.pr_number === prNumber);
    if (entry) {
      return entry;
    }
  }
  return null;
}

/**
 * Save the bot's state and record the actions that it asked for. Fix sessions are only
 * recorded as `requested` here; the web server checks the guardrails and starts them.
 */
export async function applyShepherdBotOutput(
  db: Database,
  run: Pick<ShepherdBotRunRow, 'id' | 'project_id'>,
  context: ShepherdBotContext,
  output: ShepherdBotOutput,
  now: Date = new Date()
): Promise<void> {
  await writeShepherdBotState(run.project_id, {
    markdown: output.stateMarkdown,
    json: output.stateJson,
  });

  let recheckScheduled = false;
  for (const action of output.actions) {
    if (action.type === 'recheck') {
      // One recheck is enough. A trigger or a session end wakes the bot anyway.
      if (recheckScheduled) {
        continue;
      }
      recheckScheduled = true;
      insertShepherdBotTrigger(db, {
        projectId: run.project_id,
        kind: 'recheck',
        details: { reason: action.reason },
        dueAt: new Date(now.getTime() + action.afterMinutes * 60_000),
      });
      insertShepherdBotAction(db, {
        projectId: run.project_id,
        runId: run.id,
        kind: 'recheck',
        reason: action.reason,
        status: 'done',
        result: `in ${action.afterMinutes} minutes`,
      });
      continue;
    }

    const entry = findWatchedPr(context, action.pr);
    const target = entry?.pr.status;
    const common = {
      projectId: run.project_id,
      runId: run.id,
      kind: action.type,
      prStatusId: target?.id ?? null,
      prUrl: target?.pr_url ?? null,
      prNumber: action.pr,
      headSha: target?.head_sha ?? null,
      reason: action.type === 'notify' ? action.message : action.reason,
    } as const;

    if (!entry || !target || !entry.botEnabled) {
      insertShepherdBotAction(db, {
        ...common,
        status: 'rejected',
        result: 'The PR is not an open PR that the bot watches',
      });
      continue;
    }

    if (action.type === 'notify') {
      upsertInboxItem(db, {
        projectId: run.project_id,
        kind: 'shepherd_bot',
        prUrl: target.pr_url,
        prNumber: target.pr_number,
        repo: `${target.owner}/${target.repo}`,
        prTitle: target.title,
        actor: 'tim',
        summary: action.message,
      });
      insertShepherdBotAction(db, { ...common, status: 'done' });
      continue;
    }

    insertShepherdBotAction(db, { ...common, status: 'requested' });
  }
}

export async function handleShepherdBotRunCommand(
  runIdArg: string,
  globalOpts: ShepherdBotGlobalOptions
): Promise<void> {
  const runId = Number(runIdArg);
  if (!Number.isInteger(runId) || runId <= 0) {
    throw new Error(`Invalid shepherd bot run ID: ${runIdArg}`);
  }

  const db = getDatabase();
  const run = getShepherdBotRun(db, runId);
  if (!run) {
    throw new Error(`Shepherd bot run ${runId} not found`);
  }
  if (run.status !== 'running') {
    throw new Error(`Shepherd bot run ${runId} is already ${run.status}`);
  }

  heartbeatShepherdBotRun(db, runId, process.pid);
  const heartbeat = setInterval(() => {
    try {
      heartbeatShepherdBotRun(db, runId);
    } catch (err) {
      console.warn(`[shepherd_bot] Heartbeat failed for run ${runId}`, err);
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  try {
    const config = await loadEffectiveConfig(globalOpts.config);
    const settings = resolveShepherdBotSettings(config);

    await runWithHeadlessAdapterIfEnabled({
      enabled: !isTunnelActive(),
      command: 'shepherd-bot',
      interactive: false,
      callback: async () => {
        const triggers = listShepherdBotTriggersForRun(db, runId);
        const context = loadShepherdBotContext(db, run.project_id, triggers);
        const state = await readShepherdBotState(run.project_id);
        const prompt = buildShepherdBotPrompt(
          context,
          state,
          getShepherdBotStatePaths(run.project_id)
        );

        const baseDir = process.cwd();
        const executor = buildExecutorAndLog(
          settings.executor,
          {
            baseDir,
            model: settings.model,
            noninteractive: true,
            timEnvironment: buildTimWorkspaceCommandEnvironmentOptionsForPath(config, baseDir),
          },
          config
        );
        const result = await executor.execute(prompt, {
          planId: `shepherd-bot-${runId}`,
          planTitle: 'PR shepherd bot',
          captureOutput: 'result',
          executionMode: 'bare',
        });
        const text = typeof result === 'string' ? result : (result?.content ?? '');
        const output = parseShepherdBotOutput(text);

        await applyShepherdBotOutput(db, run, context, output);
        finishShepherdBotRun(db, runId, 'completed', { summary: output.summary });
        log(`Shepherd bot run ${runId}: ${output.summary}`);
      },
    });
  } catch (err) {
    finishShepherdBotRun(db, runId, 'failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}
