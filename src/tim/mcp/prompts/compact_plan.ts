import { UserError } from 'fastmcp';
import type { GenerateModeRegistrationContext } from '../generate_mode.js';
import { resolvePlan } from '../../plan_display.js';
import { generateCompactionPrompt } from '../../commands/compact.js';
import { clearPlanCache } from '../../plans.js';

const COMPLETED_STATUSES = new Set(['done', 'cancelled', 'deferred']);
const DEFAULT_MINIMUM_AGE_DAYS = 30;

interface LoadCompactPlanArgs {
  plan: string;
}

export async function loadCompactPlanPrompt(
  args: LoadCompactPlanArgs,
  context: GenerateModeRegistrationContext
) {
  clearPlanCache();
  const planIdentifier = args.plan?.trim();
  if (!planIdentifier) {
    throw new UserError('Plan ID or file path is required to build a compaction prompt.');
  }

  const { plan, planPath } = await resolvePlan(planIdentifier, context);

  if (!COMPLETED_STATUSES.has(plan.status)) {
    const status = plan.status ?? 'unknown';
    const identifier = plan.id ?? planIdentifier;
    throw new UserError(
      `Plan ${identifier} has status "${status}". Only done, cancelled, or deferred plans can be compacted.`
    );
  }

  const minimumAgeDays =
    context.config.compaction?.minimumAgeDays ??
    (context.config as any)?.compaction?.minimumAgeDays ??
    DEFAULT_MINIMUM_AGE_DAYS;

  const sectionToggles = context.config.compaction?.sections ?? {};
  const planFileContent = await Bun.file(planPath).text();
  const basePrompt = generateCompactionPrompt(
    plan,
    planPath,
    planFileContent,
    minimumAgeDays,
    sectionToggles
  );

  const reminders: string[] = [];

  const ageWarning = buildAgeWarning(plan.updatedAt, minimumAgeDays);
  if (ageWarning) {
    reminders.push(ageWarning);
  }

  reminders.push(
    'After compacting the plan file, let your human collaborator know the compaction is complete.'
  );

  const reminderText = reminders.length > 0 ? `\n\n${reminders.join('\n')}` : '';

  return {
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `${basePrompt}${reminderText}`,
        },
      },
    ],
  };
}

function buildAgeWarning(updatedAt: string | undefined, minimumAgeDays: number): string | null {
  if (!updatedAt) {
    return null;
  }

  const parsed = new Date(updatedAt);
  if (Number.isNaN(parsed.valueOf())) {
    return null;
  }

  const ageDays = (Date.now() - parsed.valueOf()) / (1000 * 60 * 60 * 24);
  if (ageDays >= minimumAgeDays) {
    return null;
  }

  const formattedAge = ageDays.toFixed(1);
  return `Warning: This plan was last updated ${formattedAge} days ago (minimum ${minimumAgeDays}). Confirm it is ready for archival before compacting.`;
}
