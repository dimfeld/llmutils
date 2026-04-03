import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getOrCreateProject } from '$tim/db/project.js';

import { emitPrUpdatesForIngestResult, getProjectIdsForPrUrls } from './pr_event_utils.js';

describe('pr_event_utils', () => {
  let tempDir: string;
  let db: Database;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-pr-event-utils-test-'));
  });

  beforeEach(() => {
    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
  });

  afterEach(() => {
    db.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('getProjectIdsForPrUrls resolves matching project ids from canonical PR URLs', () => {
    const projectA = getOrCreateProject(db, 'github.com__example__repo');
    const projectB = getOrCreateProject(db, 'github.com__example__other');

    expect(
      getProjectIdsForPrUrls(db, [
        'https://github.com/example/repo/pull/17',
        'https://github.com/example/other/pull/23',
        'https://github.com/example/repo/pull/99',
      ])
    ).toEqual([projectA.id, projectB.id]);
  });

  test('getProjectIdsForPrUrls ignores invalid or unmapped URLs', () => {
    getOrCreateProject(db, 'github.com__example__repo');

    expect(
      getProjectIdsForPrUrls(db, [
        'https://github.com/example/repo/issues/17',
        'https://gitlab.com/example/repo/pull/23',
        'not-a-url',
        'https://github.com/example/missing/pull/1',
      ])
    ).toEqual([]);
  });

  test('getProjectIdsForPrUrls returns only mapped project ids from mixed URL sets', () => {
    const project = getOrCreateProject(db, 'github.com__example__repo');

    expect(
      getProjectIdsForPrUrls(db, [
        'https://github.com/example/repo/pull/17',
        'https://github.com/example/repo/pull/99',
        'https://github.com/example/missing/pull/1',
        'https://github.com/example/repo/issues/17',
      ])
    ).toEqual([project.id]);
  });

  test('emitPrUpdatesForIngestResult emits resolved project ids for updated PRs', () => {
    const project = getOrCreateProject(db, 'github.com__example__repo');
    const sessionManager = {
      emitPrUpdate: vi.fn(),
      hasPrUpdateListeners: () => true,
    };

    emitPrUpdatesForIngestResult(
      db,
      {
        eventsIngested: 2,
        prsUpdated: ['https://github.com/example/repo/pull/17'],
        errors: [],
      },
      sessionManager
    );

    expect(sessionManager.emitPrUpdate).toHaveBeenCalledWith(
      ['https://github.com/example/repo/pull/17'],
      [project.id]
    );
  });

  test('emitPrUpdatesForIngestResult skips empty updates', () => {
    const sessionManager = {
      emitPrUpdate: vi.fn(),
      hasPrUpdateListeners: () => true,
    };

    emitPrUpdatesForIngestResult(
      db,
      {
        eventsIngested: 0,
        prsUpdated: [],
        errors: [],
      },
      sessionManager
    );

    expect(sessionManager.emitPrUpdate).not.toHaveBeenCalled();
  });

  test('emitPrUpdatesForIngestResult skips DB lookup when no listeners', () => {
    getOrCreateProject(db, 'github.com__example__repo');
    const sessionManager = {
      emitPrUpdate: vi.fn(),
      hasPrUpdateListeners: () => false,
    };

    emitPrUpdatesForIngestResult(
      db,
      {
        eventsIngested: 1,
        prsUpdated: ['https://github.com/example/repo/pull/17'],
        errors: [],
      },
      sessionManager
    );

    expect(sessionManager.emitPrUpdate).not.toHaveBeenCalled();
  });
});
