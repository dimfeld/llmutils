import * as path from 'node:path';
import clipboardy from 'clipboardy';
import { applyLlmEdits } from '../apply-llm-edits/apply.js';
import { createRetryRequester } from '../apply-llm-edits/retry.js';
import {
  fetchPullRequestAndComments,
  selectReviewComments,
  type FileNode,
} from '../common/github/pull_requests.js';
import { DEFAULT_RUN_MODEL, runStreamingPrompt } from '../common/run_and_apply.js';
import { waitForEnter } from '../common/terminal.js';
import { debugLog, error, log } from '../logging.js';
import { getGitRoot, secureWrite } from '../rmfilter/utils.js';
import type { RmplanConfig } from '../rmplan/configSchema.js';
import { getDiff, getFileContentAtRef } from './git_utils.js';
import {
  createInlineCommentsPrompt,
  insertAiCommentsIntoFileContent,
  removeAiCommentMarkers,
} from './modes/inline_comments.js';
import {
  createSeparateContextPrompt,
  formatReviewCommentsForSeparateContext,
} from './modes/separate_context.js';
import type { DetailedReviewComment } from './types.js';
import { parsePrOrIssueNumber } from '../common/github/identifiers.js';
import { runRmfilterProgrammatically } from '../rmfilter/rmfilter.js';

export async function handleRmprCommand(
  prIdentifierArg: string,
  options: { mode: string; yes: boolean; model?: string; dryRun: boolean; run: boolean },
  globalCliOptions: { debug?: boolean },
  config: RmplanConfig
) {
  const effectiveModel = options.model || config?.models?.execution || DEFAULT_RUN_MODEL;

  const parsedIdentifier = await parsePrOrIssueNumber(prIdentifierArg);

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

  log(
    `Processing PR: ${parsedIdentifier.owner}/${parsedIdentifier.repo}#${parsedIdentifier.number}`
  );

  let prData;
  try {
    log('Fetching PR data and comments...');
    prData = await fetchPullRequestAndComments(
      parsedIdentifier.owner,
      parsedIdentifier.repo,
      parsedIdentifier.number
    );
  } catch (e: any) {
    error(`Failed to fetch PR data: ${e.message}`);
    if (globalCliOptions.debug) {
      console.error(e);
    }
    process.exit(1);
  }

  const { pullRequest } = prData;

  const baseRefName = pullRequest.baseRefName;
  const headRefName = pullRequest.headRefName;
  const changedFiles: FileNode[] = pullRequest.files.nodes;

  log(`Base branch: ${baseRefName}`);
  log(`Head branch: ${headRefName}`);
  log(`Changed files in PR: ${changedFiles.map((f) => f.path).join(', ')}`);

  if (pullRequest.reviewThreads.nodes.every((t) => t.isResolved)) {
    log('No unresolved review comments found for this PR. Exiting.');
    process.exit(0);
  }

  log(`Found ${pullRequest.reviewThreads.nodes.length} unresolved threads.`);

  const selectedComments = await selectReviewComments(
    pullRequest.reviewThreads.nodes,
    pullRequest.number,
    pullRequest.title
  );

  if (selectedComments.length === 0) {
    log('No comments selected by the user. Exiting.');
    process.exit(0);
  }

  log(`Selected ${selectedComments.length} comments to address:`);
  selectedComments.forEach(({ comment, thread }, index) => {
    log(`  ${index + 1}. [${thread.path}:${thread.originalLine}]:`);
    log(`     Body: "${comment.body.split('\n')[0]}..."`);
    log(`     Diff Hunk: "${comment.diffHunk.split('\n')[0]}..."`);
  });

  // 1. Identify unique file paths from selected comments
  const commentsByFilePath = new Map<string, DetailedReviewComment[]>();
  selectedComments.forEach((comment) => {
    const commentsForThisFile = commentsByFilePath.get(comment.thread.path) || [];
    commentsForThisFile.push(comment);
    commentsByFilePath.set(comment.thread.path, commentsForThisFile);
  });

  log(`Identified ${commentsByFilePath.size} unique file paths from selected comments.`);

  const gitRoot = await getGitRoot();

  let instructions: string;
  const filesProcessedWithAiComments = new Map<string, string>();

  if (options.mode === 'inline-comments') {
    log('Preparing context in Inline Comments mode...');
    for (const [filePath, commentsForThisFile] of commentsByFilePath.entries()) {
      const originalContent = await Bun.file(filePath).text();
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        originalContent,
        commentsForThisFile,
        filePath
      );
      filesProcessedWithAiComments.set(filePath, contentWithAiComments);
    }

    if (filesProcessedWithAiComments.size > 0 && !options.dryRun) {
      log('\nAI comments have been prepared in the following files:');
      for (const [filePath, content] of filesProcessedWithAiComments.entries()) {
        log(`  - ${filePath}`);
        try {
          await secureWrite(gitRoot, filePath, content);
        } catch (e: any) {
          error(`Failed to write AI comments to ${filePath}: ${e.message}`);
          process.exit(1);
        }
      }

      if (!options.yes) {
        log('Examine and edit the comments if you would like, then press Enter to continue');
        await waitForEnter();
      }
    } else if (filesProcessedWithAiComments.size > 0 && options.dryRun) {
      log('\n--- DRY RUN INFO ---');
      log(
        'In AI Comments mode, if not a dry run, AI comments would be written to the following files for your review before generating the final prompt:'
      );
      for (const filePath of filesProcessedWithAiComments.keys()) {
        log(`  - ${filePath}`);
      }
      log('These files have NOT been modified on disk due to --dry-run.');
      log('The prompt will be generated using the in-memory versions with AI comments.');
      debugLog('Skipping file writing and user prompt for AI comment review due to --dry-run.');
    }
    instructions = createInlineCommentsPrompt(filesProcessedWithAiComments.keys().toArray());
  } else {
    // Default to "separate-context" mode
    log('Preparing context in Separate Context mode...');
    const formattedComments = formatReviewCommentsForSeparateContext(selectedComments);
    instructions = createSeparateContextPrompt(formattedComments);
  }

  const rmFilterArgs = [
    ...commentsByFilePath.keys(),
    '--with-diff',
    '--diff-from',
    headRefName,
    '--instructions',
    instructions,
  ];

  if (!options.run) {
    rmFilterArgs.push('--copy');
  }

  const llmPrompt = await runRmfilterProgrammatically(rmFilterArgs, gitRoot, gitRoot);

  if (options.dryRun) {
    log(
      'Exiting due to --dry-run. No LLM call will be made, and no files will be modified by the LLM.'
    );
    process.exit(0);
  }

  if (!options.run) {
    process.exit(0);
  }

  log('Invoking LLM...');
  let llmOutputText = '';
  try {
    const { text } = await runStreamingPrompt({
      messages: [{ role: 'user', content: llmPrompt }],
      model: effectiveModel,
      temperature: 0,
    });
    llmOutputText = text;
  } catch (e: any) {
    error(`LLM invocation failed: ${e.message}`);
    if (globalCliOptions.debug) console.error(e);
    process.exit(1);
  }

  log('Applying LLM suggestions...');
  try {
    await applyLlmEdits({
      interactive: !options.yes,
      baseDir: gitRoot,
      content: llmOutputText,
      originalPrompt: llmPrompt,
      retryRequester: createRetryRequester(effectiveModel),
      writeRoot: gitRoot,
    });
  } catch (e: any) {
    error(`Failed to apply LLM edits: ${e.message}`);
    // The error from applyLlmEdits might already be user-friendly.
    // If not, add more context here.
    if (globalCliOptions.debug) console.error(e);
    process.exit(1);
  }

  if (options.mode === 'inline-comments' && filesProcessedWithAiComments.size > 0) {
    log('Cleaning up AI comment markers...');
    for (const filePath of filesProcessedWithAiComments.keys()) {
      try {
        const absolutePath = path.resolve(gitRoot, filePath);
        const currentContentAfterLlm = await Bun.file(absolutePath).text();
        const cleanedContent = removeAiCommentMarkers(currentContentAfterLlm);
        await secureWrite(gitRoot, filePath, cleanedContent);
      } catch (e: any) {
        error(`Failed to clean AI comment markers from ${filePath}: ${e.message}`);
      }
    }
    log('AI comment markers cleaned up.');
  }

  log('Successfully addressed selected PR comments.');
}
