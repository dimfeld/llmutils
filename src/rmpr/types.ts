import type { CommentNode, DiffLine, ReviewThreadNode } from '../common/github/pull_requests.ts';

export interface DetailedReviewComment {
  thread: Pick<ReviewThreadNode, 'id' | 'path' | 'diffSide' | 'line' | 'startLine'>;
  comment: Pick<CommentNode, 'id' | 'databaseId' | 'body' | 'diffHunk' | 'author'>;
  diffForContext: DiffLine[];
  cleanedComment?: string;
}

export interface CommentDiffContext {
  id: string;
  aiComment: string;
  diffHunk: string;
}

export interface HybridInsertionResult {
  contentWithAiComments: string;
  commentDiffContexts: CommentDiffContext[];
  errors: Array<{ comment: DetailedReviewComment; error: string }>;
}
