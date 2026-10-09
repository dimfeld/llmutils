/**
 * `/tim review` PR comment command: a comment on a PR asks tim to run an automatic
 * review and post it as a new review from the GitHub App.
 */

export const REVIEW_COMMAND_PROJECT_SETTING_KEY = 'reviewCommand';

export interface ReviewCommandProjectSetting {
  enabled?: boolean;
}

export function parseReviewCommandProjectSetting(
  value: unknown
): ReviewCommandProjectSetting | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : undefined,
  };
}

export function isReviewCommandEnabled(value: unknown): boolean {
  return parseReviewCommandProjectSetting(value)?.enabled === true;
}

/** Comment authors who may trigger a review. Others could run agents on the PR code at our cost. */
const ALLOWED_AUTHOR_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Matches `/tim review` on a line of its own. Quoted lines (`> /tim review`) do not match. */
const REVIEW_COMMAND_PATTERN = /^[ \t]*\/tim[ \t]+review[ \t]*$/im;

export function hasReviewCommand(body: string): boolean {
  return REVIEW_COMMAND_PATTERN.test(body);
}

/** A `/tim review` request from a PR comment. */
export interface ReviewCommandRequest {
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  commentId: number;
  commenter: string;
  requestedAt: string;
}

interface IssueCommentPayload {
  action?: unknown;
  issue?: { number?: unknown; pull_request?: unknown };
  comment?: {
    id?: unknown;
    body?: unknown;
    author_association?: unknown;
    user?: { login?: unknown; type?: unknown };
  };
}

/**
 * Return the review request in an `issue_comment` webhook payload, or null if the event is
 * not a new PR comment with the command from an allowed author.
 */
export function parseReviewCommandEvent(
  payload: unknown,
  repositoryFullName: string | null,
  receivedAt: string
): ReviewCommandRequest | null {
  if (!payload || typeof payload !== 'object' || !repositoryFullName) {
    return null;
  }

  const { action, issue, comment } = payload as IssueCommentPayload;
  if (action !== 'created' || !issue?.pull_request || typeof issue.number !== 'number') {
    return null;
  }
  if (typeof comment?.id !== 'number' || typeof comment.body !== 'string') {
    return null;
  }
  if (!hasReviewCommand(comment.body)) {
    return null;
  }
  if (
    typeof comment.author_association !== 'string' ||
    !ALLOWED_AUTHOR_ASSOCIATIONS.has(comment.author_association)
  ) {
    return null;
  }
  const login = comment.user?.login;
  if (typeof login !== 'string' || comment.user?.type === 'Bot') {
    return null;
  }

  const [owner, repo] = repositoryFullName.split('/');
  if (!owner || !repo) {
    return null;
  }

  return {
    owner,
    repo,
    prNumber: issue.number,
    prUrl: `https://github.com/${owner}/${repo}/pull/${issue.number}`,
    commentId: comment.id,
    commenter: login,
    requestedAt: receivedAt,
  };
}
