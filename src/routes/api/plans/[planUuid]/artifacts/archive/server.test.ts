import type { Database } from 'bun:sqlite';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { TimConfig } from '$tim/configSchema.js';
import { insertArtifact } from '$tim/db/artifact.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import {
  upsertCanonicalPlanInTransaction,
  upsertProjectionPlanInTransaction,
} from '$tim/db/plan.js';
import { getOrCreateProject } from '$tim/db/project.js';

let currentDb: Database;
let currentConfig: TimConfig;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: currentConfig,
    db: currentDb,
  }),
}));

import { GET } from './+server.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';

function makeRequest(): Request {
  return new Request(`http://localhost/api/plans/${PLAN_UUID}/artifacts/archive`);
}

function readZipEntries(zip: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  let offset = 0;

  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const filenameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const filenameStart = offset + 30;
    const dataStart = filenameStart + filenameLength + extraLength;
    const filename = zip.subarray(filenameStart, filenameStart + filenameLength).toString('utf8');
    const data = zip.subarray(dataStart, dataStart + compressedSize).toString('utf8');
    entries.set(filename, data);
    offset = dataStart + compressedSize;
  }

  return entries;
}

function insertTestArtifact(input: {
  uuid: string;
  filename: string;
  storagePath: string;
  content?: string;
  deletedAt?: string | null;
}): void {
  insertArtifact(currentDb, {
    uuid: input.uuid,
    planUuid: PLAN_UUID,
    projectUuid: PROJECT_UUID,
    filename: input.filename,
    mimeType: 'text/plain',
    size: input.content?.length ?? 10,
    sha256: input.uuid.replaceAll('-', ''),
    storagePath: input.storagePath,
    deletedAt: input.deletedAt ?? null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('/api/plans/[planUuid]/artifacts/archive GET', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tim-artifact-archive-route-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    currentConfig = {
      sync: {
        nodeId: 'archive-route-node',
        mainUrl: 'http://127.0.0.1:9',
      },
    };
    const project = getOrCreateProject(currentDb, 'repo-artifact-archive', {
      uuid: PROJECT_UUID,
      remoteUrl: 'https://example.com/repo.git',
      lastGitRoot: '/tmp/repo',
    });
    const plan = {
      uuid: PLAN_UUID,
      planId: 44,
      title: 'Archive test plan',
      status: 'pending' as const,
      revision: 1,
      forceOverwrite: true,
    };
    upsertCanonicalPlanInTransaction(currentDb, project.id, plan);
    upsertProjectionPlanInTransaction(currentDb, project.id, plan);
  });

  afterEach(() => {
    currentDb.close(false);
  });

  afterAll(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  test('returns a ZIP containing all active artifact files', async () => {
    const firstPath = path.join(tempDir, `${crypto.randomUUID()}-report.txt`);
    const secondPath = path.join(tempDir, `${crypto.randomUUID()}-trace.txt`);
    await fsp.writeFile(firstPath, 'report body');
    await fsp.writeFile(secondPath, 'trace body');
    insertTestArtifact({
      uuid: '10000000-0000-4000-8000-000000000001',
      filename: 'report.txt',
      storagePath: firstPath,
      content: 'report body',
    });
    insertTestArtifact({
      uuid: '10000000-0000-4000-8000-000000000002',
      filename: 'trace.txt',
      storagePath: secondPath,
      content: 'trace body',
    });

    const response = await GET({
      params: { planUuid: PLAN_UUID },
      request: makeRequest(),
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    expect(response.headers.get('Content-Disposition')).toContain('plan-44-artifacts.zip');
    const entries = readZipEntries(Buffer.from(await response.arrayBuffer()));
    expect(entries).toEqual(
      new Map([
        ['trace.txt', 'trace body'],
        ['report.txt', 'report body'],
      ])
    );
  });

  test('excludes soft-deleted artifacts and deduplicates filenames', async () => {
    const activeOnePath = path.join(tempDir, `${crypto.randomUUID()}-dup-a.txt`);
    const activeTwoPath = path.join(tempDir, `${crypto.randomUUID()}-dup-b.txt`);
    const deletedPath = path.join(tempDir, `${crypto.randomUUID()}-deleted.txt`);
    await fsp.writeFile(activeOnePath, 'first');
    await fsp.writeFile(activeTwoPath, 'second');
    await fsp.writeFile(deletedPath, 'deleted');
    insertTestArtifact({
      uuid: '20000000-0000-4000-8000-000000000001',
      filename: 'dup.txt',
      storagePath: activeOnePath,
      content: 'first',
    });
    insertTestArtifact({
      uuid: '20000000-0000-4000-8000-000000000002',
      filename: 'dup.txt',
      storagePath: activeTwoPath,
      content: 'second',
    });
    insertTestArtifact({
      uuid: '20000000-0000-4000-8000-000000000003',
      filename: 'deleted.txt',
      storagePath: deletedPath,
      content: 'deleted',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });

    const response = await GET({
      params: { planUuid: PLAN_UUID },
      request: makeRequest(),
    } as never);

    const entries = readZipEntries(Buffer.from(await response.arrayBuffer()));
    expect(entries).toEqual(
      new Map([
        ['dup.txt', 'second'],
        ['dup (2).txt', 'first'],
      ])
    );
  });

  test('returns 409 when an active artifact file is missing', async () => {
    insertTestArtifact({
      uuid: '30000000-0000-4000-8000-000000000001',
      filename: 'missing.txt',
      storagePath: '/nonexistent/missing-artifact.txt',
    });

    const response = await GET({
      params: { planUuid: PLAN_UUID },
      request: makeRequest(),
    } as never);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'file_missing',
      artifacts: [{ uuid: '30000000-0000-4000-8000-000000000001', filename: 'missing.txt' }],
    });
  });

  test('returns 404 for an unknown plan', async () => {
    await expect(
      GET({
        params: { planUuid: '00000000-0000-4000-8000-000000000000' },
        request: makeRequest(),
      } as never)
    ).rejects.toMatchObject({ status: 404 });
  });
});
