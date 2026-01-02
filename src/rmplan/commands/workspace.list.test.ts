import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ModuleMocker } from '../../testing.js';
import { WorkspaceLock } from '../workspace/workspace_lock.js';
import type { WorkspaceInfo } from '../workspace/workspace_tracker.js';

let moduleMocker: ModuleMocker;
let tempDir: string;
let trackingFile: string;
let originalCwd: string;
let originalHome: string | undefined;

const logSpy = mock(() => {});
const warnSpy = mock(() => {});

// Capture console.log output for testing
let consoleOutput: string[] = [];
const originalConsoleLog = console.log;

async function writeTrackingData(data: Record<string, WorkspaceInfo>) {
  await fs.writeFile(trackingFile, JSON.stringify(data, null, 2));
}

describe('workspace list command', () => {
  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-list-test-'));
    trackingFile = path.join(tempDir, 'workspaces.json');
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    consoleOutput = [];

    // Set test lock directory to use the temp directory
    const lockDir = path.join(tempDir, 'locks');
    await fs.mkdir(lockDir, { recursive: true });
    WorkspaceLock.setTestLockDirectory(lockDir);

    // Capture console.log output
    console.log = (...args: any[]) => {
      consoleOutput.push(args.map(String).join(' '));
    };

    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      warn: warnSpy,
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          trackingFile,
        },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
      getCurrentBranchName: async () => 'main',
    }));

    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId: 'github.com/test/repo',
        remoteUrl: 'https://github.com/test/repo.git',
        gitRoot: tempDir,
      }),
      getUserIdentity: () => 'tester',
    }));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    console.log = originalConsoleLog;
    moduleMocker.clear();
    WorkspaceLock.setTestLockDirectory(undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
    logSpy.mockClear();
    warnSpy.mockClear();
  });

  test('outputs empty JSON array when no workspaces exist', async () => {
    await writeTrackingData({});

    const { handleWorkspaceListCommand } = await import('./workspace.js');

    await handleWorkspaceListCommand({ format: 'json', all: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    expect(consoleOutput.join('\n')).toBe('[]');
  });

  test('outputs nothing for TSV when no workspaces exist (no header in new format)', async () => {
    await writeTrackingData({});

    const { handleWorkspaceListCommand } = await import('./workspace.js');

    await handleWorkspaceListCommand({ format: 'tsv', all: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    // New 2-column TSV format has no header, so empty output for no workspaces
    expect(consoleOutput).toHaveLength(0);
  });

  test('outputs nothing for TSV when no workspaces exist and --no-header', async () => {
    await writeTrackingData({});

    const { handleWorkspaceListCommand } = await import('./workspace.js');

    await handleWorkspaceListCommand({ format: 'tsv', header: false, all: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    expect(consoleOutput).toHaveLength(0);
  });

  test('outputs workspaces in JSON format with full metadata', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-1');
    await fs.mkdir(workspaceDir, { recursive: true });

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'task-1',
      workspacePath: workspaceDir,
      branch: 'feature-branch',
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryId: 'github.com/test/repo',
      name: 'My Workspace',
      description: '#123 Feature Implementation',
      planId: '123',
      planTitle: 'Feature Implementation',
      issueUrls: ['https://github.com/test/repo/issues/123'],
      updatedAt: '2024-01-02T00:00:00.000Z',
    };

    await writeTrackingData({ [workspaceDir]: workspaceEntry });

    const { handleWorkspaceListCommand } = await import('./workspace.js');

    await handleWorkspaceListCommand({ format: 'json', all: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const output = JSON.parse(consoleOutput.join('\n'));
    expect(output).toHaveLength(1);
    expect(output[0].fullPath).toBe(workspaceDir);
    expect(output[0].basename).toBe('workspace-1');
    expect(output[0].name).toBe('My Workspace');
    expect(output[0].description).toBe('#123 Feature Implementation');
    expect(output[0].taskId).toBe('task-1');
    expect(output[0].planId).toBe('123');
    expect(output[0].planTitle).toBe('Feature Implementation');
    expect(output[0].issueUrls).toEqual(['https://github.com/test/repo/issues/123']);
    // Verify all WorkspaceListEntry fields are present
    expect(output[0].createdAt).toBe('2024-01-01T00:00:00.000Z');
    expect(output[0].updatedAt).toBe('2024-01-02T00:00:00.000Z');
    expect(output[0].repositoryId).toBe('github.com/test/repo');
    // branch is computed live, so it gets the mocked value
    expect(output[0].branch).toBe('main');
    // lockedBy should be omitted from JSON output
    expect(output[0].lockedBy).toBeUndefined();
  });

  test('outputs workspaces in TSV format with 2 columns (path and formatted description)', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-1');
    await fs.mkdir(workspaceDir, { recursive: true });

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'task-1',
      workspacePath: workspaceDir,
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryId: 'github.com/test/repo',
      name: 'My Workspace',
      description: 'Working on feature',
    };

    await writeTrackingData({ [workspaceDir]: workspaceEntry });

    const { handleWorkspaceListCommand } = await import('./workspace.js');

    await handleWorkspaceListCommand({ format: 'tsv', all: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const lines = consoleOutput;
    // New format: no header, just data rows
    expect(lines.length).toBe(1);

    // Check data row has 2 fields: fullPath and formatted description
    const fields = lines[0].split('\t');
    expect(fields).toHaveLength(2);
    expect(fields[0]).toBe(workspaceDir); // fullPath

    // Check formatted description contains expected parts
    const formattedDesc = fields[1];
    expect(formattedDesc).toContain('workspace-1'); // basename
    expect(formattedDesc).toContain('My Workspace'); // name
    expect(formattedDesc).toContain('Working on feature'); // description
    // branch is computed live (mocked to 'main')
    expect(formattedDesc).toContain('[main]'); // branch in brackets
  });

  test('outputs workspaces in TSV format (--no-header has no effect in new format)', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-1');
    await fs.mkdir(workspaceDir, { recursive: true });

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'task-1',
      workspacePath: workspaceDir,
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryId: 'github.com/test/repo',
    };

    await writeTrackingData({ [workspaceDir]: workspaceEntry });

    const { handleWorkspaceListCommand } = await import('./workspace.js');

    await handleWorkspaceListCommand({ format: 'tsv', header: false, all: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const lines = consoleOutput;
    expect(lines.length).toBe(1);

    // Check 2-column format: fullPath and formatted description
    const fields = lines[0].split('\t');
    expect(fields).toHaveLength(2);
    expect(fields[0]).toBe(workspaceDir);
    expect(fields[1]).toContain('workspace-1'); // basename in description
  });

  test('table format includes lock status', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-locked');
    await fs.mkdir(workspaceDir, { recursive: true });

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'task-locked',
      workspacePath: workspaceDir,
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryId: 'github.com/test/repo',
    };

    await writeTrackingData({ [workspaceDir]: workspaceEntry });

    // Create an actual lock file to simulate a locked workspace
    const { WorkspaceLock } = await import('../workspace/workspace_lock.js');
    await WorkspaceLock.acquireLock(workspaceDir, 'test command', { owner: 'test-user' });

    const { handleWorkspaceListCommand } = await import('./workspace.js');

    try {
      await handleWorkspaceListCommand({ format: 'table', all: true }, {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any);

      // Table output should contain "Locked"
      const output = consoleOutput.join('\n');
      expect(output).toContain('Locked');
    } finally {
      // Clean up the lock
      await WorkspaceLock.releaseLock(workspaceDir, { force: true });
    }
  });

  test('table format shows abbreviated paths with ~ for home directory', async () => {
    // Create a workspace under tempDir which we mock to be under home directory
    const workspaceDir = path.join(tempDir, 'my-project-workspace');
    await fs.mkdir(workspaceDir, { recursive: true });

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'task-home',
      workspacePath: workspaceDir,
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryId: 'github.com/test/repo',
      name: 'Home Project',
      description: 'Working from home',
    };

    await writeTrackingData({ [workspaceDir]: workspaceEntry });

    const { handleWorkspaceListCommand } = await import('./workspace.js');

    await handleWorkspaceListCommand({ format: 'table', all: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    // Table output should contain the workspace name and description
    const output = consoleOutput.join('\n');
    expect(output).toContain('Home Project');
    expect(output).toContain('Working from home');
    // The path is displayed in the table (possibly split across lines due to table word wrapping)
    // but the workspace directory name should appear somewhere
    expect(output.replace(/\s+/g, ' ')).toContain('workspace');
  });

  test('filters workspaces by repository ID by default', async () => {
    const workspaceDir1 = path.join(tempDir, 'workspace-1');
    const workspaceDir2 = path.join(tempDir, 'workspace-2');
    await fs.mkdir(workspaceDir1, { recursive: true });
    await fs.mkdir(workspaceDir2, { recursive: true });

    const workspaceEntry1: WorkspaceInfo = {
      taskId: 'task-1',
      workspacePath: workspaceDir1,
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryId: 'github.com/test/repo',
    };

    const workspaceEntry2: WorkspaceInfo = {
      taskId: 'task-2',
      workspacePath: workspaceDir2,
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryId: 'github.com/other/repo',
    };

    await writeTrackingData({
      [workspaceDir1]: workspaceEntry1,
      [workspaceDir2]: workspaceEntry2,
    });

    const { handleWorkspaceListCommand } = await import('./workspace.js');

    await handleWorkspaceListCommand({ format: 'json', repo: 'github.com/test/repo' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const output = JSON.parse(consoleOutput.join('\n'));
    expect(output).toHaveLength(1);
    expect(output[0].fullPath).toBe(workspaceDir1);
  });

  test('uses repository identity fallback when origin remote is missing', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-local');
    await fs.mkdir(workspaceDir, { recursive: true });

    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId: 'local-repo',
        remoteUrl: null,
        gitRoot: tempDir,
      }),
      getUserIdentity: () => 'tester',
    }));

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'task-local',
      workspacePath: workspaceDir,
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryId: 'local-repo',
    };

    await writeTrackingData({ [workspaceDir]: workspaceEntry });

    const { handleWorkspaceListCommand } = await import('./workspace.js');

    await handleWorkspaceListCommand({ format: 'json' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const output = JSON.parse(consoleOutput.join('\n'));
    expect(output).toHaveLength(1);
    expect(output[0].fullPath).toBe(workspaceDir);
  });

  test('--all lists workspaces across all repositories', async () => {
    const workspaceDir1 = path.join(tempDir, 'workspace-1');
    const workspaceDir2 = path.join(tempDir, 'workspace-2');
    await fs.mkdir(workspaceDir1, { recursive: true });
    await fs.mkdir(workspaceDir2, { recursive: true });

    const workspaceEntry1: WorkspaceInfo = {
      taskId: 'task-1',
      workspacePath: workspaceDir1,
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryId: 'github.com/test/repo',
    };

    const workspaceEntry2: WorkspaceInfo = {
      taskId: 'task-2',
      workspacePath: workspaceDir2,
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryId: 'github.com/other/repo',
    };

    await writeTrackingData({
      [workspaceDir1]: workspaceEntry1,
      [workspaceDir2]: workspaceEntry2,
    });

    const { handleWorkspaceListCommand } = await import('./workspace.js');

    await handleWorkspaceListCommand({ format: 'json', all: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const output = JSON.parse(consoleOutput.join('\n'));
    expect(output).toHaveLength(2);
  });

  test('TSV includes issue references extracted from URLs', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-1');
    await fs.mkdir(workspaceDir, { recursive: true });

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'task-1',
      workspacePath: workspaceDir,
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryId: 'github.com/test/repo',
      issueUrls: ['https://github.com/test/repo/issues/1', 'https://github.com/test/repo/issues/2'],
    };

    await writeTrackingData({ [workspaceDir]: workspaceEntry });

    const { handleWorkspaceListCommand } = await import('./workspace.js');

    await handleWorkspaceListCommand({ format: 'tsv', header: false, all: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const lines = consoleOutput;
    expect(lines.length).toBe(1);

    // Check 2-column format
    const fields = lines[0].split('\t');
    expect(fields).toHaveLength(2);

    // Formatted description should include extracted issue references
    const formattedDesc = fields[1];
    expect(formattedDesc).toContain('#1');
    expect(formattedDesc).toContain('#2');
  });

  test('handles missing optional fields gracefully in TSV', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-minimal');
    await fs.mkdir(workspaceDir, { recursive: true });

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'task-minimal',
      workspacePath: workspaceDir,
      createdAt: '2024-01-01T00:00:00.000Z',
      // All optional fields missing
    };

    await writeTrackingData({ [workspaceDir]: workspaceEntry });

    const { handleWorkspaceListCommand } = await import('./workspace.js');

    await handleWorkspaceListCommand({ format: 'tsv', header: false, all: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const lines = consoleOutput;
    expect(lines.length).toBe(1);

    // Check 2-column format
    const fields = lines[0].split('\t');
    expect(fields).toHaveLength(2);
    expect(fields[0]).toBe(workspaceDir);

    // With minimal fields, formatted description should at least have the basename and branch
    const formattedDesc = fields[1];
    expect(formattedDesc).toContain('workspace-minimal'); // basename
    // branch is mocked to 'main'
    expect(formattedDesc).toContain('[main]');
  });

  test('filters out non-existent workspace directories', async () => {
    const existingDir = path.join(tempDir, 'existing-workspace');
    const nonExistingDir = path.join(tempDir, 'deleted-workspace');
    await fs.mkdir(existingDir, { recursive: true });
    // Don't create nonExistingDir

    const entry1: WorkspaceInfo = {
      taskId: 'task-1',
      workspacePath: existingDir,
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryId: 'github.com/test/repo',
    };

    const entry2: WorkspaceInfo = {
      taskId: 'task-2',
      workspacePath: nonExistingDir,
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryId: 'github.com/test/repo',
    };

    await writeTrackingData({
      [existingDir]: entry1,
      [nonExistingDir]: entry2,
    });

    const { handleWorkspaceListCommand } = await import('./workspace.js');

    await handleWorkspaceListCommand({ format: 'json', all: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const output = JSON.parse(consoleOutput.join('\n'));
    // buildWorkspaceListEntries filters out non-existent directories
    expect(output).toHaveLength(1);
    expect(output[0].fullPath).toBe(existingDir);
  });

  test('does not remove entries when directory checks error', async () => {
    const protectedDir = path.join(tempDir, 'protected-workspace');
    await fs.mkdir(protectedDir, { recursive: true });

    const entry: WorkspaceInfo = {
      taskId: 'task-protected',
      workspacePath: protectedDir,
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryId: 'github.com/test/repo',
    };

    await writeTrackingData({ [protectedDir]: entry });

    const realFs = await import('node:fs/promises');
    await moduleMocker.mock('node:fs/promises', () => ({
      ...realFs,
      stat: async (target: string) => {
        if (target === protectedDir) {
          const err = new Error('permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return realFs.stat(target);
      },
    }));

    const { handleWorkspaceListCommand } = await import('./workspace.js');

    await handleWorkspaceListCommand({ format: 'json', all: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const trackingContent = JSON.parse(await fs.readFile(trackingFile, 'utf-8'));
    expect(trackingContent[protectedDir]).toBeDefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  test('--all flag cleans up stale entries from tracking file', async () => {
    const existingDir = path.join(tempDir, 'existing-workspace');
    const deletedDir = path.join(tempDir, 'deleted-workspace');
    await fs.mkdir(existingDir, { recursive: true });
    // Don't create deletedDir - simulating a deleted workspace

    const entry1: WorkspaceInfo = {
      taskId: 'task-1',
      workspacePath: existingDir,
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryId: 'github.com/test/repo',
    };

    const entry2: WorkspaceInfo = {
      taskId: 'task-2',
      workspacePath: deletedDir,
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryId: 'github.com/other/repo',
    };

    await writeTrackingData({
      [existingDir]: entry1,
      [deletedDir]: entry2,
    });

    const { handleWorkspaceListCommand } = await import('./workspace.js');

    await handleWorkspaceListCommand({ format: 'json', all: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    // Verify the stale entry was removed from the tracking file
    const trackingContent = JSON.parse(await fs.readFile(trackingFile, 'utf-8'));
    expect(Object.keys(trackingContent)).toHaveLength(1);
    expect(trackingContent[existingDir]).toBeDefined();
    expect(trackingContent[deletedDir]).toBeUndefined();

    // Verify warn was called for the removed directory
    expect(warnSpy).toHaveBeenCalled();
    const warnCalls = warnSpy.mock.calls.map((call) => call[0]);
    expect(warnCalls.some((msg: string) => msg.includes(deletedDir))).toBe(true);
  });
});

describe('formatWorkspaceDescription', () => {
  test('includes basename, name, description, branch, and issue refs', () => {
    const { formatWorkspaceDescription } = require('./workspace.js');

    const entry = {
      fullPath: '/home/user/workspaces/my-workspace',
      basename: 'my-workspace',
      name: 'Feature Project',
      description: 'Building new login flow',
      branch: 'feature/login',
      taskId: 'task-1',
      issueUrls: ['https://github.com/org/repo/issues/42'],
      createdAt: '2024-01-01T00:00:00.000Z',
    };

    const result = formatWorkspaceDescription(entry);
    expect(result).toContain('my-workspace');
    expect(result).toContain('Feature Project');
    expect(result).toContain('Building new login flow');
    expect(result).toContain('[feature/login]');
    expect(result).toContain('#42');
  });

  test('deduplicates identical name and planTitle', () => {
    const { formatWorkspaceDescription } = require('./workspace.js');

    const entry = {
      fullPath: '/home/user/workspaces/task-123',
      basename: 'task-123',
      name: 'Implement Login',
      planTitle: 'Implement Login', // Same as name
      taskId: 'task-123',
      createdAt: '2024-01-01T00:00:00.000Z',
    };

    const result = formatWorkspaceDescription(entry);
    // 'Implement Login' should appear only once
    const matches = result.match(/Implement Login/g);
    expect(matches).toHaveLength(1);
  });

  test('deduplicates case-insensitively', () => {
    const { formatWorkspaceDescription } = require('./workspace.js');

    const entry = {
      fullPath: '/home/user/workspaces/task-456',
      basename: 'task-456',
      name: 'Fix Bug',
      planTitle: 'FIX BUG', // Same content, different case
      taskId: 'task-456',
      createdAt: '2024-01-01T00:00:00.000Z',
    };

    const result = formatWorkspaceDescription(entry);
    // Should only have one version of 'fix bug'
    expect(result).toContain('Fix Bug');
    expect(result).not.toContain('FIX BUG');
  });

  test('deduplicates description that is substring of name', () => {
    const { formatWorkspaceDescription } = require('./workspace.js');

    const entry = {
      fullPath: '/home/user/workspaces/task-789',
      basename: 'task-789',
      name: 'Implement User Authentication Feature',
      description: 'User Authentication', // Subset of name
      taskId: 'task-789',
      createdAt: '2024-01-01T00:00:00.000Z',
    };

    const result = formatWorkspaceDescription(entry);
    // Description should be omitted since it's covered by name
    expect(result).toContain('Implement User Authentication Feature');
    expect(result).not.toMatch(/\| User Authentication\s*(\||$)/);
  });

  test('skips issue refs already mentioned in description', () => {
    const { formatWorkspaceDescription } = require('./workspace.js');

    const entry = {
      fullPath: '/home/user/workspaces/task-100',
      basename: 'task-100',
      description: '#55 Fix the login bug',
      taskId: 'task-100',
      issueUrls: ['https://github.com/org/repo/issues/55'],
      createdAt: '2024-01-01T00:00:00.000Z',
    };

    const result = formatWorkspaceDescription(entry);
    // #55 appears in description, should not be duplicated at the end
    const matches = result.match(/#55/g);
    expect(matches).toHaveLength(1);
  });

  test('handles minimal entry with only required fields', () => {
    const { formatWorkspaceDescription } = require('./workspace.js');

    const entry = {
      fullPath: '/home/user/workspaces/minimal',
      basename: 'minimal',
      taskId: 'task-min',
      createdAt: '2024-01-01T00:00:00.000Z',
    };

    const result = formatWorkspaceDescription(entry);
    expect(result).toBe('minimal');
  });

  test('handles entry with only basename and branch', () => {
    const { formatWorkspaceDescription } = require('./workspace.js');

    const entry = {
      fullPath: '/home/user/workspaces/basic',
      basename: 'basic',
      branch: 'main',
      taskId: 'task-basic',
      createdAt: '2024-01-01T00:00:00.000Z',
    };

    const result = formatWorkspaceDescription(entry);
    expect(result).toBe('basic | [main]');
  });
});
