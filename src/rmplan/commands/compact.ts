import { Command } from 'commander';
import chalk from 'chalk';
import { log, warn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { readPlanFile, resolvePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import {
  buildExecutorAndLog,
  ClaudeCodeExecutorName,
  DEFAULT_EXECUTOR,
} from '../executors/index.js';
import type { Executor, ExecutorOutput } from '../executors/types.js';
import type { RmplanConfig } from '../configSchema.js';
import { getGitRoot } from '../../common/git.js';
import type { ExecutorCommonOptions } from '../executors/types.js';

const COMPLETED_STATUSES = new Set(['done', 'cancelled', 'deferred']);
const DEFAULT_MINIMUM_AGE_DAYS = 30;

interface CompactCommandOptions {
  executor?: string;
  model?: string;
  age?: number;
}

interface CompactionSectionToggles {
  details?: boolean;
  research?: boolean;
  progressNotes?: boolean;
}

interface CompactPlanArgs {
  plan: PlanSchema;
  planFilePath: string;
  executor: Executor;
  executorName: string;
  config: RmplanConfig;
  minimumAgeDays: number;
}

export async function handleCompactCommand(
  planArg: string | undefined,
  options: CompactCommandOptions,
  command: Command
) {
  if (!planArg) {
    throw new Error('A plan identifier (ID or path) is required for compaction.');
  }

  const globalOptions = command.parent?.opts?.() ?? {};
  const config = await loadEffectiveConfig(globalOptions.config);
  const resolvedPlanFile = await resolvePlanFile(planArg, globalOptions.config);

  const plan = await readPlanFile(resolvedPlanFile);

  if (!COMPLETED_STATUSES.has(plan.status)) {
    throw new Error(
      `Plan ${plan.id ?? planArg} has status "${plan.status}". Only done, cancelled, or deferred plans can be compacted.`
    );
  }

  const minimumAgeDays =
    options.age ??
    config.compaction?.minimumAgeDays ??
    (config as any)?.compaction?.minimumAgeDays ??
    DEFAULT_MINIMUM_AGE_DAYS;

  if (plan.updatedAt) {
    const updatedAt = new Date(plan.updatedAt);
    if (!Number.isNaN(updatedAt.valueOf())) {
      const ageDays = (Date.now() - updatedAt.valueOf()) / (1000 * 60 * 60 * 24);
      if (ageDays < minimumAgeDays) {
        warn(
          chalk.yellow(
            `Plan ${plan.id ?? planArg} was updated ${ageDays.toFixed(
              1
            )} days ago (threshold ${minimumAgeDays}). Consider waiting before compacting.`
          )
        );
      }
    }
  }

  const executorName =
    options.executor ??
    config.compaction?.defaultExecutor ??
    (config as any)?.compaction?.defaultExecutor ??
    config.defaultExecutor ??
    ClaudeCodeExecutorName ??
    DEFAULT_EXECUTOR;

  const gitRoot = await getGitRoot();
  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: gitRoot,
    model:
      options.model ??
      config.compaction?.defaultModel ??
      (config as any)?.compaction?.defaultModel ??
      undefined,
    interactive: false,
  };

  const executor = buildExecutorAndLog(executorName, sharedExecutorOptions, config);

  log(chalk.cyan(`\nStarting compaction of plan ${plan.id ?? planArg}...`));

  await compactPlan({
    plan,
    planFilePath: resolvedPlanFile,
    executor,
    executorName,
    config,
    minimumAgeDays,
  });

  log(chalk.green(`✓ Compaction of plan ${plan.id ?? planArg} completed.`));
}

export async function compactPlan(args: CompactPlanArgs): Promise<void> {
  const { plan, executor, config, planFilePath, minimumAgeDays } = args;

  const originalFileContent = await Bun.file(planFilePath).text();
  const sectionToggles = config.compaction?.sections ?? {};

  const prompt = generateCompactionPrompt(
    plan,
    planFilePath,
    originalFileContent,
    minimumAgeDays,
    sectionToggles
  );

  await runCompactionPrompt(executor, prompt, plan, planFilePath);
}

export function generateCompactionPrompt(
  plan: PlanSchema,
  planFilePath: string,
  planFileContent: string,
  minimumAgeDays: number,
  sectionToggles?: CompactionSectionToggles
): string {
  const planId = plan.id ?? 'unknown';
  const tasks = Array.isArray(plan.tasks)
    ? plan.tasks
        .map(
          (task, index) =>
            `${index + 1}. ${task.title}${task.done ? ' (done)' : ''}\n   ${task.description.trim()}`
        )
        .join('\n')
    : 'No tasks listed.';

  const applyDetails = sectionToggles?.details ?? true;
  const applyResearch = sectionToggles?.research ?? true;
  const applyProgressNotes = sectionToggles?.progressNotes ?? false;

  const sectionsToCompact = [];
  if (applyDetails) sectionsToCompact.push('generated details (content between delimiters)');
  if (applyResearch) sectionsToCompact.push('research section');
  if (applyProgressNotes) sectionsToCompact.push('progress notes');

  return [
    'You are an expert technical editor assisting with archiving completed engineering plans by compacting them for long-term storage.',
    `Plan ID: ${planId}`,
    `Plan Title: ${plan.title ?? 'Untitled'}`,
    `Current Status: ${plan.status}`,
    `Minimum age threshold: ${minimumAgeDays} days`,
    '',
    'YOUR TASK:',
    `Read the plan file at: ${planFilePath}`,
    'Compact the plan by editing the file directly using the Read and Edit tools.',
    '',
    `Sections to compact: ${sectionsToCompact.join(', ')}`,
    '',
    'Preserve (must remain explicit and factual):',
    '- Information about the original intentions of the plan',
    '- Original goal and final outcome or current disposition.',
    '- Key technical decisions, trade-offs, and rationale that explain why the outcome was chosen.',
    '- Acceptance criteria results or validation evidence proving completion.',
    '- Implementation or rollout approach at a high level.',
    '',
    'Compress or omit when redundant:',
    '- Exploratory research steps, dead-ends, brainstorming transcripts, and verbose progress logs.',
    '- Research findings not directly relevant to the implementation or decisions made.',
    '- Inline status updates already implied by the outcome.',
    '- Duplicate explanations that do not change the final understanding.',
    '',
    'Critical instructions:',
    '- Do not invent or hallucinate new work. Pull only from the provided plan text.',
    '- Focus foremost on what was done and why',
    '- Maintain chronological clarity where helpful, but keep prose succinct.',
    '- Prefer bullet lists with hyphen markers and wrap lines at roughly 120 characters.',
    '',
    'Editing guidelines:',
    applyDetails
      ? '- Generated details: Replace content BETWEEN the HTML comment delimiters (<!-- rmplan-generated-start --> and <!-- rmplan-generated-end -->). You may remove the delimiters.'
      : '- Generated details: Do NOT modify (disabled by configuration)',
    applyResearch
      ? '- Research section: Find and replace the "## Research" section that appears OUTSIDE the generated delimiters. If no Research section exists, that is ok.'
      : '- Research section: Do NOT modify (disabled by configuration)',
    applyProgressNotes
      ? '- Progress notes: Replace the entire progressNotes array in the YAML frontmatter with a single entry containing a compaction summary. Use timestamp: current ISO timestamp, source: "rmplan compact", text: "Compaction summary:\\n<your summary>"'
      : '- Progress notes: Do NOT modify (disabled by configuration)',
    '',
    'Structure of a well-compacted generated details section (if enabled):',
    '```markdown',
    '## Summary',
    '- Concise recap of the plan goal, scope, final outcome/results',
    '## Decisions',
    '- Bulleted list capturing critical technical decisions and rationale',
    '```',
    '',
    'Example of a well-compacted generated section (illustrative only—never reuse its content):',
    '```markdown',
    '## Summary',
    '- Migrated analytics ingestion to the v2 pipeline, eliminating nightly backlogs.',
    '## Decisions',
    '- Selected batched writes over streaming to keep within API quotas.',
    '- Documented schema diffs for downstream teams in /docs/analytics-migration.md.',
    '```',
    '',
    'Example of a well-compacted research section (if enabled):',
    '```markdown',
    '## Research',
    '- Benchmarks showed 35% faster ETL when skipping legacy normalization (directly informed implementation choice).',
    '```',
    '',
    'Research section guidelines (if enabled):',
    '- Only include findings that directly influenced the implementation, decisions, or outcome',
    '- Omit exploratory research, alternative approaches not taken, and background information',
    '- Each bullet should clearly connect to what was actually done in the plan',
    '',
    'Example of a compacted progress notes entry (if enabled):',
    '```yaml',
    'progressNotes:',
    '  - timestamp: 2024-03-20T10:30:00.000Z',
    '    source: rmplan compact',
    '    text: |',
    '      Compaction summary:',
    '      - Validated new pipeline with staging data set 2024-03-18.',
    '      - Deployed to production and monitored 48h with no regressions.',
    '```',
    '',
    'IMPORTANT: You MUST NOT modify any of the following fields in the YAML frontmatter:',
    '- id, uuid, title, goal, status',
    '- tasks array',
    '- dependencies, parent, references',
    '',
    'Plan tasks for context:',
    tasks,
    '',
    'Current plan file content:',
    '---',
    planFileContent.trim(),
    '---',
    '',
    'Now read the plan file and compact it by editing directly.',
  ].join('\n');
}

async function runCompactionPrompt(
  executor: Executor,
  prompt: string,
  plan: PlanSchema,
  planFilePath: string
): Promise<void> {
  const executionResult = await executor.execute(prompt, {
    planId: plan.id?.toString() ?? 'unknown',
    planTitle: plan.title ?? 'Untitled Plan',
    planFilePath,
    captureOutput: 'none',
    executionMode: 'planning',
  });

  const normalized = executionResult as unknown;

  // Check if executor reported failure
  if (normalized && typeof normalized === 'object') {
    const structured = normalized as ExecutorOutput;
    if (structured.success === false) {
      const reason =
        structured.failureDetails?.problems ??
        structured.failureDetails?.requirements ??
        'Executor reported failure without details.';
      throw new Error(`Compaction executor failed: ${reason}`);
    }
  }
}
