import { error, log } from '../logging.js';
import type { PrIdentifier } from './types.js';
import {
  fetchPullRequestAndComments,
  getDetailedUnresolvedReviewComments,
  selectDetailedReviewComments,
  type FileNode,
} from '../common/github/pull_requests.js';
import type { DetailedReviewComment } from './types.js';

export function parsePrIdentifier(identifier: string): PrIdentifier | null {
  // Try parsing as full URL: https://github.com/owner/repo/pull/123
  const urlMatch = identifier.match(/^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)$/);
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      prNumber: parseInt(urlMatch[3], 10),
    };
  }

  // Try parsing as short format: owner/repo#123
  const shortMatch = identifier.match(/^([^\/]+)\/([^\/#]+)#(\d+)$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1],
      repo: shortMatch[2],
      prNumber: parseInt(shortMatch[3], 10),
    };
  }

  // Try parsing as alternative short format: owner/repo/123
  const altShortMatch = identifier.match(/^([^\/]+)\/([^\/]+)\/(\d+)$/);
  if (altShortMatch) {
    return {
      owner: altShortMatch[1],
      repo: altShortMatch[2],
      prNumber: parseInt(altShortMatch[3], 10),
    };
  }

  return null;
}

export async function handleRmprCommand(
  prIdentifierArg: string,
  options: any,
  globalCliOptions: any
) {
  const parsedIdentifier = parsePrIdentifier(prIdentifierArg);

  if (!process.env.GITHUB_TOKEN) {
    error(
      'GITHUB_TOKEN environment variable is not set. Please set it to a valid GitHub personal access token.'
    );
    process.exit(1);
  }

  if (!parsedIdentifier) {
    error(
      `Invalid PR identifier format: ${prIdentifierArg}. Expected URL (e.g., https://github.com/owner/repo/pull/123), owner/repo#123, or owner/repo/123.`
    );
    process.exit(1);
  }

  log(`Parsed PR Identifier:
  Owner: ${parsedIdentifier.owner}
  Repo: ${parsedIdentifier.repo}
  PR Number: ${parsedIdentifier.prNumber}
  Mode: ${options.mode}
  Yes: ${options.yes}
  Model: ${options.model || 'default/not specified'}
  Debug: ${globalCliOptions.debug || false}`);

  let prData;
  try {
    log('Fetching PR data and comments...');
    prData = await fetchPullRequestAndComments(
      parsedIdentifier.owner,
      parsedIdentifier.repo,
      parsedIdentifier.prNumber
    );
  } catch (e: any) {
    error(`Failed to fetch PR data: ${e.message}`);
    if (globalCliOptions.debug) {
      console.error(e);
    }
    process.exit(1);
  }

  const { pullRequest, reviewThreads } = prData;

  const baseRefName = pullRequest.baseRefName;
  const headRefName = pullRequest.headRefName;
  const changedFiles: FileNode[] = pullRequest.files.nodes;

  log(`Base branch: ${baseRefName}`);
  log(`Head branch: ${headRefName}`);
  log(`Changed files in PR: ${changedFiles.map((f) => f.path).join(', ')}`);

  const unresolvedComments: DetailedReviewComment[] =
    getDetailedUnresolvedReviewComments(reviewThreads);

  if (unresolvedComments.length === 0) {
    log('No unresolved review comments found for this PR. Exiting.');
    process.exit(0);
  }

  log(`Found ${unresolvedComments.length} unresolved review comments.`);

  const selectedComments = await selectDetailedReviewComments(
    unresolvedComments,
    pullRequest.number,
    pullRequest.title
  );

  if (selectedComments.length === 0) {
    log('No comments selected by the user. Exiting.');
    process.exit(0);
  }

  log(`Selected ${selectedComments.length} comments to address:`);
  selectedComments.forEach((comment, index) => {
    log(
      `  ${index + 1}. [${comment.path}:${comment.originalLine}] by ${
        comment.authorLogin || 'unknown'
      }:`
    );
    log(`     Body: "${comment.body.split('\n')[0]}..."`);
    log(`     Diff Hunk: "${comment.diffHunk.split('\n')[0]}..."`);
  });

  // Further implementation will continue here
}
