import type { PlanSchema } from './planSchema.js';

export type AppendResearchOptions = {
  insertedAt?: Date | false;
  heading?: string;
};

function formatTimestamp(date: Date): string {
  const iso = date.toISOString();
  const [datePart, timePart] = iso.split('T');
  const [hours = '00', minutes = '00'] = timePart.replace('Z', '').split(':');
  return `${datePart} ${hours}:${minutes} UTC`;
}

export function appendResearchToPlan(
  plan: PlanSchema,
  researchContent: string,
  options: AppendResearchOptions = {}
): PlanSchema {
  const trimmedResearch = researchContent.trim();
  if (!trimmedResearch) {
    return plan;
  }

  const heading = options.heading ?? '## Research';
  const insertedAt = options.insertedAt ?? new Date();
  const timestamp = insertedAt !== false ? formatTimestamp(insertedAt) : '';
  const entryHeader = timestamp ? `### ${timestamp}` : '';

  const currentDetails = plan.details?.trimEnd() ?? '';
  const researchRegex = /## Research(\s|$)/;
  const hasExistingHeading =
    researchRegex.test(currentDetails) || researchRegex.test(trimmedResearch);

  const pieces: string[] = [];
  if (currentDetails) {
    pieces.push(currentDetails);
  }

  if (!hasExistingHeading) {
    pieces.push(heading);
  }

  if (entryHeader) {
    pieces.push(entryHeader);
  }

  pieces.push(trimmedResearch);

  const details = pieces.join('\n\n').trimEnd() + '\n';

  return {
    ...plan,
    details,
    updatedAt: (insertedAt || new Date()).toISOString(),
  };
}
