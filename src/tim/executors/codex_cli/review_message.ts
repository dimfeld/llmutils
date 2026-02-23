import { sendStructured } from '../../../logging';
import type { ExternalReviewResult } from './external_review';
import { timestamp } from './agent_helpers.js';
import { toStructuredReviewIssues } from '../../review_structured_message.js';

export function sendStructuredReviewResult(reviewOutcome: ExternalReviewResult): void {
  sendStructured({
    type: 'review_result',
    timestamp: timestamp(),
    verdict: reviewOutcome.verdict,
    fixInstructions:
      reviewOutcome.verdict === 'NEEDS_FIXES' ? reviewOutcome.fixInstructions : undefined,
    issues: toStructuredReviewIssues(reviewOutcome.reviewResult.issues),
    recommendations: reviewOutcome.reviewResult.recommendations,
    actionItems: reviewOutcome.reviewResult.actionItems,
  });
}
