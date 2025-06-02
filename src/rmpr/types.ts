import type { CommentNode, DiffLine, ReviewThreadNode } from '../common/github/pull_requests.ts';

export interface DetailedReviewComment {
  thread: Pick<ReviewThreadNode, 'id' | 'path' | 'diffSide' | 'line' | 'startLine'>;
  comment: Pick<CommentNode, 'id' | 'databaseId' | 'body' | 'diffHunk' | 'author'>;
  diffForContext: DiffLine[];
  cleanedComment?: string;
}
