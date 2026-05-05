import * as path from 'node:path';
import { getGitRoot } from '../../common/git.js';
import { commitAll } from '../../common/process.js';
import { getLoggerAdapter } from '../../logging/adapter.js';
import { HeadlessAdapter } from '../../logging/headless_adapter.js';
import { warn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import { buildDescriptionFromPlan, getCombinedTitleFromSummary } from '../display_utils.js';
import { resolvePlanByNumericId, writePlanToDb } from '../plans.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { buildExecutorAndLog, DEFAULT_EXECUTOR } from '../executors/index.js';
import { ClaudeCodeExecutorName, CodexCliExecutorName } from '../executors/schemas.js';
import { isCodexAppServerEnabled } from '../executors/codex_cli/app_server_mode.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { watchPlanFile } from '../plan_file_watcher.js';
import { resolveProjectContext } from '../plan_materialize.js';
import { readPlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { generateBranchNameFromPlan, resolveBranchPrefix } from './branch.js';
import { resolveOptionalPromptInput, type PromptResolverDeps } from './prompt_input.js';
import {
  patchWorkspaceInfo,
  getWorkspaceInfoByPath,
  touchWorkspaceInfo,
} from '../workspace/workspace_info.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import {
  materializePlansForExecution,
  prepareWorkspaceRoundTrip,
  runPostExecutionWorkspaceSync,
  runPreExecutionWorkspaceSync,
} from '../workspace/workspace_roundtrip.js';
import { LATEST_GPT5_MODEL, LATEST_GPT5_MINI_MODEL } from '../constants.js';

const CHAT_COMPATIBLE_EXECUTORS = new Set([ClaudeCodeExecutorName, CodexCliExecutorName]);
const MODEL_ALIASES = new Map<string, string>([
  ['gpt5', LATEST_GPT5_MODEL],
  ['mini', LATEST_GPT5_MINI_MODEL],
  ['spark', 'gpt-5.3-codex-spark'],
]);
const CHAT_EXECUTOR_ALIASES = new Map<string, string>([
  ['claude', ClaudeCodeExecutorName],
  [ClaudeCodeExecutorName, ClaudeCodeExecutorName],
  ['codex', CodexCliExecutorName],
  [CodexCliExecutorName, CodexCliExecutorName],
]);

export interface ChatCommandOptions {
  executor?: string;
  model?: string;
  promptFile?: string;
  nonInteractive?: boolean;
  terminalInput?: boolean;
  headlessAdapter?: boolean;
  workspace?: string;
  autoWorkspace?: boolean;
  newWorkspace?: boolean;
  workspaceSync?: boolean;
  commit?: boolean;
  plan?: number;
}

export interface ChatGlobalOptions {
  config?: string;
}

async function updateWorkspaceDescriptionFromPlan(
  baseDir: string,
  planData: PlanSchema
): Promise<void> {
  try {
    const workspaceMetadata = getWorkspaceInfoByPath(baseDir);
    if (!workspaceMetadata) {
      return;
    }

    const description = buildDescriptionFromPlan(planData);
    const planId = planData.id ? String(planData.id) : '';
    const prefixedDescription = planId ? `${planId} - ${description}` : description;
    const planTitle = getCombinedTitleFromSummary(planData);

    patchWorkspaceInfo(baseDir, {
      description: prefixedDescription,
      planId,
      planTitle: planTitle || '',
      issueUrls: planData.issue && planData.issue.length > 0 ? [...planData.issue] : [],
    });
  } catch (err) {
    warn(`Failed to update workspace description: ${err as Error}`);
  }
}

function resolveChatExecutor(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }

  return CHAT_EXECUTOR_ALIASES.get(input.trim().toLowerCase());
}

function inferExecutorFromModel(model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }
  const m = model.trim().toLowerCase();
  if (m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
    return ClaudeCodeExecutorName;
  }
  if (m.startsWith('gpt')) {
    return CodexCliExecutorName;
  }
  return undefined;
}

export async function resolveOptionalPromptText(
  promptText: string | undefined,
  options: {
    promptFile?: string;
    stdinIsTTY?: boolean;
    tunnelActive?: boolean;
    readStdinWhenNotTTY?: boolean;
  },
  deps: PromptResolverDeps = {}
): Promise<string | undefined> {
  const tunnelActive = options.tunnelActive ?? false;
  const hasPromptFile = Boolean(options.promptFile);
  const shouldReadStdinWhenNotTTY =
    options.readStdinWhenNotTTY ?? (!tunnelActive && !hasPromptFile);

  return resolveOptionalPromptInput(
    {
      promptText,
      promptFile: options.promptFile,
      stdinIsTTY: options.stdinIsTTY,
      readStdinWhenNotTTY: shouldReadStdinWhenNotTTY,
      preferPositionalPrompt: true,
    },
    deps
  );
}

export async function handleChatCommand(
  promptText: string | undefined,
  options: ChatCommandOptions,
  globalOpts: ChatGlobalOptions
): Promise<void> {
  const config = await loadEffectiveConfig(globalOpts.config);
  const workspaceMode =
    options.workspace !== undefined ||
    options.autoWorkspace === true ||
    options.newWorkspace === true ||
    options.plan !== undefined;

  // Validate that workspace-modifier flags require workspace mode
  if (!workspaceMode) {
    if (options.commit) {
      throw new Error('--commit requires a workspace option (-w, --aw, --nw, or --plan)');
    }
  }

  const resolvedModel = options.model
    ? (MODEL_ALIASES.get(options.model.trim().toLowerCase()) ?? options.model)
    : undefined;
  const tunnelActive = isTunnelActive();
  const noninteractive = options.nonInteractive === true;
  // Resolve repo root from config/plan arg once, for both plan resolution and workspace setup
  const configRepoRoot =
    options.plan || globalOpts.config
      ? await resolveRepoRoot(globalOpts.config)
      : (await getGitRoot()) || process.cwd();
  const workspaceConfig =
    path.resolve(configRepoRoot) === path.resolve(process.cwd())
      ? config
      : await loadEffectiveConfig(globalOpts.config, { cwd: configRepoRoot });

  const requestedExecutorRaw = options.executor ?? workspaceConfig.defaultExecutor;
  const requestedExecutor =
    resolveChatExecutor(requestedExecutorRaw) ??
    (options.executor === undefined ? inferExecutorFromModel(resolvedModel) : undefined);
  if (requestedExecutorRaw && !requestedExecutor) {
    const allowed = [...CHAT_EXECUTOR_ALIASES.keys()].join(', ');
    if (options.executor) {
      throw new Error(
        `Executor '${requestedExecutorRaw}' is not supported by 'tim chat'. Supported executors: ${allowed}`
      );
    }
    // config.defaultExecutor is incompatible, fall back to DEFAULT_EXECUTOR
    console.warn(
      `Warning: defaultExecutor '${requestedExecutorRaw}' is not supported by 'tim chat'. Falling back to '${DEFAULT_EXECUTOR}'.`
    );
  }
  const executorName = requestedExecutor ?? DEFAULT_EXECUTOR;
  const codexAppServerEnabled = isCodexAppServerEnabled();
  const canUseTerminalInput =
    !noninteractive &&
    process.stdin.isTTY === true &&
    options.terminalInput !== false &&
    workspaceConfig.terminalInput !== false;
  const terminalInputEnabled =
    executorName === CodexCliExecutorName && !codexAppServerEnabled ? false : canUseTerminalInput;
  const prompt = await resolveOptionalPromptText(promptText, {
    promptFile: options.promptFile,
    stdinIsTTY: process.stdin.isTTY,
    tunnelActive,
    readStdinWhenNotTTY: terminalInputEnabled && !tunnelActive,
  });

  let currentBaseDir = process.cwd();
  let currentPlanFile = '';
  let currentPlanData: PlanSchema | undefined;
  let touchedWorkspacePath: string | null = null;
  let roundTripContext: Awaited<ReturnType<typeof prepareWorkspaceRoundTrip>> = null;
  let executionError: unknown;
  let planWatcher: ReturnType<typeof watchPlanFile> | undefined;

  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: process.cwd(),
    model: resolvedModel,
    noninteractive: noninteractive ? true : undefined,
    terminalInput: terminalInputEnabled,
    closeTerminalInputOnResult: false,
    disableInactivityTimeout: true,
  };

  if (options.plan) {
    const resolvedPlan = await resolvePlanByNumericId(options.plan, configRepoRoot);
    currentPlanFile = resolvedPlan.planPath ?? '';
    currentPlanData = resolvedPlan.plan;
  }

  await runWithHeadlessAdapterIfEnabled({
    enabled: options.headlessAdapter === true || !tunnelActive,
    command: 'chat',
    interactive: !noninteractive,
    plan: currentPlanData
      ? {
          id: currentPlanData.id,
          uuid: currentPlanData.uuid,
          title: currentPlanData.title,
        }
      : undefined,
    callback: async () => {
      try {
        if (workspaceMode) {
          currentBaseDir = configRepoRoot;

          // --plan implies auto-workspace selection when no explicit workspace option is set
          const useAutoWorkspace =
            options.autoWorkspace === true ||
            (options.plan !== undefined && !options.workspace && !options.newWorkspace);

          // When --plan is provided, derive branch from plan data.
          let checkoutBranch: string | undefined;
          if (currentPlanData) {
            if (currentPlanData.branch) {
              checkoutBranch = currentPlanData.branch;
            } else {
              const projectContext = await resolveProjectContext(configRepoRoot);
              const branchPrefix = resolveBranchPrefix({
                config: workspaceConfig,
                db: getDatabase(),
                projectId: projectContext.projectId,
              });
              checkoutBranch = generateBranchNameFromPlan(currentPlanData, {
                branchPrefix,
              });
            }
          }

          const workspaceResult = await setupWorkspace(
            {
              workspace: options.workspace,
              autoWorkspace: useAutoWorkspace,
              newWorkspace: options.newWorkspace,
              nonInteractive: options.nonInteractive,
              requireWorkspace: false,
              planId: currentPlanData?.id,
              planUuid: currentPlanData?.uuid,
              checkoutBranch,
              allowPrimaryWorkspaceWhenLocked: true,
            },
            currentBaseDir,
            currentPlanFile || undefined,
            workspaceConfig,
            'tim chat'
          );
          currentBaseDir = workspaceResult.baseDir;
          currentPlanFile = workspaceResult.planFile;
          touchedWorkspacePath = currentBaseDir;

          if (path.resolve(currentBaseDir) !== path.resolve(configRepoRoot)) {
            roundTripContext = await prepareWorkspaceRoundTrip({
              workspacePath: currentBaseDir,
              workspaceSyncEnabled: options.workspaceSync !== false,
              branchCreatedDuringSetup: workspaceResult.branchCreatedDuringSetup,
            });
          }

          if (roundTripContext) {
            await runPreExecutionWorkspaceSync(roundTripContext);

            const materializedPlanFile = await materializePlansForExecution(
              currentBaseDir,
              currentPlanData?.id
            );
            if (materializedPlanFile) {
              currentPlanFile = materializedPlanFile;
            }
          }

          if (currentPlanData) {
            await updateWorkspaceDescriptionFromPlan(currentBaseDir, currentPlanData);
          }
        }

        const executor = buildExecutorAndLog(
          executorName,
          {
            ...sharedExecutorOptions,
            baseDir: currentBaseDir,
          },
          workspaceConfig
        );
        const promptForExecution = executorName === CodexCliExecutorName ? (prompt ?? '') : prompt;

        const loggerAdapter = getLoggerAdapter();
        if (currentPlanFile && loggerAdapter instanceof HeadlessAdapter) {
          planWatcher = watchPlanFile(currentPlanFile, ({ content, tasks }) => {
            loggerAdapter.sendPlanContent(content, tasks);
          });
        }

        await executor.execute(promptForExecution, {
          planId: currentPlanData?.id ? String(currentPlanData.id) : 'chat',
          planTitle: currentPlanData?.title || 'Chat Session',
          planFilePath: currentPlanFile,
          executionMode: 'bare',
        });

        if (currentPlanFile) {
          const updatedPlan = await readPlanFile(currentPlanFile);
          await writePlanToDb(updatedPlan, {
            cwdForIdentity: currentBaseDir,
            config,
          });
        }

        if (options.commit) {
          await commitAll('workspace chat session', currentBaseDir);
        }
      } catch (err) {
        executionError = err;
      } finally {
        await planWatcher?.closeAndFlush();
        planWatcher = undefined;

        let roundTripError: unknown;
        // Post-sync always runs when workspace roundtrip is active (matching generate/agent).
        // It commits and pushes as part of the workspace lifecycle, independent of --commit.
        if (roundTripContext) {
          try {
            await runPostExecutionWorkspaceSync(roundTripContext, 'workspace chat session');
          } catch (err) {
            roundTripError = err;
          }
        }

        if (touchedWorkspacePath) {
          try {
            touchWorkspaceInfo(touchedWorkspacePath);
          } catch (err) {
            warn(`Failed to update workspace last used time: ${err as Error}`);
          }
        }

        if (executionError) {
          if (roundTripError) {
            warn(`Workspace sync failed after chat error: ${roundTripError as Error}`);
          }
          throw executionError;
        }

        if (roundTripError) {
          throw roundTripError;
        }
      }
    },
  });
}
