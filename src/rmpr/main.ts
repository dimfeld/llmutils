import * as path from 'node:path';
import { applyLlmEdits } from '../apply-llm-edits/apply.js';
import { search, expand, input } from '@inquirer/prompts';
import { createRetryRequester } from '../apply-llm-edits/retry.js';
import { parsePrOrIssueNumber } from '../common/github/identifiers.js';
import {
  fetchPullRequestAndComments,
  selectReviewComments,
  type FileNode,
} from '../common/github/pull_requests.js';
import { DEFAULT_RUN_MODEL, runStreamingPrompt } from '../common/run_and_apply.js';
import { waitForEnter } from '../common/terminal.js';
import { debugLog, error, log } from '../logging.js';
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

export async function handleRmprCommand(
  prIdentifierArg: string,
  options: {
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

  // Initialize state variables for interactive settings adjustment
  let modelForLlmEdit = options.model || config?.models?.execution || DEFAULT_RUN_MODEL;
  let additionalUserRmFilterArgs: string[] = [];

  if (!options.yes) {
    log('\nSettings can be adjusted before generating the LLM prompt.');
    if (
      options.mode === 'inline-comments' &&
      filesProcessedWithAiComments.size > 0 &&
      !options.dryRun
    ) {
      log(
        'AI comments have been written to the relevant files. You can examine and edit them directly on disk before continuing.'
      );
    } else if (
      options.mode === 'inline-comments' &&
      filesProcessedWithAiComments.size > 0 &&
      options.dryRun
    ) {
      log('AI comments *would have been* written to files for review (this is a dry run).');
    }

    const promptResults = await optionsPrompt({ modelForLlmEdit, run: options.run });
    modelForLlmEdit = promptResults.model;
    options.run = promptResults.run;
    additionalUserRmFilterArgs = promptResults.rmfilterOptions;
  }

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
    rmFilterArgs.push(...argsFromRmprOptions(pullRequest, rmprOptions));
  }

  rmFilterArgs.push(...additionalUserRmFilterArgs);

  if (!options.run) {
    rmFilterArgs.push('--copy');
  }

  const llmPrompt = await fullRmfilterRun({ args: rmFilterArgs, gitRoot, skipWrite: true });

  if (options.dryRun) {
    log(
      'Exiting due to --dry-run. No LLM call will be made, and no files will be modified by the LLM.'
    );
    process.exit(0);
  }

  let llmOutputText: string;
  if (options.run) {
    log('Invoking LLM...');
    try {
      const { text } = await runStreamingPrompt({
        messages: [{ role: 'user', content: llmPrompt }],
        model: modelForLlmEdit,
        temperature: 0,
      });
      llmOutputText = text;
    } catch (e: any) {
      error(`LLM invocation failed: ${e.message}`);
      if (globalCliOptions.debug) console.error(e);
      process.exit(1);
    }
  } else {
    log(
      `Paste the context into your model, and then press Enter to apply once you've copied the output.`
    );
    await waitForEnter();
    llmOutputText = await clipboardy.read();
  }

  log('Applying LLM suggestions...');
  try {
    await applyLlmEdits({
      interactive: !options.yes,
      baseDir: gitRoot,
      content: llmOutputText,
      originalPrompt: llmPrompt,
      retryRequester: options.run ? createRetryRequester(modelForLlmEdit) : undefined,
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
        const cleanedContent = removeAiCommentMarkers(currentContentAfterLlm, filePath);
        await secureWrite(gitRoot, filePath, cleanedContent);
      } catch (e: any) {
        error(`Failed to clean AI comment markers from ${filePath}: ${e.message}`);
      }
    }
    log('AI comment markers cleaned up.');
  }

  log('Successfully addressed selected PR comments.');

  if (options.commit) {
    const prUrl = `https://github.com/${parsedIdentifier.owner}/${parsedIdentifier.repo}/pull/${parsedIdentifier.number}`;
    log('Committing changes...');

    let firstLine: string;
    if (selectedComments.length === 1) {
      const firstCommentBody =
        selectedComments[0].cleanedComment || selectedComments[0].comment.body;
      const bodyFirstLine = firstCommentBody.split('\n')[0];
      firstLine = `Address PR comment: ${bodyFirstLine.slice(0, 100)}...`;
    } else {
      firstLine = `Address ${selectedComments.length} PR comments for ${parsedIdentifier.owner}/${parsedIdentifier.repo}#${parsedIdentifier.number}`;
    }
    const commitMessageParts: string[] = [
      firstLine,
      '',
      'Changes address the following review comments:',
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
  run: boolean;
}

async function optionsPrompt(initialOptions: {
  modelForLlmEdit: string;
  run: boolean;
}): Promise<PromptOptions> {
  let result: PromptOptions = {
    model: initialOptions.modelForLlmEdit,
    rmfilterOptions: [],
    run: initialOptions.run,
  };

  let userWantsToContinue = false;
  while (!userWantsToContinue) {
    const choice = await expand({
      message: 'What would you like to do?',
      choices: [
        { key: 'c', name: 'Continue to generate LLM prompt', value: 'continue' },
        { key: 'm', name: 'Change LLM model for editing', value: 'model' },
        { key: 'r', name: 'Edit rmfilter options for context', value: 'rmfilter' },
      ],
    });

    if (choice === 'continue') {
      userWantsToContinue = true;
    } else if (choice === 'model') {
      const availableModels = [
        'google/gemini-2.5-pro-preview-05-06',
        'google/gemini-2.5-flash-preview-04-17',
        'google/gemini-2.0-flash',
        'openai/o4-mini',
        'openai/gpt-4.1',
        'openai/gpt-4.1-mini',
        'openai/gpt-4.1-nano',
        'anthropic/claude-3.5-sonnet-latest',
        'anthropic/claude-3.5-haiku-latest',
        'anthropic/claude-3.7-sonnet-latest',
        'openrouter/anthropic/claude-3.5-sonnet',
        'openrouter/anthropic/claude-3.7-sonnet',
        'openrouter/anthropic/claude-3.5-haiku',
        'openrouter/openai/gpt-4.1',
        'openrouter/openai/gpt-4.1-mini',
        'openrouter/openai/gpt-4.1-nano',
        'openrouter/openai/o4-mini',
        'openrouter/google/gemini-2.5-pro-preview',
        'openrouter/google/gemini-2.5-flash-preview',
        { name: 'Claude Web', value: 'claude', run: false },
        { name: 'Gemini AI Studio', value: 'gemini', run: false },
        { name: 'Grok Web', value: 'grok', run: true },
      ].map((m) =>
        typeof m === 'string'
          ? {
              name: m,
              value: m,
              run: true,
            }
          : m
      );

      const newModel = await search({
        message: 'Select or type to filter LLM model:',
        theme: {
          helpMode: 'always',
        },
        source: (input) => {
          return availableModels.filter(({ name }) =>
            input ? name.toLowerCase().includes(input.toLowerCase()) : true
          );
        },
      });

      const modelSetting = availableModels.find((m) => m.value === newModel);
      if (modelSetting) {
        result.run = modelSetting.run;
      }

      result.model = newModel;
      log(`LLM model for editing set to: ${result.model}`);
    } else if (choice === 'rmfilter') {
      const newArgsStr = await input({
        message: 'Enter additional rmfilter arguments (space-separated):',
        default: result.rmfilterOptions.join(' '),
      });
      result.rmfilterOptions = parseCliArgsFromString(newArgsStr.trim());
      log(`Additional rmfilter args set to: "${result.rmfilterOptions.join(' ')}"`);
    }
  }

  return result;
}
