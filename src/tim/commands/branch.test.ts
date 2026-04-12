import { beforeEach, describe, expect, test, vi, afterEach, afterAll, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writePlanFile } from '../plans.js';
import { closeDatabaseForTesting, DATABASE_FILENAME, openDatabase } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import {
  generateBranchNameFromPlan,
  handleBranchCommand,
  normalizeBranchPrefix,
  resolveBranchPrefix,
} from './branch.js';
import { isValidBranchPrefix } from '../branch_prefix.js';
import * as databaseModule from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import * as projectSettingsModule from '../db/project_settings.js';
import { setProjectSetting } from '../db/project_settings.js';
import type { Database } from 'bun:sqlite';
import * as planDiscoveryModule from './plan_discovery.js';
import * as planRepoRootModule from '../plan_repo_root.js';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  writeStdout: vi.fn(),
  debugLog: vi.fn(),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

import { log as logFn, writeStdout as writeStdoutFn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import * as planMaterialize from '../plan_materialize.js';

const logSpy = vi.mocked(logFn);
const writeStdoutSpy = vi.mocked(writeStdoutFn);

describe('generateBranchNameFromPlan', () => {
  test('uses id and slugified title when available', () => {
    const name = generateBranchNameFromPlan({
      id: 123,
      title: 'Implement OAuth Login',
      goal: 'Add OAuth login support',
      status: 'pending',
      tasks: [],
    });

    expect(name).toBe('123-implement-oauth-login');
  });

  test('falls back to task-id when title slug is empty', () => {
    const name = generateBranchNameFromPlan({
      id: 42,
      title: '!!!',
      goal: '...',
      status: 'pending',
      tasks: [],
    });

    expect(name).toBe('42');
  });

  test('adds Linear issue id to branch name when present', () => {
    const name = generateBranchNameFromPlan({
      id: 123,
      title: 'Implement OAuth Login',
      goal: 'Add OAuth login support',
      status: 'pending',
      issue: ['https://linear.app/my-org/issue/DF-1471'],
      tasks: [],
    });

    expect(name).toBe('123-implement-oauth-login-df-1471');
  });

  test('adds GitHub issue id to branch name when present', () => {
    const name = generateBranchNameFromPlan({
      id: 123,
      title: 'Implement OAuth Login',
      goal: 'Add OAuth login support',
      status: 'pending',
      issue: ['https://github.com/owner/repo/issues/1471'],
      tasks: [],
    });

    expect(name).toBe('123-implement-oauth-login-gh-1471');
  });

  test('truncates slug to keep branch names at or under 63 characters', () => {
    const name = generateBranchNameFromPlan({
      id: 123,
      title:
        'This is a very long plan title that keeps going and going and going forever and should be truncated',
      goal: 'This is a very long plan title that keeps going',
      status: 'pending',
      issue: ['https://github.com/owner/repo/issues/1471'],
      tasks: [],
    });

    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith('123-')).toBe(true);
    expect(name.includes('-gh-1471')).toBe(true);
    expect(name.endsWith('-gh-1471')).toBe(true);
  });
});

describe('generateBranchNameFromPlan with branchPrefix', () => {
  test('prepends prefix to generated branch name', () => {
    const name = generateBranchNameFromPlan(
      {
        id: 123,
        title: 'Implement OAuth Login',
        goal: 'Add OAuth login support',
        status: 'pending',
        tasks: [],
      },
      { branchPrefix: 'di/' }
    );

    expect(name).toBe('di/123-implement-oauth-login');
  });

  test('empty prefix behaves like no prefix', () => {
    const nameWithEmpty = generateBranchNameFromPlan(
      {
        id: 123,
        title: 'Implement OAuth Login',
        status: 'pending',
        tasks: [],
      },
      { branchPrefix: '' }
    );
    const nameWithoutOption = generateBranchNameFromPlan({
      id: 123,
      title: 'Implement OAuth Login',
      status: 'pending',
      tasks: [],
    });

    expect(nameWithEmpty).toBe('123-implement-oauth-login');
    expect(nameWithoutOption).toBe('123-implement-oauth-login');
  });

  test('prefix is included in the 63-character limit', () => {
    const name = generateBranchNameFromPlan(
      {
        id: 123,
        title:
          'This is a very long plan title that keeps going and going and going forever and should be truncated',
        status: 'pending',
        tasks: [],
      },
      { branchPrefix: 'di/' }
    );

    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith('di/123-')).toBe(true);
  });

  test('prefix is included in the 63-char limit with issue id', () => {
    const name = generateBranchNameFromPlan(
      {
        id: 123,
        title:
          'This is a very long plan title that keeps going and going and going forever and should be truncated',
        status: 'pending',
        issue: ['https://github.com/owner/repo/issues/1471'],
        tasks: [],
      },
      { branchPrefix: 'di/' }
    );

    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith('di/123-')).toBe(true);
    expect(name.endsWith('-gh-1471')).toBe(true);
  });

  test('very long prefix still produces a result within 63 chars', () => {
    const longPrefix = 'very-long-team-name/';
    const name = generateBranchNameFromPlan(
      {
        id: 1,
        title: 'Some plan title',
        status: 'pending',
        tasks: [],
      },
      { branchPrefix: longPrefix }
    );

    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith(longPrefix)).toBe(true);
  });

  test('throws when prefix is too long to allow any generated branch segment', () => {
    const tooLongPrefix = 'a'.repeat(63);
    expect(() =>
      generateBranchNameFromPlan(
        {
          id: 123,
          title: 'Implement OAuth Login',
          status: 'pending',
          tasks: [],
        },
        { branchPrefix: tooLongPrefix }
      )
    ).toThrow('Branch prefix');
  });

  test('no options parameter maintains backward compatibility', () => {
    const name = generateBranchNameFromPlan({
      id: 7,
      title: 'Fix search filters',
      status: 'pending',
      tasks: [],
    });

    expect(name).toBe('7-fix-search-filters');
  });
});

describe('normalizeBranchPrefix', () => {
  test('undefined returns empty string', () => {
    expect(normalizeBranchPrefix(undefined)).toBe('');
  });

  test('empty string returns empty string', () => {
    expect(normalizeBranchPrefix('')).toBe('');
  });

  test('whitespace-only string returns empty string', () => {
    expect(normalizeBranchPrefix('  ')).toBe('');
  });

  test('prefix without separator gets slash appended', () => {
    expect(normalizeBranchPrefix('di')).toBe('di/');
  });

  test('prefix already ending with slash is unchanged', () => {
    expect(normalizeBranchPrefix('di/')).toBe('di/');
  });

  test('prefix already ending with dash is unchanged', () => {
    expect(normalizeBranchPrefix('feature-')).toBe('feature-');
  });

  test('prefix already ending with underscore is unchanged', () => {
    expect(normalizeBranchPrefix('ns_')).toBe('ns_');
  });

  test('trims surrounding whitespace before checking separator', () => {
    expect(normalizeBranchPrefix('  di  ')).toBe('di/');
  });

  test('trims whitespace but keeps trailing separator', () => {
    expect(normalizeBranchPrefix('  di/  ')).toBe('di/');
  });

  test('throws when prefix contains whitespace', () => {
    expect(() => normalizeBranchPrefix('team name')).toThrow('Invalid branch prefix');
  });

  test('throws when prefix contains unsupported git-ref characters', () => {
    expect(() => normalizeBranchPrefix('foo:bar')).toThrow('Invalid branch prefix');
    expect(() => normalizeBranchPrefix('feat?x')).toThrow('Invalid branch prefix');
    expect(() => normalizeBranchPrefix('feat[1]')).toThrow('Invalid branch prefix');
    expect(() => normalizeBranchPrefix('feat\\x')).toThrow('Invalid branch prefix');
    expect(() => normalizeBranchPrefix('feat~x')).toThrow('Invalid branch prefix');
    expect(() => normalizeBranchPrefix('feat^x')).toThrow('Invalid branch prefix');
    expect(() => normalizeBranchPrefix('feat*x')).toThrow('Invalid branch prefix');
  });

  test('throws when prefix contains double-dot', () => {
    expect(() => normalizeBranchPrefix('foo..bar')).toThrow('Invalid branch prefix');
  });

  test('throws when prefix starts with dash', () => {
    expect(() => normalizeBranchPrefix('-x')).toThrow('Invalid branch prefix');
  });

  test('throws when prefix starts with dot', () => {
    expect(() => normalizeBranchPrefix('.x')).toThrow('Invalid branch prefix');
  });

  test('throws when prefix starts with slash', () => {
    expect(() => normalizeBranchPrefix('/foo')).toThrow('Invalid branch prefix');
  });

  test('throws when prefix contains consecutive slashes', () => {
    expect(() => normalizeBranchPrefix('foo//bar')).toThrow('Invalid branch prefix');
  });

  test('throws when prefix contains @{', () => {
    expect(() => normalizeBranchPrefix('feat@{x')).toThrow('Invalid branch prefix');
  });

  test('accepts bare @ since @/x is a valid git ref', () => {
    expect(normalizeBranchPrefix('@')).toBe('@/');
  });

  test('accepts prefix ending with dot since foo./x is a valid git ref', () => {
    expect(normalizeBranchPrefix('foo.')).toBe('foo./');
  });

  test('throws when prefix contains .lock', () => {
    expect(() => normalizeBranchPrefix('foo.lock')).toThrow('Invalid branch prefix');
    expect(() => normalizeBranchPrefix('foo.lock/bar')).toThrow('Invalid branch prefix');
  });

  test('throws when path component starts with dot', () => {
    expect(() => normalizeBranchPrefix('foo/.bar')).toThrow('Invalid branch prefix');
  });

  test('throws when prefix contains SOH control character (\\x01)', () => {
    expect(() => normalizeBranchPrefix('foo\x01bar')).toThrow('Invalid branch prefix');
  });

  test('throws when prefix contains DEL character (\\x7f)', () => {
    expect(() => normalizeBranchPrefix('foo\x7fbar')).toThrow('Invalid branch prefix');
  });

  test('throws when prefix contains NUL character (\\x00)', () => {
    expect(() => normalizeBranchPrefix('foo\x00bar')).toThrow('Invalid branch prefix');
  });
});

describe('isValidBranchPrefix', () => {
  test('returns true for valid prefix di/', () => {
    expect(isValidBranchPrefix('di/')).toBe(true);
  });

  test('returns true for valid prefix feature-', () => {
    expect(isValidBranchPrefix('feature-')).toBe(true);
  });

  test('returns false for prefix with tab character (\\x09)', () => {
    expect(isValidBranchPrefix('\tprefix')).toBe(false);
  });

  test('returns false for prefix with SOH control character (\\x01)', () => {
    expect(isValidBranchPrefix('foo\x01bar')).toBe(false);
  });

  test('returns false for prefix with DEL character (\\x7f)', () => {
    expect(isValidBranchPrefix('foo\x7fbar')).toBe(false);
  });

  test('returns false for prefix with NUL character (\\x00)', () => {
    expect(isValidBranchPrefix('foo\x00bar')).toBe(false);
  });

  test('returns false for prefix with US control character (\\x1f)', () => {
    expect(isValidBranchPrefix('foo\x1fbar')).toBe(false);
  });

  test('returns false for prefix with space', () => {
    expect(isValidBranchPrefix('foo bar')).toBe(false);
  });

  test('returns false for prefix with backslash', () => {
    expect(isValidBranchPrefix('foo\\bar')).toBe(false);
  });

  test('returns true for prefix with ] (git only bans [, not ])', () => {
    expect(isValidBranchPrefix('foo]')).toBe(true);
  });

  test('returns false for prefix with [', () => {
    expect(isValidBranchPrefix('foo[')).toBe(false);
  });
});

describe('resolveBranchPrefix', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-branch-prefix-test-'));
  });

  beforeEach(() => {
    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    projectId = getOrCreateProject(db, 'test-repo-branch-prefix', {
      remoteUrl: 'https://example.com/test-repo.git',
      lastGitRoot: '/tmp/test-repo',
    }).id;
  });

  afterEach(() => {
    db.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('returns empty string when neither config nor DB setting is set', () => {
    const result = resolveBranchPrefix({ config: {}, db, projectId });
    expect(result).toBe('');
  });

  test('uses config value when no DB setting exists', () => {
    const result = resolveBranchPrefix({
      config: { branchPrefix: 'di' },
      db,
      projectId,
    });
    expect(result).toBe('di/');
  });

  test('normalizes config value', () => {
    const result = resolveBranchPrefix({
      config: { branchPrefix: 'feature/' },
      db,
      projectId,
    });
    expect(result).toBe('feature/');
  });

  test('DB project setting takes precedence over config value', () => {
    setProjectSetting(db, projectId, 'branchPrefix', 'team');

    const result = resolveBranchPrefix({
      config: { branchPrefix: 'config-prefix' },
      db,
      projectId,
    });
    expect(result).toBe('team/');
  });

  test('DB project setting is normalized', () => {
    setProjectSetting(db, projectId, 'branchPrefix', 'di/');

    const result = resolveBranchPrefix({ config: {}, db, projectId });
    expect(result).toBe('di/');
  });

  test('empty string DB setting falls back to config', () => {
    setProjectSetting(db, projectId, 'branchPrefix', '');

    const result = resolveBranchPrefix({ config: { branchPrefix: 'fallback' }, db, projectId });
    // Empty string DB setting is treated as unset, so config fallback applies
    expect(result).toBe('fallback/');
  });
});

describe('handleBranchCommand', () => {
  let tempDir: string;
  let repoDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    closeDatabaseForTesting();
    clearPlanSyncContext();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-branch-test-'));
    repoDir = path.join(tempDir, 'repo');
    tasksDir = path.join(repoDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, '.tim.yml'), 'paths:\n  tasks: tasks\n');

    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      paths: {
        tasks: tasksDir,
      },
    } as any);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('writes branch name for selected plan by id', async () => {
    const plan = {
      id: 7,
      title: 'Fix search filters',
      goal: 'Fix search filters',
      status: 'pending',
      tasks: [],
    };
    await writePlanFile(path.join(tasksDir, '7.yml'), plan, { cwdForIdentity: process.cwd() });

    const command = { parent: { opts: () => ({}) } } as any;
    await handleBranchCommand('7', {}, command);

    expect(writeStdoutSpy).toHaveBeenCalledWith('7-fix-search-filters\n');
  });

  test('uses explicit plan.branch without resolving branch prefix', async () => {
    const resolveProjectContextSpy = vi.spyOn(planMaterialize, 'resolveProjectContext');
    resolveProjectContextSpy.mockRejectedValue(
      new Error('resolveProjectContext should not be called for explicit branches')
    );

    const plan = {
      id: 7,
      title: 'Fix search filters',
      branch: 'explicit-branch-name',
      goal: 'Fix search filters',
      status: 'pending',
      tasks: [],
    };
    await writePlanFile(path.join(tasksDir, '7.yml'), plan, { cwdForIdentity: process.cwd() });

    const command = { parent: { opts: () => ({}) } } as any;
    await handleBranchCommand('7', {}, command);

    expect(writeStdoutSpy).toHaveBeenCalledWith('explicit-branch-name\n');
    expect(resolveProjectContextSpy).not.toHaveBeenCalled();
    resolveProjectContextSpy.mockRestore();
  });

  test('applies branchPrefix from config when generating branch name', async () => {
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      paths: {
        tasks: tasksDir,
      },
      branchPrefix: 'di/',
    } as any);

    const plan = {
      id: 7,
      title: 'Fix search filters',
      goal: 'Fix search filters',
      status: 'pending',
      tasks: [],
    };
    await writePlanFile(path.join(tasksDir, '7.yml'), plan, { cwdForIdentity: process.cwd() });

    const resolveProjectContextSpy = vi
      .spyOn(planMaterialize, 'resolveProjectContext')
      .mockResolvedValue({ projectId: 123 } as any);
    const getDatabaseSpy = vi.spyOn(databaseModule, 'getDatabase');
    const getProjectSettingSpy = vi
      .spyOn(projectSettingsModule, 'getProjectSetting')
      .mockReturnValue(undefined);

    try {
      const command = { parent: { opts: () => ({}) } } as any;
      await handleBranchCommand('7', {}, command);

      expect(writeStdoutSpy).toHaveBeenCalledWith('di/7-fix-search-filters\n');
    } finally {
      resolveProjectContextSpy.mockRestore();
      getDatabaseSpy.mockRestore();
      getProjectSettingSpy.mockRestore();
    }
  });

  test('supports --latest selection', async () => {
    const older = {
      id: 10,
      title: 'Older plan',
      goal: 'Older plan',
      status: 'pending',
      updatedAt: '2098-01-01T00:00:00.000Z',
      tasks: [],
    };
    const newer = {
      id: 11,
      title: 'Latest plan',
      goal: 'Latest plan',
      status: 'pending',
      updatedAt: '2099-02-01T00:00:00.000Z',
      tasks: [],
    };
    await writePlanFile(path.join(tasksDir, '10.yml'), older, {
      cwdForIdentity: process.cwd(),
      skipUpdatedAt: true,
    });
    await writePlanFile(path.join(tasksDir, '11.yml'), newer, {
      cwdForIdentity: process.cwd(),
      skipUpdatedAt: true,
    });

    const command = { parent: { opts: () => ({}) } } as any;
    await handleBranchCommand(undefined, { latest: true }, command);

    expect(writeStdoutSpy).toHaveBeenCalledWith('11-latest-plan\n');
    expect(logSpy).not.toHaveBeenCalled();
  });

  test('throws when no plan or selection flags are provided', async () => {
    const command = { parent: { opts: () => ({}) } } as any;
    await expect(handleBranchCommand(undefined, {}, command)).rejects.toThrow(
      'Please provide a plan file or use --latest/--next/--current/--next-ready to find a plan'
    );
  });

  test('--next-ready with numeric parent ID returns branch name of first ready child plan', async () => {
    // Parent plan: id=200
    const parentPlan = {
      id: 200,
      title: 'Parent Epic',
      goal: 'Parent Epic',
      status: 'pending' as const,
      tasks: [],
    };
    // Child plan: id=201, depends on parent via parent field
    const childPlan = {
      id: 201,
      title: 'Child Task',
      goal: 'Child Task',
      status: 'pending' as const,
      parent: 200,
      tasks: [],
    };

    await writePlanFile(path.join(tasksDir, '200.yml'), parentPlan, {
      cwdForIdentity: process.cwd(),
    });
    await writePlanFile(path.join(tasksDir, '201.yml'), childPlan, {
      cwdForIdentity: process.cwd(),
    });

    const command = { parent: { opts: () => ({}) } } as any;
    await handleBranchCommand(undefined, { nextReady: '200' }, command);

    expect(writeStdoutSpy).toHaveBeenCalledWith('201-child-task\n');
  });

  test('--next-ready with numeric parent ID and --config resolves repo root from config', async () => {
    const crossRepoRoot = '/fake/cross-repo';
    const configPath = '/path/to/other-repo/tim.yml';

    const resolveRepoRootSpy = vi
      .spyOn(planRepoRootModule, 'resolveRepoRoot')
      .mockResolvedValue(crossRepoRoot);

    const findNextReadySpy = vi
      .spyOn(planDiscoveryModule, 'findNextReadyDependencyFromDb')
      .mockResolvedValue({
        plan: {
          id: 301,
          title: 'Cross repo task',
          goal: 'Cross repo task',
          status: 'pending',
          tasks: [],
        },
        message: 'found',
      });

    const resolveProjectContextSpy = vi
      .spyOn(planMaterialize, 'resolveProjectContext')
      .mockResolvedValue({ projectId: 999 } as any);

    const getProjectSettingSpy = vi
      .spyOn(projectSettingsModule, 'getProjectSetting')
      .mockReturnValue(undefined);

    try {
      const command = { parent: { opts: () => ({ config: configPath }) } } as any;
      await handleBranchCommand(undefined, { nextReady: '300' }, command);

      // resolveRepoRoot should be called with the config path and a fallback dir
      expect(resolveRepoRootSpy).toHaveBeenCalledWith(configPath, expect.any(String));

      // findNextReadyDependencyFromDb should use the resolved cross-repo root, not the caller's root
      expect(findNextReadySpy).toHaveBeenCalledWith(300, crossRepoRoot, crossRepoRoot, true);

      expect(writeStdoutSpy).toHaveBeenCalledWith('301-cross-repo-task\n');
    } finally {
      resolveRepoRootSpy.mockRestore();
      findNextReadySpy.mockRestore();
      resolveProjectContextSpy.mockRestore();
      getProjectSettingSpy.mockRestore();
    }
  });
});
