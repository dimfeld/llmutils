import * as path from 'node:path';
import { applyLlmEdits } from '../apply-llm-edits/apply.js';
import { search, input, select } from '@inquirer/prompts';
import { createRetryRequester } from '../apply-llm-edits/retry.js';
import { parsePrOrIssueNumber } from '../common/github/identifiers.js';
import {
  detectPullRequest,
  fetchPullRequestAndComments,
  selectReviewComments,
  type FileNode,
} from '../common/github/pull_requests.js';
import { DEFAULT_RUN_MODEL, runStreamingPrompt } from '../common/run_and_apply.js';
import { waitForEnter } from '../common/terminal.js';
import { debugLog, error, log, warn } from '../logging.js';
import { getCurrentBranchName } from './git_utils.js';
import { getGitRepository } from '../rmfilter/utils.js';
import { fetchOpenPullRequests } from '../common/github/pull_requests.js';
import { fullRmfilterRun } from '../rmfilter/rmfilter.js';
import { commitAll, getGitRoot, secureWrite, parseCliArgsFromString } from '../rmfilter/utils.js';
import type { RmplanConfig } from '../rmplan/configSchema.js';
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
import {
  argsFromRmprOptions,
  combineRmprOptions,
  parseRmprOptions,
  type RmprOptions,
} from './comment_options.js';
import clipboardy from 'clipboardy';
import { askForModelId } from '../common/model_factory.js';
import { buildExecutorAndLog } from '../rmplan/executors/index.js';

export async function handleRmprCommand(
  prIdentifierArg: string | undefined,
  options: {
    executor: string;
    mode: string;
    yes: boolean;
    model?: string;
    dryRun: boolean;
    run: boolean;
    commit: boolean;
  },
  globalCliOptions: { debug?: boolean },
  config: RmplanConfig
) {
  if (!process.env.GITHUB_TOKEN) {
    error(
      'GITHUB_TOKEN environment variable is not set. Please set it to a valid GitHub personal access token.'
    );
    process.exit(1);
  }

  const resolvedPrIdentifier = await detectPullRequest(prIdentifierArg);
  if (!resolvedPrIdentifier) {
    error('Could not identify a PR to process.');
    process.exit(1);
  }

  log(
    `Processing PR: ${resolvedPrIdentifier.owner}/${resolvedPrIdentifier.repo}#${resolvedPrIdentifier.number}`
  );

  // If we autodetected the PR, verify the branch matches
  if (!prIdentifierArg) {
    const currentBranch = await getCurrentBranchName();
    if (currentBranch) {
      const prData = await fetchPullRequestAndComments(
        resolvedPrIdentifier.owner,
        resolvedPrIdentifier.repo,
        resolvedPrIdentifier.number
      );

      if (prData.pullRequest.headRefName !== currentBranch) {
        warn(
          `Warning: Current branch "${currentBranch}" does not match PR branch "${prData.pullRequest.headRefName}".`
        );
        const proceed =
          options.yes ||
          (
            await input({
              message: 'Continue anyway? (y/N)',
              default: 'n',
            })
          ).toLowerCase() === 'y';

        if (!proceed) {
          log('Operation cancelled by user.');
          process.exit(0);
        }
      }
    }
  }

  // Check if PR identifier was explicitly provided (not autodetected)
  const wasPrIdentifierExplicit =
    prIdentifierArg !== undefined && (await parsePrOrIssueNumber(prIdentifierArg)) !== null;

  let prData;
  try {
    log('Fetching PR data and comments...');
    prData = await fetchPullRequestAndComments(
      resolvedPrIdentifier.owner,
      resolvedPrIdentifier.repo,
      resolvedPrIdentifier.number
    );
  } catch (e: any) {
    error(`Failed to fetch PR data: ${e.message}`);
    if (globalCliOptions.debug) {
      console.error(e);
    }
    process.exit(1);
  }

  // Check for branch mismatch if PR identifier was explicitly provided
  if (wasPrIdentifierExplicit) {
    const currentScmBranch = await getCurrentBranchName();
    const prHeadBranch = prData.pullRequest.headRefName;

    if (currentScmBranch && currentScmBranch !== prHeadBranch) {
      warn(
        `Current local branch "${currentScmBranch}" does not match the PR's head branch "${prHeadBranch}".`
      );

      if (!options.yes) {
        const { confirm } = await import('@inquirer/prompts');
        const proceed = await confirm({
          message: 'Proceed with this PR anyway?',
          default: true,
        });

        if (!proceed) {
          log('User chose not to proceed due to branch mismatch.');
          process.exit(0);
        }
      }
    }
  }

  const { pullRequest } = prData;

  const baseRefName = pullRequest.baseRefName;
  const headRefName = pullRequest.headRefName;
  const changedFiles: FileNode[] = pullRequest.files.nodes;

  log(`Base branch: ${baseRefName}`);
  log(`Head branch: ${headRefName}`);
  log(`Changed files in PR: ${changedFiles.map((f) => f.path).join(', ')}`);

  const unresolvedReviewThreads = pullRequest.reviewThreads.nodes.filter((t) => !t.isResolved);

  if (unresolvedReviewThreads.length === 0) {
    log('No unresolved review comments found for this PR. Exiting.');
    process.exit(0);
  }

  log(`Found ${unresolvedReviewThreads.length} unresolved threads.`);

  const selectedComments = await selectReviewComments(
    unresolvedReviewThreads,
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

  // 1. Identify unique file paths from selected comments and parse --rmpr options
  const commentsByFilePath = new Map<
    string,
    { comments: DetailedReviewComment[]; options: RmprOptions }
  >();
  selectedComments.forEach((comment) => {
    const commentsForThisFile = commentsByFilePath.get(comment.thread.path) || {
      comments: [],
      options: {},
    };

    const { options: rmprOptions, cleanedComment } = parseRmprOptions(comment.comment.body);
    if (rmprOptions) {
      commentsForThisFile.options = combineRmprOptions(commentsForThisFile.options, rmprOptions);
      debugLog(`Parsed --rmpr options for comment ${comment.comment.id}:`, rmprOptions);
    }

    commentsForThisFile.comments.push({ ...comment, cleanedComment });
    commentsByFilePath.set(comment.thread.path, commentsForThisFile);
  });

  log(`Identified ${commentsByFilePath.size} unique file paths from selected comments.`);

  const gitRoot = await getGitRoot();

  let instructions: string;
  const filesProcessedWithAiComments = new Map<string, string>();

  // Initialize state variables for interactive settings adjustment
  let modelForLlmEdit = options.model || config?.models?.execution || DEFAULT_RUN_MODEL;
  let additionalUserRmFilterArgs: string[] = [];

  if (!options.yes) {
    log('\nSettings can be adjusted before generating the LLM prompt.');
    if (options.mode === 'inline-comments' && filesProcessedWithAiComments.size > 0) {
      log(
        'AI comments have been written to the relevant files. You can examine and edit them directly on disk before continuing.'
      );
    }

    const promptResults = await optionsPrompt({
      modelForLlmEdit,
      executor: options.executor,
      commit: options.commit,
    });
    modelForLlmEdit = promptResults.model;
    options.executor = promptResults.executor;
    options.commit = promptResults.commit;
    additionalUserRmFilterArgs = promptResults.rmfilterOptions;
  }

  const executor = buildExecutorAndLog(
    options.executor,
    {
      baseDir: gitRoot,
      model: modelForLlmEdit,
    },
    config
  );

  if (executor.forceReviewCommentsMode) {
    options.mode = executor.forceReviewCommentsMode;
  }

  if (options.mode === 'inline-comments') {
    log('Preparing context in Inline Comments mode...');
    for (const [filePath, fileInfo] of commentsByFilePath.entries()) {
      const originalContent = await Bun.file(path.resolve(gitRoot, filePath)).text();
      const { contentWithAiComments, errors } = insertAiCommentsIntoFileContent(
        originalContent,
        fileInfo.comments,
        filePath
      );
      filesProcessedWithAiComments.set(filePath, contentWithAiComments);

      for (const message of errors) {
        error(message);
      }
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
    } else if (filesProcessedWithAiComments.size > 0 && options.dryRun) {
      log('\n--- DRY RUN INFO ---');
      log(
        'In AI Comments mode, if not a dry run, AI comments would be written to the following files for your review before generating the final prompt:'
      );
      for (const filePath of filesProcessedWithAiComments.keys()) {
        log(`  - ${filePath}`);
      }
      log('These files have NOT been modified on disk due to --dry-run.');
    }
    instructions = createInlineCommentsPrompt(filesProcessedWithAiComments.keys().toArray());
  } else {
    // Default to "separate-context" mode
    log('Preparing context in Separate Context mode...');
    const formattedComments = formatReviewCommentsForSeparateContext(selectedComments);
    instructions = createSeparateContextPrompt(formattedComments);
  }

  const prepareOptions = executor.prepareStepOptions?.();

  let llmPrompt: string;

  if (prepareOptions?.rmfilter) {
    // Construct rmfilter arguments, incorporating --rmpr options
    let rmFilterArgs: string[] = [
      '--with-diff',
      '--diff-from',
      headRefName,
      '--instructions',
      instructions,
      '--model',
      modelForLlmEdit,
    ];

    // Add files and related options
    for (const [filePath, fileInfo] of commentsByFilePath.entries()) {
      const rmprOptions = fileInfo.options;
      rmFilterArgs.push('--', filePath);
      rmFilterArgs.push(...argsFromRmprOptions(rmprOptions, pullRequest));
    }

    rmFilterArgs.push(...additionalUserRmFilterArgs);

    if (prepareOptions.rmfilterArgs) {
      rmFilterArgs.push('--', ...prepareOptions.rmfilterArgs);
    }

    llmPrompt = await fullRmfilterRun({
      args: rmFilterArgs,
      gitRoot,
      baseDir: gitRoot,
      skipWrite: true,
    });
  } else {
    // TODO This needs some additional work to provide enough context to the model.
    llmPrompt = instructions;
  }

  if (options.dryRun) {
    log(
      'Exiting due to --dry-run. No LLM call will be made, and no files will be modified by the LLM.'
    );
    process.exit(0);
  }

  await executor.execute(llmPrompt);

  if (options.mode === 'inline-comments' && filesProcessedWithAiComments.size > 0) {
    log('Cleaning up AI comment markers...');
    for (const filePath of filesProcessedWithAiComments.keys()) {
      try {
        const absolutePath = path.resolve(gitRoot, filePath);
        const currentContentAfterLlm = await Bun.file(absolutePath).text();
        const cleanedContent = removeAiCommentMarkers(currentContentAfterLlm, filePath);
        await secureWrite(gitRoot, filePath, cleanedContent);
      } catch (e: any) {
        error(`Failed to clean AI comment markers from ${filePath}: ${e.message}`);
      }
    }
  }

  log('Successfully addressed selected PR comments.');

  if (options.commit) {
    const prUrl = `https://github.com/${resolvedPrIdentifier.owner}/${resolvedPrIdentifier.repo}/pull/${resolvedPrIdentifier.number}`;
    log('Committing changes...');

    let firstLine: string;
    if (selectedComments.length === 1) {
      const firstCommentBody =
        selectedComments[0].cleanedComment || selectedComments[0].comment.body;
      const bodyFirstLine =
        firstCommentBody.split('\n').find((l) => l.trim().length > 0) || 'Empty comment';
      let slicedBodyFirstLine = bodyFirstLine.slice(0, 50);
      if (slicedBodyFirstLine !== bodyFirstLine) {
        let lastSpace = slicedBodyFirstLine.lastIndexOf(' ');
        if (lastSpace !== -1) {
          slicedBodyFirstLine = slicedBodyFirstLine.slice(0, lastSpace);
        }
        slicedBodyFirstLine += '…';
      }
      firstLine = `Address PR comment: ${slicedBodyFirstLine}`;
    } else {
      firstLine = `Address ${selectedComments.length} PR comments`;
    }
    const commitMessageParts: string[] = [
      firstLine,
      '',
      'Changes address the following review comments:\n',
      selectedComments
        .map((c) => {
          const { thread, comment, cleanedComment } = c;
          const body = cleanedComment || comment.body;
          const url = `${prUrl}#discussion_r${comment.databaseId}`;
          return `## ${thread.path}:${thread.line} -- (${url})\n${body}`;
        })
        .join('\n\n'),
    ];
    const commitMessage = commitMessageParts.join('\n');
    const exitCode = await commitAll(commitMessage);
    if (exitCode === 0) {
      log('Changes committed successfully.');
    } else {
      error(`Commit failed with exit code ${exitCode}.`);
    }
  }
}

interface PromptOptions {
  model: string;
  rmfilterOptions: string[];
  executor: string;
  commit: boolean;
}

async function optionsPrompt(initialOptions: {
  modelForLlmEdit: string;
  executor: string;
  commit: boolean;
}): Promise<PromptOptions> {
  let result: PromptOptions = {
    model: initialOptions.modelForLlmEdit,
    rmfilterOptions: [],
    executor: initialOptions.executor,
    commit: initialOptions.commit,
  };

  let userWantsToContinue = false;
  while (!userWantsToContinue) {
    log('');
    const choice = await select({
      message: 'What would you like to do?',
      default: 'continue',
      choices: [
        { name: 'Continue to generate LLM prompt', value: 'continue' },
        { name: 'Change LLM model for editing', value: 'model' },
        { name: 'Edit rmfilter options for context', value: 'rmfilter' },
        result.commit
          ? { name: 'Disable autocommit', value: 'no-commit' }
          : { name: 'Enable autocommit', value: 'commit' },
      ],
    });

    if (choice === 'continue') {
      userWantsToContinue = true;
    } else if (choice === 'model') {
      const newSetting = await askForModelId();
      if (newSetting) {
        result.executor = newSetting.executor;
        result.model = newSetting.value;
      }
      log(`LLM model for editing set to: ${result.model}`);
    } else if (choice === 'rmfilter') {
      const newArgsStr = await input({
        message: 'Enter additional rmfilter arguments (space-separated):',
        default: result.rmfilterOptions.join(' '),
      });
      result.rmfilterOptions = parseCliArgsFromString(newArgsStr.trim());
      log(`Additional rmfilter args set to: "${result.rmfilterOptions.join(' ')}"`);
    } else if (choice === 'no-commit') {
      result.commit = false;
    } else if (choice === 'commit') {
      result.commit = true;
    }
  }

  debugLog(result);

  return result;
}
