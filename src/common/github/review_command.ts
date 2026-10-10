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

export type ReviewCommandParseResult =
  /** The event is not a comment that contains the command. */
  | { kind: 'none' }
  /** The comment contains the command, but tim must not act on it. */
  | { kind: 'ignored'; reason: string; target: string; commenter: string | null }
  | { kind: 'request'; request: ReviewCommandRequest };

/**
 * Classify an `issue_comment` webhook payload. Only a new PR comment with the command from
 * an allowed author that is not a bot gives a request. A comment that has the command but
 * fails a check gives the reason, so the caller can log it.
 */
export function parseReviewCommandEvent(
  payload: unknown,
  repositoryFullName: string | null,
  receivedAt: string
): ReviewCommandParseResult {
  if (!payload || typeof payload !== 'object') {
    return { kind: 'none' };
  }

  const { action, issue, comment } = payload as IssueCommentPayload;
  if (typeof comment?.body !== 'string' || !hasReviewCommand(comment.body)) {
    return { kind: 'none' };
  }

  const login = typeof comment.user?.login === 'string' ? comment.user.login : null;
  const issueNumber = typeof issue?.number === 'number' ? issue.number : null;
  const target = `${repositoryFullName ?? 'unknown repository'}#${issueNumber ?? '?'}`;
  const ignore = (reason: string): ReviewCommandParseResult => ({
    kind: 'ignored',
    reason,
    target,
    commenter: login,
  });

  if (action !== 'created') {
    return ignore(`comment action is "${String(action)}", not "created"`);
  }
  if (!issue?.pull_request) {
    return ignore('the comment is on an issue, not a pull request');
  }
  const [owner, repo] = repositoryFullName?.split('/') ?? [];
  if (!owner || !repo || issueNumber === null || typeof comment.id !== 'number') {
    return ignore('the payload has no repository, PR number, or comment ID');
  }
  if (login === null) {
    return ignore('the comment has no author login');
  }
  if (comment.user?.type === 'Bot') {
    return ignore('the comment author is a bot');
  }
  const association =
    typeof comment.author_association === 'string' ? comment.author_association : 'missing';
  if (!ALLOWED_AUTHOR_ASSOCIATIONS.has(association)) {
    return ignore(`author association ${association} is not OWNER, MEMBER, or COLLABORATOR`);
  }

  return {
    kind: 'request',
    request: {
      owner,
      repo,
      prNumber: issueNumber,
      prUrl: `https://github.com/${owner}/${repo}/pull/${issueNumber}`,
      commentId: comment.id,
      commenter: login,
      requestedAt: receivedAt,
    },
  };
}
