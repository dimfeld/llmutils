import * as path from 'node:path';
import type { Command } from 'commander';

import { buildWorkspaceCommandEnv } from '../../common/env.js';
import { getGitRoot } from '../../common/git.js';
import { runWithLogger } from '../../logging/adapter.js';
import { HeadlessAdapter } from '../../logging/headless_adapter.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import {
  buildTimWorkspaceCommandEnvironmentOptionsForPath,
  getWorkspaceInfoByPathIfAvailable,
} from '../environment_options.js';
import { createHeadlessAdapterForCommand } from '../headless.js';
import { LifecycleManager } from '../lifecycle.js';
import { resolveProjectContext } from '../plan_materialize.js';
import { resolvePlanByNumericId } from '../plans.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import type { PlanSchema } from '../planSchema.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import { generateBranchNameFromPlan, resolveBranchPrefix } from './branch.js';
import { resolvePrFixTarget } from './pr.js';

const DEFAULT_PTY_COLS = 80;
const DEFAULT_PTY_ROWS = 24;

export interface ShellCommandOptions {
  workspace?: string;
  autoWorkspace?: boolean;
  newWorkspace?: boolean;
  nonInteractive?: boolean;
  plan?: number;
  branch?: string;
  pr?: string;
  shell?: string;
  cols?: number;
  rows?: number;
}

export interface PtyShellSessionOptions {
  adapter: HeadlessAdapter;
  cwd: string;
  shellBinary: string;
  shellArgs?: string[];
  env?: Record<string, string>;
  cols: number;
  rows: number;
}

interface ShellTarget {
  repoRoot: string;
  planFile?: string;
  plan?: PlanSchema;
  checkoutBranch?: string;
  branchName?: string;
  linkedPr?: {
    url: string;
    number: number;
    title?: string;
  };
  forceWorkspace?: boolean;
}

function resolveShellBinary(optionValue: string | undefined): string {
  const explicit = optionValue?.trim();
  if (explicit) {
    return explicit;
  }

  const envShell = process.env.SHELL?.trim();
  return envShell || 'zsh';
}

function resolveTerminalSize(options: ShellCommandOptions): { cols: number; rows: number } {
  return {
    cols: options.cols ?? process.stdout.columns ?? DEFAULT_PTY_COLS,
    rows: options.rows ?? process.stdout.rows ?? DEFAULT_PTY_ROWS,
  };
}

async function resolvePlanCheckoutBranch(
  plan: PlanSchema,
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadEffectiveConfig>>
): Promise<string | undefined> {
  if (plan.branch) {
    return plan.branch;
  }

  const projectContext = await resolveProjectContext(repoRoot);
  const branchPrefix = resolveBranchPrefix({
    config,
    db: getDatabase(),
    projectId: projectContext.projectId,
  });
  return generateBranchNameFromPlan(plan, { branchPrefix });
}

export async function resolveShellTarget(
  positionalPlanId: number | undefined,
  options: ShellCommandOptions,
  command: Command,
  configPath: string | undefined,
  config: Awaited<ReturnType<typeof loadEffectiveConfig>>
): Promise<ShellTarget> {
  if (positionalPlanId !== undefined && options.plan !== undefined) {
    throw new Error('Specify a plan ID either positionally or with --plan, not both');
  }
  if (
    options.pr &&
    (positionalPlanId !== undefined || options.plan !== undefined || options.branch)
  ) {
    throw new Error('--pr cannot be combined with a plan ID, --plan, or --branch');
  }
  if (options.branch && (positionalPlanId !== undefined || options.plan !== undefined)) {
    throw new Error('--branch cannot be combined with a plan ID or --plan');
  }

  const fallbackRoot = (await getGitRoot()) || process.cwd();
  const planId = positionalPlanId ?? options.plan;

  if (options.pr) {
    const target = await resolvePrFixTarget(
      { mode: 'pr', prUrlOrNumber: options.pr },
      command as Parameters<typeof resolvePrFixTarget>[1]
    );
    if (target.kind !== 'pr') {
      throw new Error(`Expected PR target for ${options.pr}`);
    }
    return {
      repoRoot: target.repoRoot,
      checkoutBranch: target.headBranch,
      branchName: target.headBranch,
      linkedPr: {
        url: target.canonicalPrUrl,
        number: target.prNumber,
        title: target.title,
      },
      forceWorkspace: true,
    };
  }

  const repoRoot = await resolveRepoRoot(configPath, fallbackRoot);
  if (planId !== undefined) {
    const resolvedPlan = await resolvePlanByNumericId(planId, repoRoot);
    return {
      repoRoot,
      planFile: resolvedPlan.planPath ?? undefined,
      plan: resolvedPlan.plan,
      checkoutBranch: await resolvePlanCheckoutBranch(resolvedPlan.plan, repoRoot, config),
      forceWorkspace: true,
    };
  }

  if (options.branch) {
    return {
      repoRoot,
      checkoutBranch: options.branch,
      branchName: options.branch,
      forceWorkspace: true,
    };
  }

  return { repoRoot };
}

export async function runPtyShellSession({
  adapter,
  cwd,
  shellBinary,
  shellArgs = ['-l'],
  env,
  cols,
  rows,
}: PtyShellSessionOptions): Promise<void> {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  // True once the terminal has been closed or close has been requested, so the
  // finally block does not attempt a redundant close().
  let closeRequested = false;

  proc = Bun.spawn([shellBinary, ...shellArgs], {
    cwd,
    env,
    terminal: {
      cols,
      rows,
      name: 'xterm-256color',
      data(_terminal: unknown, bytes: Uint8Array): void {
        adapter.broadcastPtyOutput(bytes);
      },
      exit(_terminal: unknown, _code: number, _signal: string | null): void {
        closeRequested = true;
      },
    },
  });

  if (!proc.terminal) {
    // Reap the spawned child so it is not orphaned without a terminal to drive it.
    proc.kill('SIGTERM');
    throw new Error(`Failed to start PTY shell: ${shellBinary}`);
  }

  adapter.setPtyInputHandler((bytes: Uint8Array): void => {
    proc?.terminal?.write(bytes);
  });
  adapter.setPtyResizeHandler((nextCols: number, nextRows: number): void => {
    proc?.terminal?.resize(nextCols, nextRows);
  });
  adapter.setEndSessionHandler((): void => {
    closeRequested = true;
    proc?.terminal?.close();
  });
  adapter.setForceEndSessionHandler((): void => {
    proc?.kill('SIGTERM');
  });

  try {
    await proc.exited;
  } finally {
    adapter.setPtyInputHandler(undefined);
    adapter.setPtyResizeHandler(undefined);
    adapter.setEndSessionHandler(undefined);
    adapter.setForceEndSessionHandler(undefined);
    if (!closeRequested) {
      proc.terminal.close();
    }
  }
}

export async function handleShellCommand(
  positionalPlanId: number | undefined,
  options: ShellCommandOptions,
  command: Command
): Promise<void> {
  const globalOpts = (command.parent?.opts() ?? {}) as { config?: string };
  const config = await loadEffectiveConfig(globalOpts.config);
  const target = await resolveShellTarget(
    positionalPlanId,
    options,
    command,
    globalOpts.config,
    config
  );
  const workspaceMode =
    target.forceWorkspace === true ||
    options.workspace !== undefined ||
    options.autoWorkspace === true ||
    options.newWorkspace === true;

  let baseDir = target.repoRoot;
  let currentPlanFile = target.planFile;
  if (workspaceMode) {
    const useAutoWorkspace =
      options.autoWorkspace === true ||
      (!options.workspace && (target.forceWorkspace || options.newWorkspace));
    const workspaceResult = await setupWorkspace(
      {
        workspace: options.workspace,
        autoWorkspace: useAutoWorkspace,
        newWorkspace: options.newWorkspace,
        nonInteractive: options.nonInteractive,
        requireWorkspace: false,
        planId: target.plan?.id,
        planUuid: target.plan?.uuid,
        checkoutBranch: target.checkoutBranch,
        branchName: target.branchName,
        createBranch: false,
        allowPrimaryWorkspaceWhenLocked: true,
      },
      baseDir,
      currentPlanFile,
      config,
      'tim shell'
    );
    baseDir = workspaceResult.baseDir;
    currentPlanFile = workspaceResult.planFile || currentPlanFile;
  }

  const { cols, rows } = resolveTerminalSize(options);
  const shellBinary = resolveShellBinary(options.shell);
  const timEnvironment = buildTimWorkspaceCommandEnvironmentOptionsForPath(
    config,
    baseDir,
    target.plan
      ? {
          planId: target.plan.id,
          planUuid: target.plan.uuid,
          planFilePath: currentPlanFile,
          branch: target.plan.branch,
        }
      : null,
    path.resolve(target.repoRoot)
  );
  const env = await buildWorkspaceCommandEnv(
    baseDir,
    { TERM: 'xterm-256color' },
    {
      timEnvironment,
    }
  );
  const adapter = await createHeadlessAdapterForCommand({
    command: 'shell',
    interactive: true,
    plan: target.plan
      ? {
          id: target.plan.id,
          uuid: target.plan.uuid,
          title: target.plan.title,
        }
      : undefined,
    sessionInfo: {
      pty: true,
      cols,
      rows,
      workspacePath: baseDir,
      linkedPrUrl: target.linkedPr?.url,
      linkedPrNumber: target.linkedPr?.number,
      linkedPrTitle: target.linkedPr?.title,
    },
    // SessionDiscoveryClient skips token-authenticated sessions, so the PTY
    // agent must start its embedded server without a bearer token to be
    // discoverable by the web server.
    disableBearerToken: true,
  });

  try {
    await runWithLogger(adapter, async (): Promise<void> => {
      let lifecycleManager: LifecycleManager | undefined;
      if (config.lifecycle?.commands && config.lifecycle.commands.length > 0) {
        const workspaceInfo = getWorkspaceInfoByPathIfAvailable(baseDir);
        lifecycleManager = new LifecycleManager(
          config.lifecycle.commands,
          baseDir,
          workspaceInfo?.workspaceType,
          'shell',
          undefined,
          {
            timEnvironment,
          }
        );
        await lifecycleManager.startup();
      }

      try {
        await runPtyShellSession({
          adapter,
          cwd: baseDir,
          shellBinary,
          env,
          cols,
          rows,
        });
      } finally {
        await lifecycleManager?.shutdown();
      }
    });
  } finally {
    await adapter.destroy();
  }
}
