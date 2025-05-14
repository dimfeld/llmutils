import type { CommentNode, ReviewThreadNode } from '../common/github/pull_requests.ts';

export interface DetailedReviewComment {
  thread: Pick<ReviewThreadNode, 'id' | 'path' | 'originalLine' | 'originalStartLine'>;
  comment: Pick<CommentNode, 'id' | 'body' | 'diffHunk' | 'author'>;
  diffForContext: string;
}
