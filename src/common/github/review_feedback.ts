const REVIEW_FEEDBACK_PROMPT_PATTERN = /\s*Useful\? React with 👍 \/ 👎\.\s*$/u;

export function stripReviewFeedbackPrompt(body: string): string {
  return body.replace(REVIEW_FEEDBACK_PROMPT_PATTERN, '').trim();
}
