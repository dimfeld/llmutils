import type { CommentNode, ReviewThreadNode } from '../common/github/pull_requests.ts';

export interface DetailedReviewComment {
  thread: ReviewThreadNode;
  comment: CommentNode;
}
