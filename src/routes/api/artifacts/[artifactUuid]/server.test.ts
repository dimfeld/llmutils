import type { Database } from 'bun:sqlite';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { insertArtifact } from '$tim/db/artifact.js';
import type { TimConfig } from '$tim/configSchema.js';
import { getOrCreateProject } from '$tim/db/project.js';
import {
  upsertCanonicalPlanInTransaction,
  upsertProjectionPlanInTransaction,
} from '$tim/db/plan.js';

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

function makeRequest(artifactUuid: string, init: RequestInit = {}) {
  return new Request(`http://localhost/api/artifacts/${artifactUuid}`, init);
}

function makeUrl(artifactUuid: string, query = '') {
  return new URL(`http://localhost/api/artifacts/${artifactUuid}${query}`);
}

describe('/api/artifacts/[artifactUuid] GET', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tim-artifact-download-route-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    currentConfig = {
      sync: {
        nodeId: 'download-route-node',
        mainUrl: 'http://127.0.0.1:9',
      },
    };
    const project = getOrCreateProject(currentDb, 'repo-artifact-download', {
      uuid: PROJECT_UUID,
      remoteUrl: 'https://example.com/repo.git',
      lastGitRoot: '/tmp/repo',
    });
    const plan = {
      uuid: PLAN_UUID,
      planId: 1,
      title: 'Download test plan',
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

  test('returns 404 for unknown artifact UUID', async () => {
    await expect(
      GET({
        params: { artifactUuid: '00000000-0000-4000-8000-000000000000' },
        request: makeRequest('00000000-0000-4000-8000-000000000000'),
        url: makeUrl('00000000-0000-4000-8000-000000000000'),
      } as never)
    ).rejects.toMatchObject({ status: 404 });
  });

  test('returns 410 for soft-deleted artifact', async () => {
    const uuid = '10000000-0000-4000-8000-000000000001';
    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'deleted.txt',
      mimeType: 'text/plain',
      size: 5,
      sha256: 'abc123',
      storagePath: '/nonexistent/deleted.txt',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(
      GET({
        params: { artifactUuid: uuid },
        request: makeRequest(uuid),
        url: makeUrl(uuid),
      } as never)
    ).rejects.toMatchObject({ status: 410 });
  });

  test('returns 200 for soft-deleted artifact when ?includeDeleted=1', async () => {
    const uuid = '20000000-0000-4000-8000-000000000001';
    const filePath = path.join(tempDir, 'soft-deleted.txt');
    await fsp.writeFile(filePath, 'hello');

    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'soft-deleted.txt',
      mimeType: 'text/plain',
      size: 5,
      sha256: 'aabbcc',
      storagePath: filePath,
      deletedAt: '2026-01-01T00:00:00.000Z',
    });

    const response = await GET({
      params: { artifactUuid: uuid },
      request: makeRequest(uuid),
      url: makeUrl(uuid, '?includeDeleted=1'),
    } as never);
    expect(response.status).toBe(200);
  });

  test('returns 200 with correct headers for an active artifact', async () => {
    const uuid = '30000000-0000-4000-8000-000000000001';
    const filePath = path.join(tempDir, 'report.txt');
    await fsp.writeFile(filePath, 'content');

    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'report.txt',
      mimeType: 'text/plain',
      size: 7,
      sha256: 'deadbeef',
      storagePath: filePath,
    });

    const response = await GET({
      params: { artifactUuid: uuid },
      request: makeRequest(uuid),
      url: makeUrl(uuid),
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain');
    expect(response.headers.get('Content-Length')).toBe('7');
    expect(response.headers.get('ETag')).toBe('"deadbeef"');
    expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(response.headers.get('Content-Disposition')).toMatch(/report\.txt/);
    expect(response.headers.get('Content-Disposition')).toMatch(/^attachment/);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  test('serves text artifacts inline when view mode is requested', async () => {
    const uuid = '30100000-0000-4000-8000-000000000001';
    const filePath = path.join(tempDir, 'report.md');
    await fsp.writeFile(filePath, '# Proof report\n');

    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'report.md',
      mimeType: 'text/markdown',
      size: 15,
      sha256: 'mdsha',
      storagePath: filePath,
    });

    const response = await GET({
      params: { artifactUuid: uuid },
      request: makeRequest(uuid),
      url: makeUrl(uuid, '?view=1'),
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('Content-Disposition')).toMatch(/^inline/);
  });

  test('serves code-like octet-stream artifacts as text inline in view mode', async () => {
    const uuid = '30200000-0000-4000-8000-000000000001';
    const filePath = path.join(tempDir, 'proof.ts');
    await fsp.writeFile(filePath, 'export const proof = true;\n');

    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'proof.ts',
      mimeType: 'application/octet-stream',
      size: 27,
      sha256: 'tssha',
      storagePath: filePath,
    });

    const response = await GET({
      params: { artifactUuid: uuid },
      request: makeRequest(uuid),
      url: makeUrl(uuid, '?view=1'),
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('Content-Disposition')).toMatch(/^inline/);
  });

  test('serves sql octet-stream artifacts as text inline in view mode', async () => {
    const uuid = '30200000-0000-4000-8000-000000000002';
    const filePath = path.join(tempDir, 'schema.sql');
    await fsp.writeFile(filePath, 'CREATE TABLE proof (id integer);\n');

    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'schema.sql',
      mimeType: 'application/octet-stream',
      size: 33,
      sha256: 'sqlsha',
      storagePath: filePath,
    });

    const response = await GET({
      params: { artifactUuid: uuid },
      request: makeRequest(uuid),
      url: makeUrl(uuid, '?view=1'),
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('Content-Disposition')).toMatch(/^inline/);
  });

  test('serves video artifacts inline in view mode', async () => {
    const uuid = '30300000-0000-4000-8000-000000000001';
    const filePath = path.join(tempDir, 'demo.webm');
    await fsp.writeFile(filePath, 'fake-webm');

    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'demo.webm',
      mimeType: 'video/webm',
      size: 9,
      sha256: 'webmsha',
      storagePath: filePath,
    });

    const response = await GET({
      params: { artifactUuid: uuid },
      request: makeRequest(uuid),
      url: makeUrl(uuid, '?view=1'),
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('video/webm');
    expect(response.headers.get('Content-Disposition')).toMatch(/^inline/);
  });

  test('serves SVG artifacts as attachments with nosniff', async () => {
    const uuid = '31000000-0000-4000-8000-000000000001';
    const filePath = path.join(tempDir, 'unsafe.svg');
    await fsp.writeFile(filePath, '<svg><script>alert(1)</script></svg>');

    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'unsafe.svg',
      mimeType: 'image/svg+xml',
      size: 37,
      sha256: 'svgsha',
      storagePath: filePath,
    });

    const response = await GET({
      params: { artifactUuid: uuid },
      request: makeRequest(uuid),
      url: makeUrl(uuid),
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toMatch(/^attachment/);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  test('serves PNG artifacts inline with nosniff', async () => {
    const uuid = '32000000-0000-4000-8000-000000000001';
    const filePath = path.join(tempDir, 'safe.png');
    await fsp.writeFile(filePath, 'fake-png');

    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'safe.png',
      mimeType: 'image/png',
      size: 8,
      sha256: 'pngsha',
      storagePath: filePath,
    });

    const response = await GET({
      params: { artifactUuid: uuid },
      request: makeRequest(uuid),
      url: makeUrl(uuid),
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toMatch(/^inline/);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  test('Content-Disposition uses RFC 5987 for non-ASCII filenames', async () => {
    const uuid = '40000000-0000-4000-8000-000000000001';
    const filePath = path.join(tempDir, 'pic.png');
    await fsp.writeFile(filePath, 'fake-png');

    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'Ünïcödé fïlé.png',
      mimeType: 'image/png',
      size: 8,
      sha256: 'cafebabe',
      storagePath: filePath,
    });

    const response = await GET({
      params: { artifactUuid: uuid },
      request: makeRequest(uuid),
      url: makeUrl(uuid),
    } as never);

    expect(response.status).toBe(200);
    const disposition = response.headers.get('Content-Disposition') ?? '';
    expect(disposition).toMatch(/filename\*=UTF-8''/);
    expect(disposition).toContain(encodeURIComponent('Ünïcödé fïlé.png'));
  });

  test('Content-Disposition escapes quotes in ASCII filenames', async () => {
    const uuid = '50000000-0000-4000-8000-000000000001';
    const filePath = path.join(tempDir, 'quoted.txt');
    await fsp.writeFile(filePath, 'data');

    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'say "hello".txt',
      mimeType: 'text/plain',
      size: 4,
      sha256: 'deadcafe',
      storagePath: filePath,
    });

    const response = await GET({
      params: { artifactUuid: uuid },
      request: makeRequest(uuid),
      url: makeUrl(uuid),
    } as never);

    expect(response.status).toBe(200);
    const disposition = response.headers.get('Content-Disposition') ?? '';
    // The fallback ASCII filename should have quotes escaped
    expect(disposition).toMatch(/\\"hello\\"/);
  });

  test('returns 304 when If-None-Match matches ETag', async () => {
    const uuid = '60000000-0000-4000-8000-000000000001';
    const filePath = path.join(tempDir, 'cached.txt');
    await fsp.writeFile(filePath, 'cache-content');

    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'cached.txt',
      mimeType: 'text/plain',
      size: 13,
      sha256: 'mysha256hash',
      storagePath: filePath,
    });

    const response = await GET({
      params: { artifactUuid: uuid },
      request: makeRequest(uuid, { headers: { 'if-none-match': '"mysha256hash"' } }),
      url: makeUrl(uuid),
    } as never);

    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(response.headers.get('ETag')).toBe('"mysha256hash"');
  });

  test('200 is returned when If-None-Match does not match ETag', async () => {
    const uuid = '70000000-0000-4000-8000-000000000001';
    const filePath = path.join(tempDir, 'stale.txt');
    await fsp.writeFile(filePath, 'data');

    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'stale.txt',
      mimeType: 'text/plain',
      size: 4,
      sha256: 'newsha256hash',
      storagePath: filePath,
    });

    const response = await GET({
      params: { artifactUuid: uuid },
      request: makeRequest(uuid, { headers: { 'if-none-match': '"oldsha256hash"' } }),
      url: makeUrl(uuid),
    } as never);

    expect(response.status).toBe(200);
  });

  test('returns 409 with file_missing body when row exists but file is absent', async () => {
    const uuid = '80000000-0000-4000-8000-000000000001';

    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'missing.txt',
      mimeType: 'text/plain',
      size: 10,
      sha256: 'sha256abc',
      storagePath: '/nonexistent/path/missing.txt',
    });

    const response = await GET({
      params: { artifactUuid: uuid },
      request: makeRequest(uuid),
      url: makeUrl(uuid),
    } as never);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ error: 'file_missing' });
  });

  test('returns 409 when If-None-Match matches but local file is absent', async () => {
    const uuid = '81000000-0000-4000-8000-000000000001';

    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'missing-cached.txt',
      mimeType: 'text/plain',
      size: 10,
      sha256: 'missingetag',
      storagePath: '/nonexistent/path/missing-cached.txt',
    });

    const response = await GET({
      params: { artifactUuid: uuid },
      request: makeRequest(uuid, { headers: { 'if-none-match': '"missingetag"' } }),
      url: makeUrl(uuid),
    } as never);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ error: 'file_missing' });
  });

  test('enqueues a download transfer when local file is missing and sync is configured', async () => {
    const uuid = '82000000-0000-4000-8000-000000000001';

    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'needs-transfer.txt',
      mimeType: 'text/plain',
      size: 10,
      sha256: 'transferetag',
      storagePath: '/nonexistent/path/needs-transfer.txt',
    });

    await GET({
      params: { artifactUuid: uuid },
      request: makeRequest(uuid),
      url: makeUrl(uuid),
    } as never);

    await vi.waitFor(() => {
      const row = currentDb
        .prepare(
          `
            SELECT status, direction
            FROM artifact_transfer
            WHERE artifact_uuid = ?
          `
        )
        .get(uuid) as { status: string; direction: string } | null;
      expect(row).toMatchObject({ status: 'pending', direction: 'download' });
    });
  });

  test('streams actual file content on 200', async () => {
    const uuid = '90000000-0000-4000-8000-000000000001';
    const content = 'file-body-content';
    const filePath = path.join(tempDir, 'body.txt');
    await fsp.writeFile(filePath, content);

    insertArtifact(currentDb, {
      uuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'body.txt',
      mimeType: 'text/plain',
      size: content.length,
      sha256: 'bodysha256',
      storagePath: filePath,
    });

    const response = await GET({
      params: { artifactUuid: uuid },
      request: makeRequest(uuid),
      url: makeUrl(uuid),
    } as never);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe(content);
  });
});
