/**
 * `/tim review` PR comment command and `tim-review` PR label: a comment on a PR, or the
 * label added to a PR, asks tim to run an automatic review and post it as a new review
 * from the GitHub App.
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

/** Adding this label to a PR requests a review, the same as a `/tim review` comment. */
export const REVIEW_LABEL_NAME = 'tim-review';

/** What requested the review: a `/tim review` comment or the `tim-review` label. */
export type ReviewCommandTrigger =
  | { kind: 'comment'; commentId: number }
  | { kind: 'label'; label: string };

/** A review request from a `/tim review` PR comment or the `tim-review` PR label. */
export interface ReviewCommandRequest {
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  trigger: ReviewCommandTrigger;
  /** Login of the user who wrote the comment or added the label. */
  requester: string;
  requestedAt: string;
}

/** Text for log lines, such as `/tim review comment` or `tim-review label`. */
export function describeReviewCommandTrigger(trigger: ReviewCommandTrigger): string {
  return trigger.kind === 'comment' ? '/tim review comment' : `${trigger.label} label`;
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
  | { kind: 'ignored'; reason: string; target: string; requester: string | null }
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
    requester: login,
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
      trigger: { kind: 'comment', commentId: comment.id },
      requester: login,
      requestedAt: receivedAt,
    },
  };
}

interface PullRequestLabeledPayload {
  action?: unknown;
  label?: { name?: unknown };
  pull_request?: { number?: unknown; state?: unknown };
  sender?: { login?: unknown; type?: unknown };
}

/**
 * Classify a `pull_request` webhook payload. Only a `labeled` event that adds the
 * `tim-review` label to an open PR, from a user who is not a bot, gives a request. Adding a
 * label needs triage or write access to the repository, so the sender is not checked
 * further.
 */
export function parseReviewLabelEvent(
  payload: unknown,
  repositoryFullName: string | null,
  receivedAt: string
): ReviewCommandParseResult {
  if (!payload || typeof payload !== 'object') {
    return { kind: 'none' };
  }

  const { action, label, pull_request: pullRequest, sender } = payload as PullRequestLabeledPayload;
  if (
    action !== 'labeled' ||
    typeof label?.name !== 'string' ||
    label.name.toLowerCase() !== REVIEW_LABEL_NAME
  ) {
    return { kind: 'none' };
  }

  const login = typeof sender?.login === 'string' ? sender.login : null;
  const prNumber = typeof pullRequest?.number === 'number' ? pullRequest.number : null;
  const target = `${repositoryFullName ?? 'unknown repository'}#${prNumber ?? '?'}`;
  const ignore = (reason: string): ReviewCommandParseResult => ({
    kind: 'ignored',
    reason,
    target,
    requester: login,
  });

  const [owner, repo] = repositoryFullName?.split('/') ?? [];
  if (!owner || !repo || prNumber === null) {
    return ignore('the payload has no repository or PR number');
  }
  if (pullRequest?.state !== 'open') {
    return ignore('the pull request is not open');
  }
  if (login === null) {
    return ignore('the label event has no sender login');
  }
  if (sender?.type === 'Bot') {
    return ignore('the label was added by a bot');
  }

  return {
    kind: 'request',
    request: {
      owner,
      repo,
      prNumber,
      prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      trigger: { kind: 'label', label: label.name },
      requester: login,
      requestedAt: receivedAt,
    },
  };
}
