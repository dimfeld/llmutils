export interface PrIdentifier {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface DetailedReviewComment {
  threadId: string;
  commentId: string;
  body: string;
  path: string;
  line: number | null;
  originalLine: number;
  originalStartLine: number | null;
  diffHunk: string;
  authorLogin: string | undefined;
  // Add other relevant fields from ReviewThreadNode or CommentNode if necessary
}
