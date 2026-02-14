import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../../testing.js';
import { addPermission } from '../../db/permission.js';
import { closeDatabaseForTesting, getDatabase } from '../../db/database.js';
import { getOrCreateProject } from '../../db/project.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('runClaudeSubprocess shared permissions DB integration', () => {
  let tempDir: string;
  let configDir: string;
  let repoDir: string;
  let originalEnv: Partial<Record<string, string>>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-claude-subprocess-db-test-'));
    configDir = path.join(tempDir, 'config');
    repoDir = path.join(tempDir, 'repo');

    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(repoDir, { recursive: true });

    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = configDir;
    delete process.env.APPDATA;
    closeDatabaseForTesting();
  });

  afterEach(async () => {
    moduleMocker.clear();
    closeDatabaseForTesting();
    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }
    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('includes DB shared allow permissions in subprocess --allowedTools', async () => {
    const repositoryId = 'repo-with-shared-permissions';
    const sharedTool = 'Bash(custom-shared-command:*)';

    const db = getDatabase();
    const project = getOrCreateProject(db, repositoryId);
    addPermission(db, project.id, 'allow', sharedTool);

    let spawnedArgs: string[] | null = null;

    await moduleMocker.mock('../../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId,
        remoteUrl: 'https://example.com/repo.git',
        gitRoot: repoDir,
      }),
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      createLineSplitter: () => (value: string) => value.split('\n').filter(Boolean),
      spawnWithStreamingIO: mock(async (args: string[]) => {
        spawnedArgs = args;
        return {
          stdin: {
            write: mock(() => {}),
            end: mock(async () => {}),
          },
          result: Promise.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
            signal: null,
            killedByInactivity: false,
          }),
          kill: mock(() => {}),
        };
      }),
    }));

    await moduleMocker.mock('./streaming_input.js', () => ({
      sendSinglePromptAndWait: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        signal: null,
        killedByInactivity: false,
      }),
    }));

    const { runClaudeSubprocess } = await import('./run_claude_subprocess.js');

    await runClaudeSubprocess({
      prompt: 'test prompt',
      cwd: repoDir,
      label: 'test',
      noninteractive: true,
      claudeCodeOptions: {
        includeDefaultTools: false,
      },
      processFormattedMessages: () => {},
    });

    expect(spawnedArgs).not.toBeNull();
    const allowedToolsIndex = spawnedArgs!.indexOf('--allowedTools');
    expect(allowedToolsIndex).toBeGreaterThan(-1);
    expect(spawnedArgs![allowedToolsIndex + 1]).toContain(sharedTool);
  });
});
