import { Command } from 'commander';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import yaml from 'yaml';
import { log, warn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { readPlanFile, resolvePlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { phaseSchema } from '../planSchema.js';
import { mergeDetails, GENERATED_START_DELIMITER, GENERATED_END_DELIMITER } from '../plan_merge.js';
import {
  buildExecutorAndLog,
  ClaudeCodeExecutorName,
  DEFAULT_EXECUTOR,
} from '../executors/index.js';
import type { Executor, ExecutorOutput } from '../executors/types.js';
import type { RmplanConfig } from '../configSchema.js';
import { getGitRoot } from '../../common/git.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { fixYaml } from '../fix_yaml.js';

const COMPLETED_STATUSES = new Set(['done', 'cancelled', 'deferred']);
const DEFAULT_MINIMUM_AGE_DAYS = 30;

interface CompactCommandOptions {
  executor?: string;
  model?: string;
  dryRun?: boolean;
  age?: number;
  yes?: boolean;
}

interface CompactionSections {
  detailsMarkdown: string;
  researchMarkdown?: string | null;
  progressNotesSummary?: string | null;
}

interface CompactionSectionToggles {
  details?: boolean;
  research?: boolean;
  progressNotes?: boolean;
}

interface SectionMetrics {
  originalGeneratedLength: number;
  compactedGeneratedLength: number;
  originalResearchLength: number;
  compactedResearchLength: number;
  originalProgressNotesCount: number;
  compactedProgressNotesCount: number;
}

interface CompactionStats {
  originalBytes: number;
  compactedBytes: number;
}

interface CompactionArtifacts {
  prompt: string;
  executorOutput: string;
  sections: CompactionSections;
  metrics: SectionMetrics;
  stats: CompactionStats;
}

interface CompactionValidationResult {
  plan: PlanSchema;
  issues: string[];
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

  const compactionResult = await compactPlan({
    plan,
    planFilePath: resolvedPlanFile,
    executor,
    executorName,
    config,
    minimumAgeDays,
  });

  if (options.dryRun) {
    reportDryRun(compactionResult);
    return;
  }

  if (process.stdout.isTTY && !options.yes) {
    const confirmed = await confirm({
      message: 'Write compacted plan back to disk?',
      default: true,
    });

    if (!confirmed) {
      log(chalk.yellow('Compaction aborted by user.'));
      return;
    }
  }

  await writePlanFile(resolvedPlanFile, compactionResult.plan);
  reportSuccessfulCompaction(plan, compactionResult);
}

export async function compactPlan(
  args: CompactPlanArgs
): Promise<CompactionArtifacts & { plan: PlanSchema }> {
  const { plan, executor, executorName, config, planFilePath } = args;
  const planClone: PlanSchema = structuredClone(plan);

  const originalFileContent = await Bun.file(planFilePath).text();
  const originalBytes = Buffer.byteLength(originalFileContent, 'utf8');

  const prompt = generateCompactionPrompt(planClone, originalFileContent, args.minimumAgeDays);
  const executorOutput = await runCompactionPrompt(executor, prompt, planClone, planFilePath);
  const compactionSections = await parseCompactionResponse(executorOutput, config);

  const sectionToggles = config.compaction?.sections;

  applyCompactionSections(
    planClone,
    compactionSections,
    executorName,
    originalBytes,
    sectionToggles
  );

  const validationResult = validateCompaction(plan, planClone);
  if (validationResult.issues.length > 0) {
    throw new Error(`Compacted plan failed validation:\n - ${validationResult.issues.join('\n - ')}`);
  }

  const validatedPlan = validationResult.plan;
  const serializedPlan = serializePlan(validatedPlan);
  const compactedBytes = Buffer.byteLength(serializedPlan, 'utf8');
  const metadataCarrier = validatedPlan as PlanSchema & Record<string, unknown>;
  if (metadataCarrier.compactedOriginalBytes === undefined) {
    metadataCarrier.compactedOriginalBytes = originalBytes;
  }
  metadataCarrier.compactedBytes = compactedBytes;
  metadataCarrier.compactedReductionBytes = originalBytes - compactedBytes;

  return {
    plan: validatedPlan,
    prompt,
    executorOutput,
    sections: compactionSections,
    stats: {
      originalBytes,
      compactedBytes,
    },
    metrics: calculateMetrics(plan, validatedPlan, compactionSections),
  };
}

function reportDryRun(result: CompactionArtifacts & { plan: PlanSchema }) {
  const { stats, sections, metrics } = result;
  const reduction = stats.originalBytes - stats.compactedBytes;
  const reductionPercent = stats.originalBytes > 0 ? (reduction / stats.originalBytes) * 100 : 0;

  log(chalk.cyan('\nDry Run: Plan compaction summary'));
  log(`Original size: ${stats.originalBytes} bytes`);
  log(
    `Compacted size: ${stats.compactedBytes} bytes (${reduction >= 0 ? '-' : '+'}${Math.abs(reduction)} bytes, ${reductionPercent.toFixed(1)}%)`
  );
  log('\nGenerated details preview:\n');
  log(sections.detailsMarkdown.trim() ? sections.detailsMarkdown.trim() : '(empty)');

  if (sections.researchMarkdown) {
    log('\nCompacted research section:\n');
    log(sections.researchMarkdown.trim());
  }

  if (sections.progressNotesSummary) {
    log('\nProgress notes summary:\n');
    log(sections.progressNotesSummary.trim());
  }

  log('\nSection metrics:');
  log(
    `Generated details length: ${metrics.originalGeneratedLength} -> ${metrics.compactedGeneratedLength}`
  );
  log(`Research length: ${metrics.originalResearchLength} -> ${metrics.compactedResearchLength}`);
  log(
    `Progress notes: ${metrics.originalProgressNotesCount} -> ${metrics.compactedProgressNotesCount}`
  );
}

function reportSuccessfulCompaction(
  originalPlan: PlanSchema,
  result: CompactionArtifacts & { plan: PlanSchema }
) {
  const { stats } = result;
  const reduction = stats.originalBytes - stats.compactedBytes;
  const reductionPercent = stats.originalBytes > 0 ? (reduction / stats.originalBytes) * 100 : 0;

  const planId = originalPlan.id ?? 'unknown';
  log(
    chalk.green(
      `✓ Compacted plan ${planId}. Size reduced by ${Math.max(
        0,
        reduction
      )} bytes (${reductionPercent.toFixed(1)}%).`
    )
  );
}

export function generateCompactionPrompt(
  plan: PlanSchema,
  planFileContent: string,
  minimumAgeDays: number
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

  return [
    'You are an expert technical editor assisting with archiving completed engineering plans by compacting them for long-term storage.',
    `Plan ID: ${planId}`,
    `Plan Title: ${plan.title ?? 'Untitled'}`,
    `Current Status: ${plan.status}`,
    `Minimum age threshold: ${minimumAgeDays} days`,
    '',
    'Preserve (must remain explicit and factual):',
    '- Original goal and final outcome or current disposition.',
    '- Key technical decisions, trade-offs, and rationale that explain why the outcome was chosen.',
    '- Acceptance criteria results or validation evidence proving completion.',
    '- Implementation or rollout approach at a high level.',
    '',
    'Compress or omit when redundant:',
    '- Exploratory research steps, dead-ends, brainstorming transcripts, and verbose progress logs.',
    '- Inline status updates already implied by the outcome.',
    '- Duplicate explanations that do not change the final understanding.',
    '',
    'Critical instructions:',
    '- Do not invent or hallucinate new work. Pull only from the provided plan text.',
    '- Maintain chronological clarity where helpful, but keep prose succinct.',
    '- Respect existing Markdown delimiters and do not introduce HTML comments.',
    '- Prefer bullet lists with hyphen markers and wrap lines at roughly 120 characters.',
    '',
    'Output format (YAML only, no prose outside this block):',
    '```yaml',
    'details_markdown: |',
    '  ## Summary',
    '  - <Concise recap of the plan goal, scope, final outcome/results>',
    '  ## Decisions',
    '  - <Bulleted list capturing critical technical decisions and rationale>',
    'research_markdown: |',
    '  - <Distilled research findings that explain why the chosen solution worked>',
    'progress_notes_summary: |',
    '  - <Chronological highlights showing how acceptance criteria were satisfied>',
    '```',
    '',
    'Example of a well-compacted output (illustrative only—never reuse its content):',
    '```yaml',
    'details_markdown: |',
    '  ## Summary',
    '  - Migrated analytics ingestion to the v2 pipeline, eliminating nightly backlogs.',
    '  ## Decisions',
    '  - Selected batched writes over streaming to keep within API quotas.',
    '  - Documented schema diffs for downstream teams in /docs/analytics-migration.md.',
    'research_markdown: |',
    '  - Benchmarks showed 35% faster ETL when skipping legacy normalization.',
    'progress_notes_summary: |',
    '  - Validated new pipeline with staging data set 2024-03-18.',
    '  - Deployed to production and monitored 48h with no regressions.',
    '```',
    '',
    'If a section has nothing meaningful to retain, still provide the key with a short statement such as "None" or "Not applicable".',
    '',
    'Plan tasks for context:',
    tasks,
    '',
    'Full plan file:',
    '---',
    planFileContent.trim(),
    '---',
  ].join('\n');
}

async function runCompactionPrompt(
  executor: Executor,
  prompt: string,
  plan: PlanSchema,
  planFilePath: string
): Promise<string> {
  const executionResult = await executor.execute(prompt, {
    planId: plan.id?.toString() ?? 'unknown',
    planTitle: plan.title ?? 'Untitled Plan',
    planFilePath,
    captureOutput: 'result',
    executionMode: 'planning',
  });

  if (!executionResult) {
    throw new Error(
      'Executor did not return any output. Compaction requires the result block from the executor.'
    );
  }

  const normalized = executionResult as unknown;

  if (typeof normalized === 'string') {
    return normalized.trim();
  }

  const structured = normalized as ExecutorOutput;

  if (structured.success === false) {
    const reason =
      structured.failureDetails?.problems ??
      structured.failureDetails?.requirements ??
      'Executor reported failure without details.';
    throw new Error(`Compaction executor failed: ${reason}`);
  }

  const content = structured.content?.toString().trim();
  if (content) {
    return content;
  }

  throw new Error('Executor response did not include compacted content.');
}

async function parseCompactionResponse(
  rawOutput: string,
  config: RmplanConfig
): Promise<CompactionSections> {
  const sanitized = stripMarkdownFence(rawOutput);
  let parsed: any;

  try {
    parsed = yaml.parse(sanitized, { strict: false });
  } catch {
    const fixed = await fixYaml(sanitized, 3, config);
    parsed = fixed;
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Compaction response did not contain a valid YAML object.');
  }

  const details = (parsed.details_markdown ?? parsed.detailsMarkdown ?? '').toString().trim();
  const research = parsed.research_markdown ?? parsed.researchMarkdown;
  const progress = parsed.progress_notes_summary ?? parsed.progressNotesSummary;

  if (!details) {
    throw new Error('Compaction response omitted details_markdown content.');
  }

  return {
    detailsMarkdown: details,
    researchMarkdown: typeof research === 'string' ? research.trim() : undefined,
    progressNotesSummary: typeof progress === 'string' ? progress.trim() : undefined,
  };
}

function stripMarkdownFence(output: string): string {
  const trimmed = output.trim();
  if (trimmed.startsWith('```')) {
    const firstLineBreak = trimmed.indexOf('\n');
    if (firstLineBreak === -1) {
      return trimmed.replace(/```/g, '').trim();
    }
    const fenceLanguage = trimmed.slice(0, firstLineBreak).trim();
    const withoutFence = trimmed.slice(firstLineBreak + 1);
    if (fenceLanguage.startsWith('```')) {
      const closingIndex = withoutFence.lastIndexOf('```');
      if (closingIndex !== -1) {
        return withoutFence.slice(0, closingIndex).trim();
      }
    }
  }
  return trimmed;
}

function applyCompactionSections(
  plan: PlanSchema,
  sections: CompactionSections,
  executorName: string,
  originalBytes: number,
  sectionToggles?: CompactionSectionToggles
) {
  const applyDetails = sectionToggles?.details ?? true;
  const applyResearch = sectionToggles?.research ?? true;
  const applyProgressNotes = sectionToggles?.progressNotes ?? true;

  const mergedDetails = applyDetails
    ? mergeDetails(sections.detailsMarkdown, plan.details)
    : plan.details;

  if (applyResearch) {
    plan.details = updateResearchSection(mergedDetails, sections.researchMarkdown);
  } else if (applyDetails) {
    plan.details = mergedDetails;
  }

  if (applyProgressNotes) {
    const progressSummary = sections.progressNotesSummary
      ? `Compaction summary:\n${sections.progressNotesSummary.trim()}`
      : 'Compaction performed with no additional progress notes provided by the executor.';

    plan.progressNotes = [
      {
        timestamp: new Date().toISOString(),
        text: progressSummary,
        source: 'rmplan compact',
      },
    ];
  }

  const metadataCarrier = plan as PlanSchema & Record<string, unknown>;
  metadataCarrier.compactedAt = new Date().toISOString();
  metadataCarrier.compactedBy = executorName;
  metadataCarrier.compactedOriginalBytes = originalBytes;
}

function updateResearchSection(
  details: string | undefined,
  researchMarkdown?: string | null
): string | undefined {
  if (!details) {
    if (!researchMarkdown) {
      return details;
    }
    return `## Research\n\n${researchMarkdown.trim()}`;
  }

  if (!researchMarkdown) {
    return details;
  }

  const trimmedResearch = researchMarkdown.trim();
  const lines = details.split('\n');
  let startIndex = -1;
  let insideGenerated = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmedLine = lines[i].trim();

    if (trimmedLine === GENERATED_START_DELIMITER) {
      insideGenerated = true;
      continue;
    }

    if (trimmedLine === GENERATED_END_DELIMITER) {
      insideGenerated = false;
      continue;
    }

    if (!insideGenerated && trimmedLine.toLowerCase() === '## research') {
      startIndex = i;
      break;
    }
  }

  if (startIndex === -1) {
    const trimmedDetails = details.trimEnd();
    const separator = trimmedDetails ? '\n\n' : '';
    return `${trimmedDetails}${separator}## Research\n\n${trimmedResearch}`.trimEnd();
  }

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line) && line.trim().toLowerCase() !== '## research') {
      endIndex = i;
      break;
    }
  }

  const prefix = lines.slice(0, startIndex).join('\n').trimEnd();
  const suffix = lines.slice(endIndex).join('\n').trim();
  const researchBlock = `## Research\n\n${trimmedResearch}`;

  const pieces = [];
  if (prefix) pieces.push(prefix);
  pieces.push(researchBlock);
  if (suffix) pieces.push(suffix);

  const result = pieces.join('\n\n').trimEnd();
  return result ? `${result}\n` : result;
}

export function validateCompaction(
  originalPlan: PlanSchema,
  compactedPlan: PlanSchema
): CompactionValidationResult {
  const issues: string[] = [];

  const parsed = phaseSchema.safeParse(compactedPlan);
  if (!parsed.success) {
    parsed.error.issues.forEach((issue) =>
      issues.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`)
    );
  }

  const normalizedPlan = parsed.success ? parsed.data : compactedPlan;

  const requiredFields: Array<keyof PlanSchema> = ['id', 'uuid', 'title', 'goal', 'status', 'tasks'];
  for (const field of requiredFields) {
    if (normalizedPlan[field] === undefined) {
      issues.push(`Required field "${String(field)}" is missing after compaction.`);
    }
  }

  const invariantFields: Array<keyof PlanSchema> = [
    'id',
    'uuid',
    'title',
    'goal',
    'status',
    'dependencies',
    'parent',
    'references',
    'tasks',
  ];

  for (const field of invariantFields) {
    const beforeValue = originalPlan[field];
    const afterValue = normalizedPlan[field];
    if (field === 'tasks' || field === 'dependencies' || field === 'references') {
      if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
        issues.push(`Field "${String(field)}" was modified during compaction.`);
      }
    } else if (
      beforeValue !== undefined &&
      afterValue !== undefined &&
      JSON.stringify(beforeValue) !== JSON.stringify(afterValue)
    ) {
      issues.push(`Field "${String(field)}" changed from "${beforeValue}" to "${afterValue}".`);
    }
  }

  if (typeof normalizedPlan.details !== 'string' && normalizedPlan.details !== undefined) {
    issues.push('Details section must remain a string.');
  }

  try {
    const serialized = serializePlan(normalizedPlan);
    if (serialized.length === 0) {
      issues.push('Serialized plan content is empty after compaction.');
    }
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(serialized)) {
      issues.push('Serialized plan contains non-printable control characters.');
    }
  } catch (error) {
    issues.push(`Failed to serialize compacted plan: ${(error as Error).message}`);
  }

  return {
    plan: normalizedPlan,
    issues,
  };
}

function serializePlan(plan: PlanSchema): string {
  const schemaLine =
    '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json';
  const { details, ...planWithoutDetails } = plan;
  const yamlContent = yaml.stringify(planWithoutDetails);

  let content = '---\n';
  content += `${schemaLine}\n`;
  content += yamlContent;
  content += '---\n';

  if (details) {
    content += `\n${details.trimEnd()}`;
    if (!details.endsWith('\n')) {
      content += '\n';
    }
  }

  return content;
}

function calculateMetrics(
  originalPlan: PlanSchema,
  compactedPlan: PlanSchema,
  sections: CompactionSections
): SectionMetrics {
  return {
    originalGeneratedLength: extractGeneratedContent(originalPlan.details).length,
    compactedGeneratedLength: sections.detailsMarkdown.length,
    originalResearchLength: extractResearchContent(originalPlan.details).length,
    compactedResearchLength: sections.researchMarkdown?.length ?? 0,
    originalProgressNotesCount: Array.isArray(originalPlan.progressNotes)
      ? originalPlan.progressNotes.length
      : 0,
    compactedProgressNotesCount: Array.isArray(compactedPlan.progressNotes)
      ? compactedPlan.progressNotes.length
      : 0,
  };
}

function extractGeneratedContent(details: string | undefined): string {
  if (!details) {
    return '';
  }

  const startIndex = details.indexOf(GENERATED_START_DELIMITER);
  const endIndex = details.indexOf(GENERATED_END_DELIMITER);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    return details.slice(startIndex + GENERATED_START_DELIMITER.length, endIndex).trim();
  }

  return details.trim();
}

function extractResearchContent(details: string | undefined): string {
  if (!details) {
    return '';
  }

  const lines = details.split('\n');
  const startIndex = lines.findIndex((line) => line.trim().toLowerCase() === '## research');
  if (startIndex === -1) {
    return '';
  }

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      endIndex = i;
      break;
    }
  }

  return lines
    .slice(startIndex + 1, endIndex)
    .join('\n')
    .trim();
}
