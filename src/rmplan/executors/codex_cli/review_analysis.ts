import { z } from 'zod';
import { generateObject } from 'ai';
import { createModel } from '../../../common/model_factory.ts';
import { debugLog, error, log } from '../../../logging.ts';

export const ReviewAnalysisSchema = z.object({
  needs_fixes: z.boolean().describe('Whether fixes are actually required within the current scope'),
  fix_instructions: z
    .string()
    .optional()
    .describe('Specific, actionable instructions for fixes if needed'),
});

export type ReviewAnalysisResult = z.infer<typeof ReviewAnalysisSchema>;

export interface AnalyzeReviewFeedbackParams {
  reviewerOutput: string;
  completedTasks: string[];
  pendingTasks: string[];
  implementerOutput?: string;
  fixerOutput?: string;
  repoReviewDoc?: string;
  /** Optional override for the model name; defaults to google/gemini-2.5-flash */
  modelName?: string;
}

/**
 * Analyze reviewer feedback to determine if fixes are required within the current scope
 * and extract specific fix instructions when applicable.
 */
export async function analyzeReviewFeedback(
  params: AnalyzeReviewFeedbackParams
): Promise<ReviewAnalysisResult> {
  const {
    reviewerOutput,
    completedTasks,
    pendingTasks,
    implementerOutput,
    fixerOutput,
    repoReviewDoc,
    modelName = 'google/gemini-2.5-flash',
  } = params;

  const prompt = buildAnalysisPrompt({
    reviewerOutput,
    completedTasks,
    pendingTasks,
    implementerOutput,
    fixerOutput,
    repoReviewDoc,
  });

  try {
    const model = await createModel(modelName);
    const { object } = await generateObject({
      model,
      schema: ReviewAnalysisSchema,
      prompt,
    });

    // Basic sanity defaults
    const needs_fixes = Boolean(object?.needs_fixes);
    const fix_instructions = object?.fix_instructions?.trim() || undefined;
    const result: ReviewAnalysisResult = { needs_fixes, fix_instructions };

    debugLog('Review analysis result:', JSON.stringify(result));
    return result;
  } catch (e) {
    error(`Review analysis failed: ${(e as Error).toString()}`);
    return {
      needs_fixes: true,
      fix_instructions: '',
    };
  }
}

function buildAnalysisPrompt(input: {
  reviewerOutput: string;
  completedTasks: string[];
  pendingTasks: string[];
  implementerOutput?: string;
  fixerOutput?: string;
  repoReviewDoc?: string;
}) {
  const {
    reviewerOutput,
    completedTasks,
    pendingTasks,
    fixerOutput,
    implementerOutput,
    repoReviewDoc,
  } = input;

  const completed = completedTasks.length ? `- ${completedTasks.join('\n- ')}` : '(none)';
  const pending = pendingTasks.length ? `- ${pendingTasks.join('\n- ')}` : '(none)';

  const reviewDocSection = repoReviewDoc
    ? `\n\n## Repository Review Guidance\n${repoReviewDoc}`
    : '';

  const implementerSection = implementerOutput
    ? `\n\n## Implementer Output\n${implementerOutput}`
    : '';

  const fixerSection = fixerOutput
    ? `\n\n## Coding Agent's Response to Previous Review\n${fixerOutput}`
    : '';

  return `You are a code review analysis assistant. Your job is to read a reviewer report and decide:
1) Are the issues valid for the current batch scope (i.e., within completed tasks) or out-of-scope (belong to pending tasks or future phases)?
2) Is the issue overlay pedantic or trivial nits that do not impact correctness or acceptance criteria? (Note, this judgement is independent of the issue's severity.)
3) Is the issue still present? Issues marked "resolved" or similar do not need to be fixed.

For any issues you deem valid, copy the issue title and its corresponding description verbatim into your fix_instructions output.

Return a strict JSON object that matches this schema exactly:
{
  "needs_fixes": boolean,
  "fix_instructions": string | undefined
}

Rules:
- Issues that are out-of-scope because they relate to pending tasks do not need to be fixed.
- For trivial nits that do not impact correctness or acceptance criteria, use your best judgment. This does not mean to just exclude minor issues.
- Issues in fix_instructions should be verbatim quotes from the Reviewer Report section as much as possible.
- Set needs_fixes to true if there are any issues in fix_instructions.

Context:
## Completed Tasks (current batch)
${completed}

## Pending Tasks (future / out-of-scope)
${pending}
${implementerSection}

## Reviewer Report
${reviewerOutput}
${reviewDocSection}
${fixerSection}
`;
}
