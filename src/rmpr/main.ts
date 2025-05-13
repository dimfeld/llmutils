import { error, log, debugLog } from '../logging.js';
import * as path from 'node:path';
import type { PrIdentifier } from './types.js';
import {
  fetchPullRequestAndComments,
  getDetailedUnresolvedReviewComments,
  selectDetailedReviewComments,
  type FileNode,
} from '../common/github/pull_requests.js';
import type { DetailedReviewComment } from './types.js';
import { getFileContentAtRef, getDiff } from './git_utils.js';
import {
  createAiCommentsPrompt,
  createSeparateContextPrompt,
  formatReviewCommentsForSeparateContext,
  insertAiCommentsIntoFileContent,
  removeAiCommentMarkers,
} from './modes.js';
import { getGitRoot, secureWrite } from '../rmfilter/utils.js';
import readline from 'node:readline';
import { DEFAULT_RUN_MODEL, runStreamingPrompt } from '../common/run_and_apply.js';
import { applyLlmEdits } from '../apply-llm-edits/apply.js';
import { createRetryRequester } from '../apply-llm-edits/retry.js';
import type { RmPlanConfig } from '../rmplan/configLoader.js';

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

async function promptEnterToContinue(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question('Press Enter to continue...', () => {
      rl.close();
      resolve();
    });
  });
}

export async function handleRmprCommand(
  prIdentifierArg: string,
  options: { mode: string; yes: boolean; model?: string; dryRun: boolean },
  globalCliOptions: { debug?: boolean },
  config: RmPlanConfig
) {
  const effectiveModel =
    options.model || config?.models?.default || config?.defaultModel || DEFAULT_RUN_MODEL;

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

  log(
    `Processing PR: ${parsedIdentifier.owner}/${parsedIdentifier.repo}#${parsedIdentifier.prNumber}`
  );
  log(`  Mode: ${options.mode}`);
  log(`  Model: ${effectiveModel}`);
  if (globalCliOptions.debug) {
    debugLog(`    Model Source Breakdown:`);
    debugLog(`      CLI --model: ${options.model || 'not set'}`);
    debugLog(`      Config (models.default): ${config?.models?.default || 'not set'}`);
    debugLog(`      Config (defaultModel): ${config?.defaultModel || 'not set'}`);
    debugLog(
      `      Default Fallback: ${options.model || config?.models?.default || config?.defaultModel ? 'not used' : DEFAULT_RUN_MODEL}`
    );
  }
  log(`  Auto-confirm (--yes): ${options.yes}`);
  log(`  Dry Run (--dry-run): ${options.dryRun}`);
  if (globalCliOptions.debug) {
    debugLog(`  Global Debug Flag: true`);
  }

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

  // 1. Identify unique file paths from selected comments
  const uniqueFilePaths = Array.from(new Set(selectedComments.map((comment) => comment.path)));

  log(`Identified ${uniqueFilePaths.length} unique file paths from selected comments.`);

  const originalFilesContent = new Map<string, string>();
  const fileDiffs = new Map<string, string>();

  // 2. For each unique file path, fetch content and diff
  for (const filePath of uniqueFilePaths) {
    try {
      debugLog(`Fetching content for ${filePath} at ${headRefName}...`);
      const content = await getFileContentAtRef(filePath, headRefName);
      originalFilesContent.set(filePath, content);
    } catch (e: any) {
      error(`Failed to fetch content for ${filePath} at ${headRefName}: ${e.message}`);
      // Decide if we should continue or exit. For now, let's log and continue.
    }

    try {
      debugLog(`Fetching diff for ${filePath} between ${baseRefName} and ${headRefName}...`);
      const diff = await getDiff(filePath, baseRefName, headRefName);
      fileDiffs.set(filePath, diff);
    } catch (e: any) {
      error(
        `Failed to fetch diff for ${filePath} between ${baseRefName} and ${headRefName}: ${e.message}`
      );
    }
  }

  log(
    `Fetched content for ${originalFilesContent.size} files and diffs for ${fileDiffs.size} files.`
  );

  let llmPrompt: string;
  const filesToProcessWithAiComments = new Map<string, string>();
  const filesActuallyModifiedWithAiComments = new Set<string>();
  const gitRoot = await getGitRoot();

  if (options.mode === 'ai-comments') {
    log('Preparing context in AI Comments mode...');
    for (const [filePath, originalContent] of originalFilesContent.entries()) {
      const commentsForThisFile = selectedComments.filter((c) => c.path === filePath);
      if (commentsForThisFile.length > 0) {
        const { contentWithAiComments } = insertAiCommentsIntoFileContent(
          originalContent,
          commentsForThisFile,
          filePath
        );
        filesToProcessWithAiComments.set(filePath, contentWithAiComments);
        filesActuallyModifiedWithAiComments.add(filePath);
      } else {
        filesToProcessWithAiComments.set(filePath, originalContent);
      }
    }

    if (!options.yes && filesActuallyModifiedWithAiComments.size > 0 && !options.dryRun) {
      log(
        '\nAI comments have been prepared in the following files. Please review and make any desired edits before proceeding:'
      );
      for (const filePath of filesActuallyModifiedWithAiComments) {
        log(`  - ${filePath}`);
        try {
          const contentToWrite = filesToProcessWithAiComments.get(filePath)!;
          await secureWrite(gitRoot, filePath, contentToWrite);
        } catch (e: any) {
          error(`Failed to write AI comments to ${filePath}: ${e.message}`);
          // Potentially exit or allow user to fix manually
        }
      }
      await promptEnterToContinue();

      log('Re-reading files after user review...');
      for (const filePath of filesActuallyModifiedWithAiComments) {
        try {
          const absolutePath = path.resolve(gitRoot, filePath);
          const updatedContent = await Bun.file(absolutePath).text();
          filesToProcessWithAiComments.set(filePath, updatedContent);
        } catch (e: any) {
          error(`Failed to re-read ${filePath} after edits: ${e.message}`);
          // Potentially exit or use previous content
        }
      }
    } else if (!options.yes && filesActuallyModifiedWithAiComments.size > 0 && options.dryRun) {
      log('\n--- DRY RUN INFO ---');
      log(
        'In AI Comments mode, if not a dry run, AI comments would be written to the following files for your review before generating the final prompt:'
      );
      for (const filePath of filesActuallyModifiedWithAiComments) {
        log(`  - ${filePath}`);
      }
      log('These files have NOT been modified on disk due to --dry-run.');
      log('The prompt will be generated using the in-memory versions with AI comments.');
      debugLog('Skipping file writing and user prompt for AI comment review due to --dry-run.');
    }
    llmPrompt = createAiCommentsPrompt(filesToProcessWithAiComments, fileDiffs);
  } else {
    // Default to "separate-context" mode
    log('Preparing context in Separate Context mode...');
    const formattedComments = formatReviewCommentsForSeparateContext(selectedComments);
    llmPrompt = createSeparateContextPrompt(originalFilesContent, fileDiffs, formattedComments);
  }

  if (globalCliOptions.debug || options.dryRun) {
    const promptLines = llmPrompt.split('\n');
    if (options.dryRun) {
      log('\n--- DRY RUN MODE: LLM PROMPT ---');
      // Using console.log for the potentially very long prompt to avoid log prefixing
      console.log(llmPrompt);
      log('--- END OF DRY RUN PROMPT ---');
    } else {
      debugLog('Generated LLM Prompt (first 10 lines):');
      debugLog(promptLines.slice(0, 10).join('\n') + (promptLines.length > 10 ? '\n...' : ''));
      // Consider logging the full prompt to a file or if a specific verbose flag is set
    }
  }

  if (options.dryRun) {
    log(
      'Exiting due to --dry-run. No LLM call will be made, and no files will be modified by the LLM.'
    );
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

  if (options.mode === 'ai-comments' && filesActuallyModifiedWithAiComments.size > 0) {
    log('Cleaning up AI comment markers...');
    for (const filePath of filesActuallyModifiedWithAiComments) {
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
