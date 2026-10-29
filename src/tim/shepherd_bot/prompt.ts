import type { Database } from 'bun:sqlite';
import * as z from 'zod';

import { parseOwnerRepoFromRepositoryId } from '../../common/github/pull_requests.js';
import { getEffectiveReviewDecision } from '../../common/github/review_requests.js';
import { classifyCheckRun } from '../../common/github/required_check_rollup.js';
import { evaluatePrShepherd, PR_SHEPHERD_STATUS_LABELS } from '../../lib/utils/pr_shepherd.js';
import { listJobsForPrUrls, type JobRow } from '../db/job.js';
import { getActivePrShepherdsByPrStatusIds } from '../db/pr_shepherd.js';
import { getProjectById } from '../db/project.js';
import {
  listRecentShepherdBotActions,
  type ShepherdBotActionRow,
  type ShepherdBotTriggerRow,
} from '../db/shepherd_bot.js';
import type { ShepherdBotState, ShepherdBotStatePaths } from './settings.js';
import { loadOpenStacksForRepo, type StackPr } from './stack.js';

const RECENT_ACTION_LIMIT = 25;
const RECENT_JOB_LIMIT = 40;
const RECENT_JOB_WINDOW_MS = 48 * 60 * 60 * 1000;
const THREAD_COMMENT_PREVIEW_CHARS = 300;
const MAX_THREADS_PER_PR = 10;

export interface ShepherdBotStackEntry {
  pr: StackPr;
  depth: number;
  botEnabled: boolean;
}

export interface ShepherdBotContext {
  projectId: number;
  repository: string;
  triggers: ShepherdBotTriggerRow[];
  stacks: ShepherdBotStackEntry[][];
  actions: ShepherdBotActionRow[];
  jobs: JobRow[];
}

/** Load everything the bot needs to know from the DB. */
export function loadShepherdBotContext(
  db: Database,
  projectId: number,
  triggers: ShepherdBotTriggerRow[],
  now: Date = new Date()
): ShepherdBotContext {
  const project = getProjectById(db, projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }
  const ownerRepo = parseOwnerRepoFromRepositoryId(project.repository_id);
  if (!ownerRepo) {
    throw new Error(`Project ${projectId} is not a GitHub repository`);
  }

  const groups = loadOpenStacksForRepo(db, ownerRepo.owner, ownerRepo.repo);
  const shepherds = getActivePrShepherdsByPrStatusIds(
    db,
    groups.flatMap((group) => group.map((entry) => entry.pr.status.id))
  );
  const stacks = groups
    .map((group) =>
      group.map((entry) => ({
        pr: entry.pr,
        depth: entry.depth,
        botEnabled: shepherds.get(entry.pr.status.id)?.bot_enabled_at != null,
      }))
    )
    .filter((group) => group.some((entry) => entry.botEnabled));

  const prUrls = stacks.flatMap((group) => group.map((entry) => entry.pr.status.pr_url));
  const triggerUrls = triggers.flatMap((trigger) => (trigger.pr_url ? [trigger.pr_url] : []));
  const jobs = listJobsForPrUrls(
    db,
    [...new Set([...prUrls, ...triggerUrls])],
    new Date(now.getTime() - RECENT_JOB_WINDOW_MS).toISOString(),
    RECENT_JOB_LIMIT
  );

  return {
    projectId,
    repository: `${ownerRepo.owner}/${ownerRepo.repo}`,
    triggers,
    stacks,
    actions: listRecentShepherdBotActions(db, projectId, RECENT_ACTION_LIMIT),
    jobs,
  };
}

// ---------------------------------------------------------------------------
// Output

const prNumberSchema = z.number().int().positive();

export const shepherdBotActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ci_fix'), pr: prNumberSchema, reason: z.string() }),
  z.object({ type: z.literal('pr_fix'), pr: prNumberSchema, reason: z.string() }),
  z.object({ type: z.literal('pr_rebase'), pr: prNumberSchema, reason: z.string() }),
  z.object({ type: z.literal('notify'), pr: prNumberSchema, message: z.string().min(1) }),
  z.object({
    type: z.literal('recheck'),
    afterMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
    reason: z.string(),
  }),
]);

export type ShepherdBotAction = z.infer<typeof shepherdBotActionSchema>;

export const shepherdBotOutputSchema = z.object({
  summary: z.string(),
  stateMarkdown: z.string(),
  stateJson: z.record(z.string(), z.unknown()),
  actions: z.array(shepherdBotActionSchema),
});

export type ShepherdBotOutput = z.infer<typeof shepherdBotOutputSchema>;

function extractJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) =>
    match[1].trim()
  );
  candidates.push(...fenced.reverse());
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }
  return candidates;
}

/** Parse the bot's final message. Throws when no valid output object is found. */
export function parseShepherdBotOutput(text: string): ShepherdBotOutput {
  let lastError: unknown = null;
  for (const candidate of extractJsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (err) {
      lastError = err;
      continue;
    }
    const result = shepherdBotOutputSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    lastError = result.error;
  }
  throw new Error(
    `The shepherd bot did not return a valid output object: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

// ---------------------------------------------------------------------------
// Prompt

function formatTrigger(trigger: ShepherdBotTriggerRow, stacks: ShepherdBotStackEntry[][]): string {
  const prNumber = trigger.pr_url ? trigger.pr_url.split('/').at(-1) : null;
  const label = prNumber ? `PR #${prNumber}` : 'all stacks';
  let details: Record<string, unknown> = {};
  try {
    details = trigger.details ? (JSON.parse(trigger.details) as Record<string, unknown>) : {};
  } catch {
    details = {};
  }

  switch (trigger.kind) {
    case 'pr_changed': {
      const changes = Array.isArray(details.changes) ? (details.changes as string[]) : [];
      return `- ${trigger.created_at} ${label} changed:\n${changes.map((change) => `  - ${change}`).join('\n')}`;
    }
    case 'session_ended':
      return `- ${trigger.created_at} A \`${String(details.command)}\` session for ${label} ended (outcome: ${String(details.outcome)}).`;
    case 'recheck':
      return `- ${trigger.created_at} You asked to check again: ${typeof details.reason === 'string' ? details.reason : ''}`;
    case 'bot_started': {
      const prCount = stacks.reduce(
        (count, group) => count + group.filter((entry) => entry.botEnabled).length,
        0
      );
      return `- ${trigger.created_at} The user started the bot. Review all ${prCount} watched PRs. Changes that happened while the bot was stopped are not listed separately.`;
    }
    case 'prs_added': {
      const numbers = Array.isArray(details.prNumbers) ? (details.prNumbers as number[]) : [];
      return `- ${trigger.created_at} The user added PRs to the bot: ${numbers.map((n) => `#${n}`).join(', ')}.`;
    }
    default:
      return `- ${trigger.created_at} ${String(trigger.kind)} for ${label}`;
  }
}

function truncate(text: string, maxChars: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > maxChars ? `${singleLine.slice(0, maxChars)}...` : singleLine;
}

function formatPr(entry: ShepherdBotStackEntry, runningJobs: JobRow[]): string {
  const { pr } = entry;
  const { status } = pr;
  const evaluation = evaluatePrShepherd(pr);
  const failingChecks = [
    ...new Set(
      pr.checks.filter((check) => classifyCheckRun(check) === 'failing').map((c) => c.name)
    ),
  ];
  const pendingChecks = pr.checks.filter((check) => classifyCheckRun(check) === 'pending').length;
  const unresolved = (pr.reviewThreads ?? []).filter((thread) => !thread.thread.is_resolved);

  const lines = [`${'  '.repeat(entry.depth)}- #${status.pr_number} ${status.title ?? 'Untitled'}`];
  const indent = '  '.repeat(entry.depth + 1);
  const field = (text: string): void => {
    lines.push(`${indent}- ${text}`);
  };
  field(`Watched by the bot: ${entry.botEnabled ? 'yes' : 'no (do not act on this PR)'}`);
  field(`Branch: \`${status.head_branch ?? '?'}\` -> \`${status.base_branch ?? '?'}\``);
  field(`Head SHA: ${status.head_sha ?? 'unknown'}${status.draft ? ' (draft)' : ''}`);
  field(
    `Status: ${PR_SHEPHERD_STATUS_LABELS[evaluation.status]}${
      evaluation.attention.length > 0
        ? ` (${evaluation.attention.map((item) => item.label).join('; ')})`
        : ''
    }`
  );
  field(
    `Checks: ${status.check_rollup_state ?? 'none'}${
      failingChecks.length > 0 ? `; failing: ${failingChecks.join(', ')}` : ''
    }${pendingChecks > 0 ? `; ${pendingChecks} still running` : ''}`
  );
  field(`Mergeable: ${status.mergeable ?? 'unknown'}`);
  field(`Review decision: ${getEffectiveReviewDecision(pr) ?? 'none'}`);
  if (status.merge_queue_enqueued_at) {
    field(`In the merge queue since ${status.merge_queue_enqueued_at}`);
  }
  for (const job of runningJobs) {
    field(`A \`${job.job_type}\` session is reported as running since ${job.started_at}`);
  }
  if (unresolved.length > 0) {
    field(`Unresolved review threads: ${unresolved.length}`);
    for (const thread of unresolved.slice(0, MAX_THREADS_PER_PR)) {
      const first = thread.comments[0];
      const location = `${thread.thread.path}${thread.thread.line ? `:${thread.thread.line}` : ''}`;
      lines.push(
        `${indent}  - ${location} (${first?.author ?? 'unknown'}, ${thread.comments.length} comment${
          thread.comments.length === 1 ? '' : 's'
        }): ${truncate(first?.body ?? '', THREAD_COMMENT_PREVIEW_CHARS)}`
      );
    }
    if (unresolved.length > MAX_THREADS_PER_PR) {
      lines.push(`${indent}  - ...and ${unresolved.length - MAX_THREADS_PER_PR} more`);
    }
  }
  return lines.join('\n');
}

function formatAction(action: ShepherdBotActionRow): string {
  const target = action.pr_number ? ` #${action.pr_number}` : '';
  const sha = action.head_sha ? ` at ${action.head_sha.slice(0, 8)}` : '';
  const result = action.result ? ` -- ${action.result}` : '';
  const reason = action.reason ? ` (reason: ${truncate(action.reason, 200)})` : '';
  return `- ${action.created_at} ${action.kind}${target}${sha}: ${action.status}${result}${reason}`;
}

function formatJob(job: JobRow): string {
  const end = job.finished_at ? `, finished ${job.finished_at}` : '';
  return `- #${job.pr_number ?? '?'} \`${job.job_type}\`: ${job.status}, started ${job.started_at}${end}`;
}

export function buildShepherdBotPrompt(
  context: ShepherdBotContext,
  state: ShepherdBotState,
  paths: ShepherdBotStatePaths
): string {
  const runningJobsByUrl = new Map<string, JobRow[]>();
  for (const job of context.jobs) {
    if (job.status === 'running' && job.pr_url) {
      const list = runningJobsByUrl.get(job.pr_url) ?? [];
      list.push(job);
      runningJobsByUrl.set(job.pr_url, list);
    }
  }

  const stacksText =
    context.stacks.length === 0
      ? 'No open PRs are watched by the bot now.'
      : context.stacks
          .map((group, index) => {
            const header =
              group.length > 1
                ? `### Stack ${index + 1} (root first)`
                : `### Single PR ${index + 1}`;
            return [
              header,
              ...group.map((entry) =>
                formatPr(entry, runningJobsByUrl.get(entry.pr.status.pr_url) ?? [])
              ),
            ].join('\n');
          })
          .join('\n\n');

  return `You are the PR shepherd bot for the GitHub repository ${context.repository}. You watch the user's open pull requests and start fix sessions so that the PRs get to a mergeable state. The user stays in control: your job is to remove routine work from them, not to push PRs through as fast as possible.

This is one short run. You do not wait for anything during the run. You read the state below, decide what to do, and return one JSON object. The system starts the sessions that you ask for, and wakes you again when something changes or when a session ends.

Do not change files in the repository, run git or jj commands, or push. Use only the information in this prompt. You may use read-only commands such as \`gh pr view\` or \`gh run view\` if you need more detail about a failure, but most of the time the information here is sufficient.

## What woke you up

${context.triggers.map((trigger) => formatTrigger(trigger, context.stacks)).join('\n') || '- Nothing specific. Review the current state.'}

## Watched stacks

Each stack is ordered from the PR nearest to the trunk to the tip. A PR's base branch is the head branch of the PR above it in the list.

${stacksText}

## Your recent actions

${context.actions.map(formatAction).join('\n') || 'None.'}

## Recent sessions for these PRs (last 48 hours, newest first)

${context.jobs.map(formatJob).join('\n') || 'None.'}

## Your saved state

Your state from the previous run follows. The files are at \`${paths.markdown}\` and \`${paths.json}\`, but you do not write them yourself: return the complete new contents in \`stateMarkdown\` and \`stateJson\`, and the system saves them. Keep the state short. Remove entries for PRs that merged or that are no longer watched.

### state.md

${state.markdown.trim() || '(empty)'}

### state.json

${state.json.trim() || '{}'}

## Available actions

- \`ci_fix\`: start a CI fix session for a PR with failing checks. The session reads the CI logs, fixes the code, and pushes.
- \`pr_fix\`: start a review-comment fix session for a PR with unresolved review threads. This session is interactive: it asks the user what to do about each comment, so the user always decides. The system notifies the user.
- \`pr_rebase\`: start a session that resolves merge conflicts with the base branch and pushes. The session also rebases and pushes the PRs stacked on top of that PR.
- \`notify\`: write a message to the user's inbox about a PR. Use this when a problem needs a human decision, when you stop retrying something, or when you see a problem that you cannot fix with the other actions.
- \`recheck\`: ask to be woken again after some minutes, for example to look again at checks that are still running. You are woken anyway when a watched PR changes or a session ends, so do not schedule a recheck only to wait for that.

## Rules

1. Act only on PRs that are watched by the bot. You can use the other PRs in a stack as context.
2. Work from the bottom of the stack up. A failure in a lower PR often causes the same failure in the PRs above it, because they contain its commits. When a lower PR has failing checks and a PR above it fails the same checks, fix only the lower PR and wait. After the lower PR is fixed, the PRs above it usually need a restack before their CI can pass. Restacking is not one of your actions, so tell the user with \`notify\` when PRs above a fixed PR need a restack.
3. Start at most one session for each stack. If a session for any PR in a stack is running, do not start another one in that stack. The system also rejects such actions.
4. Do not act while the checks that matter are still running, unless a check already failed and the failure is clear.
5. Do not start the same fix for the same head SHA more than twice. If a fix did not work twice, stop and \`notify\` the user. The system also enforces this limit.
6. Start \`pr_fix\` only for review threads that a previous \`pr_fix\` did not already handle. The system rejects a \`pr_fix\` for the same set of unresolved threads.
7. Never merge PRs or add them to the merge queue. Tell the user with \`notify\` when a stack is ready to merge, but only once for each stack state: use your saved state to remember what you already told the user.
8. Ignore PRs that are drafts, unless the user added them on purpose and they have a clear problem to fix.
9. If nothing needs to happen, return an empty \`actions\` array. That is a normal result.

## Output

Return only one JSON object, with no other text, in this format:

\`\`\`json
{
  "summary": "One or two sentences about what you saw and what you did.",
  "stateMarkdown": "The full new content of state.md.",
  "stateJson": {},
  "actions": [
    { "type": "ci_fix", "pr": 123, "reason": "Why this fix, and why now." },
    { "type": "pr_fix", "pr": 123, "reason": "..." },
    { "type": "pr_rebase", "pr": 123, "reason": "..." },
    { "type": "notify", "pr": 123, "message": "What the user should know or do." },
    { "type": "recheck", "afterMinutes": 15, "reason": "..." }
  ]
}
\`\`\`
`;
}
