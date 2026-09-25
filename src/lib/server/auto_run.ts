import type { Database } from 'bun:sqlite';
import fs from 'node:fs';

import { createLogFile } from '$common/log_files.js';
import { resolveTimExecutable } from '$common/tim_executable.js';
import { loadEffectiveConfig } from '$tim/configLoader.js';
import type { TimConfig } from '$tim/configSchema.js';
import { getPlanByUuid } from '$tim/db/plan.js';
import { getProjectById } from '$tim/db/project.js';
import { getProjectSetting } from '$tim/db/project_settings.js';
import { isWorkCompleteStatus } from '$tim/plans/plan_state_utils.js';
import { getAgentMultiPlansForProject } from '$tim/commands/agent_multi/plan_loader.js';
import type { AgentMultiPlan } from '$tim/commands/agent_multi/orchestrator.js';
import { listSessionInfoFiles } from '$tim/session_server/runtime_dir.js';
import { writePlanSetStatus } from '$tim/sync/write_router.js';
import { getLocalNodeId } from '$tim/sync/config.js';
import { getPreferredProjectGitRoot } from '$tim/workspace/workspace_info.js';
import { AUTO_RUN_SETTING_KEY, parseAutoRunSetting } from '$tim/auto_run/settings.js';

const RECONCILE_INTERVAL_MS = 30_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function selectQueuedPlans(plans: AgentMultiPlan[], active: Set<string>): AgentMultiPlan[] {
  const byUuid = new Map(plans.map((plan) => [plan.uuid, plan]));
  return plans
    .filter((plan) => {
      if (
        plan.status !== 'queued' ||
        plan.epic === true ||
        (plan.taskCount <= plan.doneTaskCount && !(plan.taskCount === 0 && plan.simple === true)) ||
        active.has(plan.uuid)
      ) {
        return false;
      }
      return [...plan.dependencies, ...(plan.basePlanUuid ? [plan.basePlanUuid] : [])].every(
        (uuid) => isWorkCompleteStatus(byUuid.get(uuid)?.status)
      );
    })
    .sort((a, b) => a.planId - b.planId);
}

export function selectPlansForAvailableSlots(
  plans: AgentMultiPlan[],
  activeSessionUuids: string[],
  launching: Set<string>,
  maxConcurrent: number
): AgentMultiPlan[] {
  const planUuids = new Set(plans.map((plan) => plan.uuid));
  const active = new Set(activeSessionUuids);
  const sessionCount = activeSessionUuids.filter((uuid) => planUuids.has(uuid)).length;
  const launchCount = [...launching].filter(
    (uuid) => planUuids.has(uuid) && !active.has(uuid)
  ).length;
  const slots = maxConcurrent - sessionCount - launchCount;
  if (slots <= 0) return [];
  return selectQueuedPlans(plans, new Set([...active, ...launching])).slice(0, slots);
}

export class AutoRunScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;
  private readonly launching = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly config: TimConfig
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.runOnce().catch(console.error), RECONCILE_INTERVAL_MS);
    void this.runOnce().catch(console.error);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const settings = this.db
        .prepare('SELECT project_id FROM project_setting WHERE setting = ?')
        .all(AUTO_RUN_SETTING_KEY) as Array<{ project_id: number }>;
      const sessions = listSessionInfoFiles().filter(
        (session) => session.command === 'agent' && session.planUuid && isProcessAlive(session.pid)
      );
      for (const { project_id: projectId } of settings) {
        const setting = parseAutoRunSetting(
          getProjectSetting(this.db, projectId, AUTO_RUN_SETTING_KEY)
        );
        if (!setting?.enabled || !setting.maxConcurrent) continue;
        if (setting.runnerNodeId !== (await getLocalNodeId(this.config))) continue;
        const project = getProjectById(this.db, projectId);
        const cwd = getPreferredProjectGitRoot(this.db, projectId);
        if (!project || !cwd) continue;

        const plans = getAgentMultiPlansForProject(this.db, projectId);
        const candidates = selectPlansForAvailableSlots(
          plans,
          sessions.map((session) => session.planUuid!),
          this.launching,
          setting.maxConcurrent
        );
        for (const plan of candidates) {
          this.launching.add(plan.uuid);
          void this.launch(project.uuid, cwd, plan).catch(console.error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async launch(projectUuid: string, cwd: string, plan: AgentMultiPlan): Promise<void> {
    let logFile: ReturnType<typeof createLogFile> | null = null;
    try {
      const config = await loadEffectiveConfig(undefined, { cwd });
      if (getPlanByUuid(this.db, plan.uuid)?.status !== 'queued') return;
      logFile = createLogFile('auto-run', plan.planId);
      const child = Bun.spawn(
        [
          resolveTimExecutable(),
          'agent',
          String(plan.planId),
          '--auto-workspace',
          '--no-terminal-input',
        ],
        { cwd, stdin: 'ignore', stdout: logFile.fd, stderr: logFile.fd, detached: true }
      );
      fs.closeSync(logFile.fd);
      logFile = null;
      await child.exited;
      const latest = getPlanByUuid(this.db, plan.uuid);
      if (latest?.status === 'in_progress' || latest?.status === 'queued') {
        await writePlanSetStatus(this.db, config, projectUuid, plan.uuid, 'needs_attention');
      }
    } catch (error) {
      console.error(`[auto-run] Plan ${plan.planId} failed to start or finish`, error);
      try {
        const config = await loadEffectiveConfig(undefined, { cwd });
        const latestStatus = getPlanByUuid(this.db, plan.uuid)?.status;
        if (latestStatus === 'in_progress' || latestStatus === 'queued') {
          await writePlanSetStatus(this.db, config, projectUuid, plan.uuid, 'needs_attention');
        }
      } catch (statusError) {
        console.error(`[auto-run] Could not mark plan ${plan.planId} for attention`, statusError);
      }
    } finally {
      if (logFile) fs.closeSync(logFile.fd);
      this.launching.delete(plan.uuid);
      void this.runOnce().catch(console.error);
    }
  }
}
