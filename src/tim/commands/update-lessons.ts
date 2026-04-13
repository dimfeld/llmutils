// Shared lessons updater used by the workspace-aware update-docs flow
// and agent/batch follow-up work.

import * as fs from 'node:fs/promises';
import * as path from 'path';
import { getGitRoot } from '../../common/git.js';
import { promptCheckbox } from '../../common/input.js';
import { boldMarkdownHeaders, log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import type { TimConfig } from '../configSchema.js';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import type { PlanSchema } from '../planSchema.js';
import { materializePlan } from '../plan_materialize.js';
import { parsePlanIdFromCliArg, resolvePlanFromDb } from '../plans.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';

interface UpdateLessonsPromptOptions {
  include?: string[];
  exclude?: string[];
  docsPaths?: string[];
}

export type UpdateLessonsRunResult = true | false | 'skipped-no-lessons';

function extractLessonsLearnedFromContent(raw: string): string | null {
  const searchText = stripYamlFrontmatter(raw);

  const currentProgressMatch = /^## Current Progress\s*$/m.exec(searchText);
  if (!currentProgressMatch) {
    return null;
  }

  const currentProgressBody = searchText.slice(
    currentProgressMatch.index + currentProgressMatch[0].length
  );
  const nextH2InCurrentProgress = /\n##\s+/m.exec(currentProgressBody);
  const currentProgressSection = nextH2InCurrentProgress
    ? currentProgressBody.slice(0, nextH2InCurrentProgress.index)
    : currentProgressBody;

  const lessonsHeaderMatch = /^### Lessons Learned\s*$/m.exec(currentProgressSection);
  if (!lessonsHeaderMatch) {
    return null;
  }

  const lessonsBody = currentProgressSection.slice(
    lessonsHeaderMatch.index + lessonsHeaderMatch[0].length
  );
  const nextH3InLessons = /\n###\s+/m.exec(lessonsBody);
  const lessonsSection = nextH3InLessons
    ? lessonsBody.slice(0, nextH3InLessons.index)
    : lessonsBody;

  const trimmedLessons = lessonsSection.trim();
  if (!trimmedLessons) {
    return null;
  }

  const normalizedLines = trimmedLessons
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter((line) => line.length > 0);

  if (normalizedLines.length === 0) {
    return null;
  }

  if (normalizedLines.length === 1 && /^none\.?$/i.test(normalizedLines[0])) {
    return null;
  }

  return trimmedLessons;
}

export async function extractLessonsLearned(planFilePath: string): Promise<string | null> {
  const raw = await fs.readFile(planFilePath, 'utf-8');
  return extractLessonsLearnedFromContent(raw);
}

/** Parse a lessons learned markdown text into individual lesson items. */
export function parseLessonItems(lessonsText: string): string[] {
  return lessonsText
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter((line) => line.length > 0);
}

function stripYamlFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) {
    return content;
  }

  const closingDelimiterIndex = content.indexOf('\n---\n', 4);
  if (closingDelimiterIndex === -1) {
    return content;
  }

  return content.slice(closingDelimiterIndex + '\n---\n'.length);
}

export function buildUpdateLessonsPrompt(
  planData: PlanSchema,
  lessonsText: string,
  options: UpdateLessonsPromptOptions = {}
): string {
  const parts: string[] = [];
  const { include, exclude, docsPaths } = options;

  parts.push(
    'You have completed a plan and recorded lessons learned during implementation and review fixes.',
    'Please update relevant project documentation so these lessons are preserved for future work.\n'
  );

  parts.push(`# Plan: ${planData.title}\n`);

  if (planData.goal) {
    parts.push(`## Goal\n${planData.goal}\n`);
  }

  parts.push(`## Lessons Learned\n${lessonsText}\n`);

  const planContext = planData.details ? stripLessonsFromPlanContext(planData.details) : undefined;
  if (planContext) {
    parts.push(`## Plan Context\n${planContext}\n`);
  }

  const docsLocation =
    docsPaths && docsPaths.length > 0
      ? docsPaths.map((p) => `${p}/`).join(', ')
      : 'docs/ or similar';

  parts.push(
    'Focus on documentation about process, conventions, workflows, and gotchas.',
    'Do not focus on feature/API docs unless a lesson directly requires it.',
    'Update existing docs in place when possible rather than creating duplicate guidance.\n',
    'IMPORTANT: Only add lessons to top-level documents like CLAUDE.md, AGENTS.md, or root-level contributor',
    'guides if they are broadly applicable across the entire project. For lessons that are specific to a',
    'particular coding task, feature, module, or area of the codebase, prefer placing them in more targeted locations such',
    `as ${docsLocation} subdirectories, or documentation near the relevant code. You can create new documents files if there is no good existing place.`,
    'This prevents top-level documents from becoming cluttered with narrowly-scoped guidance.'
  );

  if (include && include.length > 0) {
    parts.push('\n## Files to Include');
    parts.push('Only edit documentation files matching these descriptions:');
    for (const pattern of include) {
      parts.push(`- ${pattern}`);
    }
  }

  if (exclude && exclude.length > 0) {
    parts.push('\n## Files to Exclude');
    parts.push('Never edit documentation files matching these descriptions:');
    for (const pattern of exclude) {
      parts.push(`- ${pattern}`);
    }
  }

  return parts.join('\n');
}

function stripLessonsFromPlanContext(details: string): string {
  const currentProgressMatch = /^## Current Progress\s*$/m.exec(details);
  if (!currentProgressMatch) {
    return details;
  }

  const currentProgressStart = currentProgressMatch.index + currentProgressMatch[0].length;
  const detailsAfterCurrentProgress = details.slice(currentProgressStart);
  const nextH2Match = /\n##\s+/m.exec(detailsAfterCurrentProgress);
  const currentProgressEnd = nextH2Match
    ? currentProgressStart + nextH2Match.index
    : details.length;

  const currentProgressSection = details.slice(currentProgressStart, currentProgressEnd);
  const lessonsHeaderMatch = /^### Lessons Learned\s*$/m.exec(currentProgressSection);
  if (!lessonsHeaderMatch) {
    return details;
  }

  const lessonsStart = currentProgressStart + lessonsHeaderMatch.index;
  const lessonsBodyStart = lessonsStart + lessonsHeaderMatch[0].length;
  const lessonsBody = details.slice(lessonsBodyStart, currentProgressEnd);
  const nextH3Match = /\n###\s+/m.exec(lessonsBody);
  const lessonsEnd = nextH3Match ? lessonsBodyStart + nextH3Match.index : currentProgressEnd;

  return (details.slice(0, lessonsStart) + details.slice(lessonsEnd))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function runUpdateLessons(
  planDataOrPath: PlanSchema | string,
  planFilePathOrConfig: string | TimConfig,
  configOrOptions:
    | TimConfig
    | {
        executor?: string;
        model?: string;
        baseDir?: string;
        configPath?: string;
        nonInteractive?: boolean;
        terminalInput?: boolean;
      },
  maybeOptions?: {
    executor?: string;
    model?: string;
    baseDir?: string;
    configPath?: string;
    nonInteractive?: boolean;
    terminalInput?: boolean;
  }
): Promise<UpdateLessonsRunResult> {
  const options = maybeOptions ?? (configOrOptions as NonNullable<typeof maybeOptions>);
  let planData: PlanSchema;
  let planFilePath: string;
  let effectiveConfig: TimConfig;
  let resolvedBaseDir = options.baseDir;
  if (typeof planDataOrPath === 'string') {
    const repoRoot =
      options.baseDir ??
      (await resolveRepoRootForPlanArg(planDataOrPath, process.cwd(), options.configPath));
    const resolvedPlan = await resolvePlanFromDb(planDataOrPath, repoRoot);
    planData = resolvedPlan.plan;
    planFilePath = resolvedPlan.planPath ?? (await materializePlan(planData.id, repoRoot));
    effectiveConfig = planFilePathOrConfig as TimConfig;
    resolvedBaseDir = repoRoot;
  } else {
    planData = planDataOrPath;
    planFilePath = planFilePathOrConfig as string;
    effectiveConfig = configOrOptions as TimConfig;
  }
  const lessonsSource = await Bun.file(planFilePath)
    .text()
    .catch(() => null);
  let lessonsLearned =
    lessonsSource !== null
      ? extractLessonsLearnedFromContent(lessonsSource)
      : planData.details
        ? extractLessonsLearnedFromContent(planData.details)
        : null;
  if (!lessonsLearned) {
    log('No lessons learned found in Current Progress. Skipping lessons documentation update.');
    return 'skipped-no-lessons';
  }

  const items = parseLessonItems(lessonsLearned);
  if (items.length > 0) {
    let selected: string[];
    if (options.nonInteractive || options.terminalInput === false) {
      // In non-interactive or no-terminal-input mode, auto-select all lessons
      selected = items;
    } else {
      selected = await promptCheckbox({
        message: 'Select lessons to apply:',
        choices: items.map((item) => ({
          name: item,
          value: item,
          checked: true,
        })),
      });
    }

    if (selected.length === 0) {
      log('No lessons selected. Skipping lessons documentation update.');
      return false;
    }

    lessonsLearned = selected.map((item) => `- ${item}`).join('\n');
  }

  const baseDir = resolvedBaseDir || (await getGitRoot()) || process.cwd();
  const excludePatterns = [...(effectiveConfig.updateDocs?.exclude ?? [])];

  const prompt = buildUpdateLessonsPrompt(planData, lessonsLearned, {
    docsPaths: effectiveConfig.paths?.docs,
    include: effectiveConfig.updateDocs?.include,
    exclude: excludePatterns.length > 0 ? excludePatterns : undefined,
  });

  const executorName =
    options.executor ||
    effectiveConfig.updateDocs?.executor ||
    effectiveConfig.defaultExecutor ||
    DEFAULT_EXECUTOR;

  const model =
    options.model ||
    effectiveConfig.updateDocs?.model ||
    effectiveConfig.models?.execution ||
    defaultModelForExecutor(executorName, 'execution');

  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir,
    model,
    noninteractive: options.nonInteractive ? true : undefined,
    terminalInput: options.terminalInput,
  };

  const executor = buildExecutorAndLog(executorName, sharedExecutorOptions, effectiveConfig);

  log(boldMarkdownHeaders('\n## Applying Lessons Learned to Documentation\n'));
  await executor.execute(prompt, {
    planId: planData.id?.toString() ?? 'unknown',
    planTitle: planData.title ?? 'Lessons Learned Documentation Update',
    planFilePath,
    executionMode: 'bare',
    captureOutput: 'none',
  });
  return true;
}

export async function handleUpdateLessonsCommand(
  planFile: string | undefined,
  options: any,
  command: any
) {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);

  if (!planFile) {
    throw new Error('A numeric plan ID is required');
  }
  const planIdArg = String(parsePlanIdFromCliArg(planFile));

  const repoRoot = await resolveRepoRootForPlanArg(
    planIdArg,
    (await getGitRoot()) || process.cwd(),
    globalOpts.config
  );
  const { plan, planPath } = await resolvePlanFromDb(planIdArg, repoRoot);
  const resolvedPlanFile = planPath ?? (await materializePlan(plan.id, repoRoot));
  const baseDir = repoRoot;

  const didRun = await runUpdateLessons(plan, resolvedPlanFile, config, {
    executor: options.executor,
    model: options.model,
    baseDir,
    configPath: globalOpts.config,
  });

  if (didRun === true) {
    log('\n✅ Lessons learned documentation update complete');
  }
}
