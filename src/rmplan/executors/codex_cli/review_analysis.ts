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
  implementerOutput: string;
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
    repoReviewDoc,
    modelName = 'google/gemini-2.5-flash',
  } = params;

  const prompt = buildAnalysisPrompt({
    reviewerOutput,
    completedTasks,
    pendingTasks,
    implementerOutput,
    repoReviewDoc,
  });

  try {
    const model = await createModel(modelName);
    const { object } = await generateObject({
      model,
      schema: ReviewAnalysisSchema,
      prompt,
      mode: 'json',
    });

    // Basic sanity defaults
    const needs_fixes = Boolean(object?.needs_fixes);
    const fix_instructions = object?.fix_instructions?.trim() || undefined;
    const result: ReviewAnalysisResult = { needs_fixes, fix_instructions };

    debugLog('Review analysis result:', JSON.stringify(result));
    return result;
  } catch (e) {
    error(`Review analysis failed: ${(e as Error).toString()}`);
    // Be conservative: if analysis fails, request fixes to avoid missing issues
    return {
      needs_fixes: true,
      fix_instructions: 'Model call failed; proceed with targeted fixes.',
    };
  }
}

function buildAnalysisPrompt(input: {
  reviewerOutput: string;
  completedTasks: string[];
  pendingTasks: string[];
  implementerOutput: string;
  repoReviewDoc?: string;
}) {
  const { reviewerOutput, completedTasks, pendingTasks, implementerOutput, repoReviewDoc } = input;

  const completed = completedTasks.length ? `- ${completedTasks.join('\n- ')}` : '(none)';
  const pending = pendingTasks.length ? `- ${pendingTasks.join('\n- ')}` : '(none)';

  const reviewDocSection = repoReviewDoc
    ? `\n\n## Repository Review Guidance\n${repoReviewDoc}`
    : '';

  return `You are a code review analysis assistant. Your job is to read a reviewer report and decide:
1) Are the concerns valid for the current batch scope (i.e., within completed tasks) or out-of-scope (belong to pending tasks or future phases)?
2) If valid and in-scope, provide concise, concrete fix instructions that a fixer agent can follow immediately.

Return a strict JSON object that matches this schema exactly:
{
  "needs_fixes": boolean,
  "fix_instructions": string | undefined
}

Rules:
- If issues are out-of-scope because they relate to pending tasks, set needs_fixes=false.
- If issues are trivial nits that do not impact correctness or acceptance criteria, set needs_fixes=false.
- If issues block acceptance of the current batch, set needs_fixes=true and write clear fix_instructions.
- fix_instructions should be specific (files, functions, steps), not generic policy statements.

Context:
## Completed Tasks (current batch)
${completed}

## Pending Tasks (future / out-of-scope)
${pending}

## Implementer Output
${implementerOutput}

## Reviewer Report
${reviewerOutput}
${reviewDocSection}
`;
}
