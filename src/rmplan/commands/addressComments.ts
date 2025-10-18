import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { loadEffectiveConfig } from '../configLoader.js';
import { getGitRoot, getTrunkBranch, hasUncommittedChanges } from '../../common/git.js';
import { secureWrite } from '../../common/fs.js';
import { log } from '../../logging.js';
import { commitAll, logSpawn } from '../../common/process.js';
import { removeAiCommentMarkers } from '../../rmpr/modes/hybrid_context.js';
import type { Executor, ExecutorCommonOptions } from '../executors/types.js';
import { buildExecutorAndLog, DEFAULT_EXECUTOR } from '../executors/index.js';

interface AddressCommentsOptions {
  baseBranch?: string;
  executor?: string;
  model?: string;
  commit?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

interface CleanupOptions {
  yes?: boolean;
}

interface PromptOptions {
  baseBranch: string;
  paths: string[];
  filePathPrefix?: string;
}

const AI_COMMENT_PATTERNS = ['AI:', 'AI_COMMENT_START', 'AI_COMMENT_END', 'AI (id:'];

export async function handleAddressCommentsCommand(
  paths: string[] | undefined,
  options: AddressCommentsOptions,
  command: Command
) {
  const globalOpts = command.parent?.opts?.() ?? {};
  const config = await loadEffectiveConfig(globalOpts.config);
  const gitRoot = await getGitRoot();
  const normalizedPaths = normalizePathFilters(paths ?? [], gitRoot);

  const baseBranch = options.baseBranch || (await getTrunkBranch(gitRoot));
  log(chalk.gray(`Using base branch ${chalk.cyan(baseBranch)} for comparisons.`));

  const executorName = options.executor || config.defaultExecutor || DEFAULT_EXECUTOR;
  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: gitRoot,
    model: options.model,
    interactive: false,
  };

  const executor = buildExecutorAndLog(executorName, sharedExecutorOptions, config);

  const prompt = createAddressCommentsPrompt({
    baseBranch,
    paths: normalizedPaths,
    filePathPrefix: executor.filePathPrefix,
  });

  if (options.dryRun) {
    log(chalk.cyan('\n## Dry Run - Address Comments Prompt\n'));
    log(prompt);
    log(chalk.gray('\n--dry-run mode: would execute the above prompt with the selected executor.'));
    return;
  }

  await runExecutor(executor, prompt);

  await smartCleanupAiCommentMarkers(gitRoot, normalizedPaths, { yes: options.yes });

  if (options.commit) {
    await commitAddressedComments(gitRoot);
  }
}

export async function handleCleanupCommentsCommand(
  paths: string[] | undefined,
  options: CleanupOptions,
  _command: Command
) {
  const gitRoot = await getGitRoot();
  const normalizedPaths = normalizePathFilters(paths ?? [], gitRoot);

  const filesWithMarkers = await findFilesWithAiComments(gitRoot, normalizedPaths);
  if (filesWithMarkers.length === 0) {
    log(chalk.green('No AI comment markers found.'));
    return;
  }

  log(chalk.cyan(`Found ${filesWithMarkers.length} file(s) containing AI comment markers:`));
  filesWithMarkers.forEach((file) => log(`  - ${file}`));

  const shouldCleanup =
    options.yes ||
    (await confirm({
      message: 'Remove AI comment markers from these files?',
      default: true,
    }));

  if (!shouldCleanup) {
    log(chalk.yellow('Cleanup cancelled. AI comment markers remain in place.'));
    return;
  }

  const cleanedCount = await cleanupAiCommentMarkers(gitRoot, normalizedPaths);
  if (cleanedCount === 0) {
    log(chalk.yellow('No files required changes; markers may have been removed already.'));
  } else {
    log(chalk.green(`Removed AI comment markers from ${cleanedCount} file(s).`));
  }
}

export function createAddressCommentsPrompt({
  baseBranch,
  paths,
  filePathPrefix,
}: PromptOptions): string {
  const scopeSection =
    paths.length > 0
      ? `\n## Search Scope\n\nOnly operate within the following paths:\n${paths
          .map((p) => `- ${filePathPrefix ? `${filePathPrefix}${p}` : p}`)
          .join('\n')}\n`
      : '';

  const prefixReminder = filePathPrefix
    ? `When using tools that require file paths, prefix paths with \`${filePathPrefix}\` (for example \`${filePathPrefix}${paths[0] ?? 'path/to/file'}\`).`
    : 'Use repository-relative paths when invoking tools.';

  const joinedPaths = paths.length > 0 ? paths.map((p) => `"${p}"`).join(' ') : '<paths>';
  const ripgrepCommand =
    paths.length > 0
      ? `rg --line-number --fixed-strings -e "AI:" -e "AI_COMMENT_START" -e "AI_COMMENT_END" -e "AI (id:" ${joinedPaths}`
      : 'rg --line-number --fixed-strings -e "AI:" -e "AI_COMMENT_START" -e "AI_COMMENT_END" -e "AI (id:"';

  return `You are addressing review comments that already exist inside the repository's source files.

## Responsibilities

1. **Locate AI Comments**: Search ${
    paths.length > 0 ? 'the specified paths' : 'the repository'
  } for AI review comment markers. Look for any of these markers:
   - Single-line comments such as \`// AI: ...\`, \`# AI: ...\`, \`-- AI: ...\`, or \`<!-- AI: ... -->\`
   - Block markers \`AI_COMMENT_START\` / \`AI_COMMENT_END\`
2. **Understand Context**: Inspect the surrounding code to understand the intent behind each comment. When additional context is needed, diff against the \`${baseBranch}\` branch.
3. **Implement Fixes**: Apply focused changes that resolve the raised concerns without altering unrelated code.
4. **Remove Markers**: After addressing each comment, delete the corresponding AI comment lines and any start/end markers.
5. **Validate**: Run type checking, linting, and tests. Ensure existing tests continue to pass and add new ones only when necessary to cover the fixes.
6. **Double Check**: Before finishing, make sure you have seen all AI comments.

Block comments are used when a review comment applies to multiple lines of code, to make it easier to see which code is being referenced. A single line comment may also apply to multiple lines of code; you infer from the comment and surrounding code what is desired. In both cases, consider all relevant information to make the proper change--your changes can update other related code if that is appropriate.

${prefixReminder}

${scopeSection}## Base Branch Reference

Diff against \`${baseBranch}\` whenever you need the original code context. If you require additional information, gather it using the available repo tools rather than asking for more input.`;
}

export async function findFilesWithAiComments(gitRoot: string, paths: string[]): Promise<string[]> {
  const searchPaths = paths.length ? paths.map((p) => path.resolve(gitRoot, p)) : [gitRoot];

  const args = [
    '--files-with-matches',
    '--fixed-strings',
    ...AI_COMMENT_PATTERNS.flatMap((pattern) => ['-e', pattern]),
    '--hidden',
    '--glob',
    '!.git/*',
    '--glob',
    '!.jj/*',
  ];

  const proc = logSpawn(['rg', ...args, ...searchPaths], {
    cwd: gitRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdoutText = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0 && exitCode !== 1) {
    const stderrText = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    throw new Error(`ripgrep failed while searching for AI comments:\n${stderrText}`);
  }

  if (!stdoutText.trim()) {
    return [];
  }

  const files = stdoutText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((file) => path.relative(gitRoot, path.resolve(gitRoot, file)));

  return Array.from(new Set(files)).sort();
}

export async function cleanupAiCommentMarkers(gitRoot: string, paths: string[]): Promise<number> {
  const files = await findFilesWithAiComments(gitRoot, paths);
  let cleanedCount = 0;

  for (const relativePath of files) {
    const absolutePath = path.resolve(gitRoot, relativePath);
    const content = await readFile(absolutePath, 'utf-8');
    const cleaned = removeAiCommentMarkers(content, relativePath);
    if (cleaned !== content) {
      await secureWrite(gitRoot, relativePath, cleaned);
      cleanedCount++;
    }
  }

  return cleanedCount;
}

export async function smartCleanupAiCommentMarkers(
  gitRoot: string,
  paths: string[],
  options: CleanupOptions = {}
): Promise<void> {
  const filesWithMarkers = await findFilesWithAiComments(gitRoot, paths);

  if (filesWithMarkers.length === 0) {
    log(chalk.green('All AI comment markers have been removed.'));
    return;
  }

  log(chalk.yellow(`Found ${filesWithMarkers.length} file(s) with remaining AI comment markers:`));
  filesWithMarkers.forEach((file) => log(`  - ${file}`));

  const shouldCleanup =
    options.yes ||
    (await confirm({
      message: 'Remove remaining AI comment markers now?',
      default: true,
    }));

  if (!shouldCleanup) {
    log(chalk.yellow('Skipped cleanup. AI comment markers remain in the repository.'));
    return;
  }

  const cleanedCount = await cleanupAiCommentMarkers(gitRoot, paths);
  if (cleanedCount === 0) {
    log(chalk.yellow('No additional files required cleanup.'));
  } else {
    log(chalk.green(`Removed AI comment markers from ${cleanedCount} file(s).`));
  }
}

export async function commitAddressedComments(gitRoot: string): Promise<void> {
  if (!(await hasUncommittedChanges(gitRoot))) {
    log(chalk.gray('No changes detected after addressing comments; skipping commit.'));
    return;
  }

  const message = 'Address review comments';
  const exitCode = await commitAll(message, gitRoot);
  if (exitCode === 0) {
    log(chalk.green(`Committed changes with message: "${message}"`));
  } else {
    log(
      chalk.yellow(
        `Commit command exited with code ${exitCode}. Please verify the repository state.`
      )
    );
  }
}

function normalizePathFilters(paths: string[], gitRoot: string): string[] {
  const results = new Set<string>();

  for (const rawPath of paths) {
    const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);

    const relativePath = path.relative(gitRoot, absolute);
    if (relativePath.startsWith('..')) {
      throw new Error(`Path "${rawPath}" is outside of the repository root.`);
    }

    const normalized = relativePath === '' ? '.' : relativePath;
    if (normalized !== '.') {
      results.add(normalized);
    }
  }

  return Array.from(results).sort();
}

async function runExecutor(executor: Executor, prompt: string): Promise<void> {
  await executor.execute(prompt, {
    planId: 'address-comments',
    planTitle: 'Address AI Review Comments',
    planFilePath: '',
    executionMode: 'review',
  });
}
