import { $ } from 'bun';
import { getUsingJj } from '../../common/git.js';
import { commitAll } from '../../common/process.js';
import { log } from '../../logging.js';
import { verifyWorkspaceStillOnRef } from './workspace_roundtrip.js';

export interface SquashPlanBranchOptions {
  workspacePath: string;
  /** The plan branch or bookmark. */
  refName: string;
  /**
   * The base of the plan branch. In jj this is a revset; the squashed range is
   * `(baseRevision)..@-`. In Git this is a commit (usually the merge-base); the squashed range is
   * `baseRevision..HEAD`.
   */
  baseRevision: string;
  /** The first line of the squashed commit message. */
  title: string;
}

export type SquashPlanBranchResult =
  | { squashed: true; commitCount: number }
  | { squashed: false; reason: string };

interface RangeCommit {
  commitId: string;
  subject: string;
}

/**
 * Make the commit message for a squashed plan branch: the title, then the subjects of the
 * original commits as a list. Empty subjects, "." placeholders, and duplicates are left out.
 */
export function buildSquashCommitMessage(title: string, subjects: string[]): string {
  const trimmedTitle = title.trim();
  const seen = new Set<string>([trimmedTitle]);
  const items: string[] = [];
  for (const subject of subjects) {
    const trimmed = subject.trim();
    if (!trimmed || trimmed === '.' || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    items.push(`- ${trimmed}`);
  }

  if (items.length === 0) {
    return trimmedTitle;
  }
  return `${trimmedTitle}\n\nSquashed commits:\n${items.join('\n')}`;
}

/**
 * Squash all commits of a plan branch into one commit before the branch is published as a PR.
 *
 * Uncommitted changes are committed first so that they are included. The function does not
 * squash, and returns a reason, when the workspace is not on the plan branch, when the branch
 * has fewer than two commits, or when the history is not linear. If the squash fails or the
 * resulting tree differs from the original one, the repository is restored and the function
 * throws.
 *
 * This rewrites history. Call it only before a PR exists for the branch.
 */
export async function squashPlanBranch(
  options: SquashPlanBranchOptions
): Promise<SquashPlanBranchResult> {
  try {
    await verifyWorkspaceStillOnRef({
      executionWorkspacePath: options.workspacePath,
      refName: options.refName,
    });
  } catch (err) {
    return { squashed: false, reason: (err as Error).message };
  }

  if (await getUsingJj(options.workspacePath)) {
    return squashJj(options);
  }
  return squashGit(options);
}

async function runChecked(args: string[], cwd: string, description: string): Promise<string> {
  const result = await $`${args}`.cwd(cwd).quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Failed to ${description}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function parseRangeCommits(output: string): RangeCommit[] {
  return output
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const tab = line.indexOf('\t');
      return tab === -1
        ? { commitId: line.trim(), subject: '' }
        : { commitId: line.slice(0, tab).trim(), subject: line.slice(tab + 1) };
    });
}

async function squashJj(options: SquashPlanBranchOptions): Promise<SquashPlanBranchResult> {
  const cwd = options.workspacePath;
  const operationId = (
    await runChecked(
      ['jj', 'op', 'log', '--limit', '1', '--no-graph', '-T', 'id ++ "\\n"'],
      cwd,
      'read the jj operation log'
    )
  ).trim();

  const commitExitCode = await commitAll(options.title, cwd);
  if (commitExitCode !== 0) {
    throw new Error(`Failed to commit changes before squash (exit code ${commitExitCode}).`);
  }

  const range = `(${options.baseRevision})..@-`;
  const commits = parseRangeCommits(
    await runChecked(
      [
        'jj',
        'log',
        '-r',
        range,
        '--reversed',
        '--no-graph',
        '-T',
        'commit_id ++ "\\t" ++ description.first_line() ++ "\\n"',
      ],
      cwd,
      'list the plan branch commits'
    )
  );
  if (commits.length < 2) {
    return { squashed: false, reason: `The branch has ${commits.length} commit(s).` };
  }

  const merges = await runChecked(
    ['jj', 'log', '-r', `merges() & (${range})`, '--no-graph', '-T', 'commit_id ++ "\\n"'],
    cwd,
    'check the plan branch for merge commits'
  );
  const roots = await runChecked(
    ['jj', 'log', '-r', `roots(${range})`, '--no-graph', '-T', 'commit_id ++ "\\n"'],
    cwd,
    'find the first plan branch commit'
  );
  const rootIds = roots.split('\n').filter((line) => line.trim().length > 0);
  if (merges.trim() || rootIds.length !== 1) {
    return { squashed: false, reason: 'The branch history is not linear.' };
  }

  const rootId = rootIds[0].trim();
  const originalHead = commits[commits.length - 1].commitId;
  const message = buildSquashCommitMessage(
    options.title,
    commits.map((commit) => commit.subject)
  );

  try {
    await runChecked(
      ['jj', 'squash', '--from', `(${range}) ~ ${rootId}`, '--into', rootId, '-m', message],
      cwd,
      'squash the plan branch commits'
    );
    await runChecked(
      ['jj', 'bookmark', 'set', options.refName, '--revision', '@-', '--allow-backwards'],
      cwd,
      `move bookmark "${options.refName}" to the squashed commit`
    );
    const difference = await runChecked(
      ['jj', 'diff', '--from', originalHead, '--to', '@-', '--name-only'],
      cwd,
      'compare the squashed commit with the original branch'
    );
    if (difference.trim()) {
      throw new Error(
        `The squashed commit does not match the original branch. Changed files: ${difference.trim()}`
      );
    }
  } catch (err) {
    await $`jj op restore ${operationId}`.cwd(cwd).quiet().nothrow();
    throw err;
  }

  log(`Squashed ${commits.length} commits on "${options.refName}" into one commit.`);
  return { squashed: true, commitCount: commits.length };
}

async function squashGit(options: SquashPlanBranchOptions): Promise<SquashPlanBranchResult> {
  const cwd = options.workspacePath;
  const commitExitCode = await commitAll(options.title, cwd);
  if (commitExitCode !== 0) {
    throw new Error(`Failed to commit changes before squash (exit code ${commitExitCode}).`);
  }

  const range = `${options.baseRevision}..HEAD`;
  const commits = parseRangeCommits(
    await runChecked(
      ['git', 'log', '--reverse', '--format=%H%x09%s', range],
      cwd,
      'list the plan branch commits'
    )
  );
  if (commits.length < 2) {
    return { squashed: false, reason: `The branch has ${commits.length} commit(s).` };
  }

  const merges = await runChecked(
    ['git', 'rev-list', '--merges', range],
    cwd,
    'check the plan branch for merge commits'
  );
  if (merges.trim()) {
    return { squashed: false, reason: 'The branch history is not linear.' };
  }

  const originalHead = (await runChecked(['git', 'rev-parse', 'HEAD'], cwd, 'read HEAD')).trim();
  const originalTree = (
    await runChecked(['git', 'rev-parse', 'HEAD^{tree}'], cwd, 'read the HEAD tree')
  ).trim();
  const message = buildSquashCommitMessage(
    options.title,
    commits.map((commit) => commit.subject)
  );

  try {
    await runChecked(
      ['git', 'reset', '--soft', options.baseRevision],
      cwd,
      'reset the branch to its base'
    );
    await runChecked(
      ['git', 'commit', '--no-verify', '-m', message],
      cwd,
      'create the squashed commit'
    );
    const newTree = (
      await runChecked(['git', 'rev-parse', 'HEAD^{tree}'], cwd, 'read the squashed tree')
    ).trim();
    if (newTree !== originalTree) {
      throw new Error('The squashed commit does not match the original branch.');
    }
  } catch (err) {
    await $`git reset --soft ${originalHead}`.cwd(cwd).quiet().nothrow();
    throw err;
  }

  log(`Squashed ${commits.length} commits on "${options.refName}" into one commit.`);
  return { squashed: true, commitCount: commits.length };
}
