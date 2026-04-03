import { join } from 'node:path';

export function getReviewGuidePath(planId: string | number): string {
  return join('.tim', 'tmp', `review-guide-${planId}.md`);
}
