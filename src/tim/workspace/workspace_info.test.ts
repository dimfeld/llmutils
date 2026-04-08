import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { recordWorkspace } from '../db/workspace.js';
import { getPreferredProjectGitRoot } from './workspace_info.js';

describe('workspace_info', () => {
  let tempDir: string;
  let db: Database;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-workspace-info-test-'));
  });

  beforeEach(() => {
    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('prefers the primary workspace path over last_git_root', () => {
    const projectId = getOrCreateProject(db, 'repo-workspace-info-primary', {
      lastGitRoot: '/tmp/last-git-root',
    }).id;

    recordWorkspace(db, {
      projectId,
      workspacePath: '/tmp/primary-workspace',
      workspaceType: 'primary',
    });

    expect(getPreferredProjectGitRoot(db, projectId)).toBe('/tmp/primary-workspace');
  });

  test('falls back to last_git_root when no primary workspace exists', () => {
    const projectId = getOrCreateProject(db, 'repo-workspace-info-fallback', {
      lastGitRoot: '/tmp/last-git-root-fallback',
    }).id;

    expect(getPreferredProjectGitRoot(db, projectId)).toBe('/tmp/last-git-root-fallback');
  });
});
