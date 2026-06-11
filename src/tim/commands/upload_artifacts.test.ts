import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { buildServer } from '../../media-host/server.js';
import type { MediaHostConfig } from '../../media-host/server.js';
import { clearAllTimCaches } from '../../testing.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { insertArtifact } from '../db/artifact.js';
import { writePlanToDb } from '../plans.js';
import { handleUploadArtifactsCommand } from './upload_artifacts.js';
import {
  findPullRequestCommentByMarker,
  postPullRequestComment,
  updatePullRequestComment,
} from '../../common/github/pull_requests.js';
import { log, warn } from '../../logging.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { gatherPrContext } from '../utils/pr_context_gathering.js';
import { getPrStatusForPlan } from '../db/pr_status.js';
import { buildPlanArtifactsCommentMarker } from './upload_artifacts_comment.js';

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(),
}));

vi.mock('../../common/github/pull_requests.js', () => ({
  findPullRequestCommentByMarker: vi.fn(),
  postPullRequestComment: vi.fn(),
  updatePullRequestComment: vi.fn(),
}));

vi.mock('../configLoader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../configLoader.js')>();
  return {
    ...actual,
    loadEffectiveConfig: vi.fn(),
  };
});

vi.mock('../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(async (options: { callback: () => Promise<void> }) =>
    options.callback()
  ),
  updateHeadlessSessionInfo: vi.fn(),
}));

vi.mock('../utils/pr_context_gathering.js', () => ({
  gatherPrContext: vi.fn(),
  resolvePrUrl: vi.fn(),
  checkoutPrBranch: vi.fn(),
}));

vi.mock('../db/pr_status.js', () => ({
  getPrStatusForPlan: vi.fn(),
  getLinkedPlansByPrUrl: vi.fn(),
}));

// ── Typed mocks ────────────────────────────────────────────────────────────────

const mockLog = vi.mocked(log);
const mockWarn = vi.mocked(warn);
const mockIsTunnelActive = vi.mocked(isTunnelActive);
const mockFindPullRequestCommentByMarker = vi.mocked(findPullRequestCommentByMarker);
const mockPostPullRequestComment = vi.mocked(postPullRequestComment);
const mockUpdatePullRequestComment = vi.mocked(updatePullRequestComment);
const mockLoadEffectiveConfig = vi.mocked(loadEffectiveConfig);
const mockRunWithHeadlessAdapterIfEnabled = vi.mocked(runWithHeadlessAdapterIfEnabled);
const mockGatherPrContext = vi.mocked(gatherPrContext);
const mockGetPrStatusForPlan = vi.mocked(getPrStatusForPlan);

// ── Constants ──────────────────────────────────────────────────────────────────

const API_KEY = 'test-upload-api-key';
const SIGNING_SECRET = 'test-signing-secret';

const PLAN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLAN_ID = 1;
const PROJECT_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const OPEN_PR_CONTEXT = {
  prStatus: { id: 99, title: 'My PR', author: 'alice', state: 'open' },
  prUrl: 'https://github.com/acme/repo/pull/42',
  prNumber: 42,
  owner: 'acme',
  repo: 'repo',
  baseBranch: 'main',
  headBranch: 'feature/test',
  headSha: 'abc123',
} as any;

// ── Test suite ─────────────────────────────────────────────────────────────────

describe('handleUploadArtifactsCommand', () => {
  let tempDir: string;
  let artifactsDir: string;
  let originalCwd: string = process.cwd();
  let savedXdgDataHome: string | undefined;
  let savedMediaHostApiKey: string | undefined;
  let server: ReturnType<typeof buildServer>;
  let baseUrl: string;

  function makeRootCommand(): { parent: { opts: () => { config?: string } } } {
    return { parent: { opts: () => ({ config: undefined }) } };
  }

  /** Insert a minimal plan artifact row and write a real file to storagePath. */
  async function createArtifact(options: {
    filename: string;
    mimeType: string;
    content: string;
    message?: string | null;
    deletedAt?: string | null;
  }) {
    const db = getDatabase();
    const artifactUuid = randomUUID();
    const storagePath = path.join(artifactsDir, artifactUuid, options.filename);
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, options.content, 'utf8');
    insertArtifact(db, {
      uuid: artifactUuid,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: options.filename,
      mimeType: options.mimeType,
      size: Buffer.byteLength(options.content),
      sha256: '0000000000000000000000000000000000000000000000000000000000000000',
      message: options.message ?? null,
      storagePath,
      deletedAt: options.deletedAt ?? null,
    });
    return { artifactUuid, storagePath };
  }

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    vi.clearAllMocks();

    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-upload-artifacts-test-'));
    artifactsDir = path.join(tempDir, 'artifacts');
    await fs.mkdir(artifactsDir, { recursive: true });

    savedXdgDataHome = process.env.XDG_DATA_HOME;
    savedMediaHostApiKey = process.env.MEDIA_HOST_API_KEY;
    process.env.XDG_DATA_HOME = tempDir;
    process.env.MEDIA_HOST_API_KEY = API_KEY;

    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/test/upload-test.git`
      .cwd(tempDir)
      .quiet();

    process.chdir(tempDir);

    // Write plan to DB
    await writePlanToDb(
      {
        id: PLAN_ID,
        uuid: PLAN_UUID,
        title: 'Upload CLI test plan',
        goal: 'Test the upload command',
        details: 'Testing upload artifacts CLI',
        status: 'in_progress',
        tasks: [],
        dependencies: [],
        issue: [],
        docs: [],
        tags: [],
        epic: false,
        temp: false,
        pullRequest: ['https://github.com/acme/repo/pull/42'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { cwdForIdentity: tempDir, skipUpdatedAt: true }
    );

    // Start loopback media host
    const config: MediaHostConfig = {
      port: 0,
      host: '127.0.0.1',
      storageDir: path.join(tempDir, 'media-store'),
      apiKey: API_KEY,
      signingSecret: SIGNING_SECRET,
      maxUploadBytes: 10 * 1024 * 1024,
    };
    server = buildServer(config);
    baseUrl = `http://127.0.0.1:${server.port}`;

    // Default mock values
    mockIsTunnelActive.mockReturnValue(false);
    mockLoadEffectiveConfig.mockResolvedValue({
      mediaHost: { baseUrl },
    } as any);
    mockGatherPrContext.mockResolvedValue(OPEN_PR_CONTEXT);
    mockGetPrStatusForPlan.mockReturnValue([]);
    mockFindPullRequestCommentByMarker.mockResolvedValue(null);
    mockPostPullRequestComment.mockResolvedValue({
      id: 111,
      htmlUrl: 'https://github.com/acme/repo/pull/42#issuecomment-111',
    });
    mockUpdatePullRequestComment.mockResolvedValue({
      id: 222,
      htmlUrl: 'https://github.com/acme/repo/pull/42#issuecomment-222',
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    clearAllTimCaches();
    closeDatabaseForTesting();

    if (savedXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = savedXdgDataHome;
    }
    if (savedMediaHostApiKey === undefined) {
      delete process.env.MEDIA_HOST_API_KEY;
    } else {
      process.env.MEDIA_HOST_API_KEY = savedMediaHostApiKey;
    }

    await server.stop(true);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ── Guard: requires plan ID ────────────────────────────────────────────────

  test('throws when no plan ID is provided', async () => {
    await expect(handleUploadArtifactsCommand(undefined, {}, makeRootCommand())).rejects.toThrow(
      'A numeric plan ID is required'
    );
  });

  // ── Guard: not configured ──────────────────────────────────────────────────

  test('logs a clear message and returns when mediaHost is not configured', async () => {
    mockLoadEffectiveConfig.mockResolvedValue({} as any);

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    expect(mockLog).toHaveBeenCalledWith(
      'Media host is not configured (set mediaHost.baseUrl and the MEDIA_HOST_API_KEY env var).'
    );
    expect(mockPostPullRequestComment).not.toHaveBeenCalled();
    expect(mockUpdatePullRequestComment).not.toHaveBeenCalled();
  });

  test('logs and returns when MEDIA_HOST_API_KEY is absent', async () => {
    delete process.env.MEDIA_HOST_API_KEY;

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    expect(mockLog).toHaveBeenCalledWith(
      'Media host is not configured (set mediaHost.baseUrl and the MEDIA_HOST_API_KEY env var).'
    );
    expect(mockPostPullRequestComment).not.toHaveBeenCalled();
  });

  // ── Guard: no uploadable artifacts ────────────────────────────────────────

  test('logs "Nothing to upload" and returns when there are no artifacts', async () => {
    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    expect(mockLog).toHaveBeenCalledWith(`Nothing to upload for plan ${PLAN_ID}.`);
    expect(mockPostPullRequestComment).not.toHaveBeenCalled();
  });

  test('logs "Nothing to upload" when all artifacts are soft-deleted', async () => {
    await createArtifact({
      filename: 'screenshot.png',
      mimeType: 'image/png',
      content: 'fake-image',
      deletedAt: new Date().toISOString(),
    });

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    expect(mockLog).toHaveBeenCalledWith(`Nothing to upload for plan ${PLAN_ID}.`);
    expect(mockPostPullRequestComment).not.toHaveBeenCalled();
  });

  // ── Guard: no linked PR ────────────────────────────────────────────────────

  test('throws when there are artifacts but no resolvable linked PR', async () => {
    await createArtifact({ filename: 'screenshot.png', mimeType: 'image/png', content: 'img' });

    // Plan has a pullRequest URL in schema, but gatherPrContext throws
    mockGatherPrContext.mockRejectedValue(new Error('Cannot resolve PR'));

    await expect(handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand())).rejects.toThrow();
  });

  test('throws when linked PR is closed (not open)', async () => {
    await createArtifact({ filename: 'screenshot.png', mimeType: 'image/png', content: 'img' });

    mockGatherPrContext.mockResolvedValue({
      ...OPEN_PR_CONTEXT,
      prStatus: { ...OPEN_PR_CONTEXT.prStatus, state: 'closed' },
    });

    await expect(handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand())).rejects.toThrow(
      /no open linked pull requests/i
    );
    expect(mockPostPullRequestComment).not.toHaveBeenCalled();
  });

  // ── Happy path: first post ─────────────────────────────────────────────────

  test('uploads artifacts and posts a new PR comment on first run', async () => {
    await createArtifact({
      filename: 'screenshot.png',
      mimeType: 'image/png',
      content: 'fake-png-bytes',
    });
    await createArtifact({
      filename: 'log.txt',
      mimeType: 'text/plain',
      content: 'log content',
    });

    mockFindPullRequestCommentByMarker.mockResolvedValue(null);

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    // findPullRequestCommentByMarker called with per-plan marker, no authToken
    const marker = buildPlanArtifactsCommentMarker(PLAN_UUID);
    expect(mockFindPullRequestCommentByMarker).toHaveBeenCalledWith('acme', 'repo', 42, marker);
    // postPullRequestComment called with no authToken
    expect(mockPostPullRequestComment).toHaveBeenCalledWith(
      'acme',
      'repo',
      42,
      expect.stringContaining(marker)
    );
    // comment body includes artifact links/embeds
    const body = mockPostPullRequestComment.mock.calls[0][3] as string;
    expect(body).toContain('screenshot.png');
    expect(body).toContain('log.txt');
    // update NOT called
    expect(mockUpdatePullRequestComment).not.toHaveBeenCalled();
  });

  test('artifacts are actually uploaded to the loopback media host and signed URLs resolve', async () => {
    await createArtifact({
      filename: 'screenshot.png',
      mimeType: 'image/png',
      content: 'fake-png-bytes',
    });

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    const body = mockPostPullRequestComment.mock.calls[0][3] as string;
    // Extract the first URL from the body (it's a signed URL starting with baseUrl)
    const urlMatch = body.match(new RegExp(`(${baseUrl}/[^)\\s]+)`));
    expect(urlMatch).toBeTruthy();

    const signedUrl = urlMatch![1]!;
    const response = await fetch(signedUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('fake-png-bytes');
  });

  // ── Happy path: update existing ────────────────────────────────────────────

  test('updates the existing PR comment when a marked comment already exists', async () => {
    await createArtifact({ filename: 'screenshot.png', mimeType: 'image/png', content: 'img' });

    const existingCommentId = 555;
    mockFindPullRequestCommentByMarker.mockResolvedValue({
      id: existingCommentId,
      htmlUrl: 'https://github.com/acme/repo/pull/42#issuecomment-555',
    });

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    expect(mockUpdatePullRequestComment).toHaveBeenCalledWith(
      'acme',
      'repo',
      existingCommentId,
      expect.stringContaining(buildPlanArtifactsCommentMarker(PLAN_UUID))
    );
    expect(mockPostPullRequestComment).not.toHaveBeenCalled();
  });

  test('re-run uses the same deterministic media path (idempotent URLs)', async () => {
    await createArtifact({ filename: 'screenshot.png', mimeType: 'image/png', content: 'v1' });

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());
    const body1 = mockPostPullRequestComment.mock.calls[0][3] as string;
    const url1Match = body1.match(new RegExp(`(${baseUrl}/[^)\\s]+)`));
    const url1 = url1Match![1]!;

    // Second run with update
    mockFindPullRequestCommentByMarker.mockResolvedValue({ id: 111, htmlUrl: '' });
    vi.clearAllMocks();
    mockFindPullRequestCommentByMarker.mockResolvedValue({ id: 111, htmlUrl: '' });
    mockUpdatePullRequestComment.mockResolvedValue({ id: 111, htmlUrl: '' });

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());
    const body2 = mockUpdatePullRequestComment.mock.calls[0][3] as string;
    const url2Match = body2.match(new RegExp(`(${baseUrl}/[^)\\s]+)`));
    const url2 = url2Match![1]!;

    // The path part (before ?sig=) must be identical
    expect(url1.split('?')[0]).toBe(url2.split('?')[0]);
  });

  // ── report.md handling ─────────────────────────────────────────────────────

  test('report.md content is used as comment body and NOT uploaded', async () => {
    const reportContent = '# My Report\n\nSome findings.';
    await createArtifact({
      filename: 'report.md',
      mimeType: 'text/markdown',
      content: reportContent,
      message: 'tim-proof: session-uuid',
    });
    await createArtifact({
      filename: 'screenshot.png',
      mimeType: 'image/png',
      content: 'img',
    });

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    const body = mockPostPullRequestComment.mock.calls[0][3] as string;
    // Report markdown content appears in the body
    expect(body).toContain('# My Report');
    expect(body).toContain('Some findings.');

    // report.md filename should not appear as a downloadable link (it is not uploaded)
    // The body should contain the screenshot image embed but not report.md link
    expect(body).toContain('screenshot.png');
    expect(body).not.toContain('[report.md]');

    // Only one artifact should have been uploaded (not report.md)
    // Verify by checking the log: log() is called per uploaded artifact
    const uploadLogs = mockLog.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].startsWith('Uploaded artifact')
    );
    expect(uploadLogs.some((c) => (c[0] as string).includes('screenshot.png'))).toBe(true);
    expect(uploadLogs.some((c) => (c[0] as string).includes('report.md'))).toBe(false);
  });

  test('report.md relative image references are rewritten to signed URLs', async () => {
    const reportContent = '# Report\n\n![Screenshot](screenshot.png)\n';
    await createArtifact({
      filename: 'report.md',
      mimeType: 'text/markdown',
      content: reportContent,
      message: 'tim-proof: session-uuid',
    });
    await createArtifact({
      filename: 'screenshot.png',
      mimeType: 'image/png',
      content: 'img-bytes',
    });

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    const body = mockPostPullRequestComment.mock.calls[0][3] as string;
    // The relative reference should be replaced by an absolute signed URL
    expect(body).not.toContain('![Screenshot](screenshot.png)');
    expect(body).toMatch(/!\[Screenshot\]\(http:\/\/127\.0\.0\.1:\d+\/.*\?sig=/);
    // screenshot.png should not appear in trailing artifacts section (already shown)
    // count occurrences: should appear only once in the rewritten link, not as a separate list item
    const screenshotMatches = body.match(/screenshot\.png/g) ?? [];
    // The rewritten image link and possibly the upload log, but no duplicate download link
    expect(screenshotMatches.length).toBeLessThan(3);
  });

  test('nested report.md link is rewritten using artifact filename as relativePath', async () => {
    // Regression: uploadArtifact sets relativePath to artifact.filename (not the media-host object
    // path), so subdirectory-prefixed references in report.md must match correctly.
    const reportContent = '# Report\n\n![Screenshot](runbook-1/screenshot.png)\n';
    await createArtifact({
      filename: 'report.md',
      mimeType: 'text/markdown',
      content: reportContent,
      message: 'tim-proof: session-uuid',
    });
    await createArtifact({
      filename: 'runbook-1/screenshot.png',
      mimeType: 'image/png',
      content: 'img-bytes',
    });

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    const body = mockPostPullRequestComment.mock.calls[0][3] as string;
    // Nested relative reference must be rewritten to an absolute signed URL
    expect(body).not.toContain('![Screenshot](runbook-1/screenshot.png)');
    expect(body).toMatch(/!\[Screenshot\]\(http:\/\/127\.0\.0\.1:\d+\/.*\?sig=/);
    // The artifact was referenced via a real markdown link, so it must NOT appear in the trailing
    // ## Artifacts list (avoid duplication)
    expect(body).not.toContain('[runbook-1/screenshot.png]');
  });

  test('report.md without tim-proof: message is still used as body and not uploaded', async () => {
    // Regression: detection is filename-only (isReportArtifact), so a manually-attached report.md
    // must behave identically to a proof-generated one.
    const reportContent = '# Manual Report\n\nManual findings here.';
    await createArtifact({
      filename: 'report.md',
      mimeType: 'text/markdown',
      content: reportContent,
      message: null, // no tim-proof: prefix
    });
    await createArtifact({
      filename: 'screenshot.png',
      mimeType: 'image/png',
      content: 'img',
    });

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    const body = mockPostPullRequestComment.mock.calls[0][3] as string;
    // Report body is inlined
    expect(body).toContain('# Manual Report');
    expect(body).toContain('Manual findings here.');
    // report.md is NOT listed as a downloadable link
    expect(body).not.toContain('[report.md]');
    // report.md was NOT uploaded (no upload log for it)
    const uploadLogs = mockLog.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].startsWith('Uploaded artifact')
    );
    expect(uploadLogs.some((c) => (c[0] as string).includes('report.md'))).toBe(false);
    expect(uploadLogs.some((c) => (c[0] as string).includes('screenshot.png'))).toBe(true);
  });

  test('does not upload a duplicate report.md that the comment would drop', async () => {
    // Regression: buildArtifactCommentBody filters out every report.md, so the command must not
    // upload any report.md (even a second one) — otherwise the upload is silently lost.
    await createArtifact({
      filename: 'report.md',
      mimeType: 'text/markdown',
      content: '# Report One',
      message: 'tim-proof: session-uuid',
    });
    await createArtifact({
      filename: 'report.md',
      mimeType: 'text/markdown',
      content: '# Report Two',
      message: null,
    });
    await createArtifact({
      filename: 'screenshot.png',
      mimeType: 'image/png',
      content: 'img',
    });

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    const uploadLogs = mockLog.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].startsWith('Uploaded artifact')
    );
    // No report.md was uploaded; only the screenshot.
    expect(uploadLogs.some((c) => (c[0] as string).includes('report.md'))).toBe(false);
    expect(uploadLogs.some((c) => (c[0] as string).includes('screenshot.png'))).toBe(true);
  });

  test('backtick mentions of filenames are NOT rewritten as links', async () => {
    const reportContent = 'See `screenshot.png` for details.\n';
    await createArtifact({
      filename: 'report.md',
      mimeType: 'text/markdown',
      content: reportContent,
      message: 'tim-proof: session-uuid',
    });
    await createArtifact({
      filename: 'screenshot.png',
      mimeType: 'image/png',
      content: 'img-bytes',
    });

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    const body = mockPostPullRequestComment.mock.calls[0][3] as string;
    // Backtick span stays intact
    expect(body).toContain('`screenshot.png`');
    // And the artifact still appears in the trailing list (not "shown in report" by a link)
    expect(body).toMatch(/\[screenshot\.png\]/);
  });

  // ── Multi-PR ───────────────────────────────────────────────────────────────

  test('posts to multiple open linked PRs', async () => {
    await createArtifact({ filename: 'screenshot.png', mimeType: 'image/png', content: 'img' });

    const pr2Context = {
      ...OPEN_PR_CONTEXT,
      prUrl: 'https://github.com/acme/repo/pull/99',
      prNumber: 99,
    };

    // Plan has two PR URLs in pullRequest field; gatherPrContext returns different contexts
    await writePlanToDb(
      {
        id: PLAN_ID,
        uuid: PLAN_UUID,
        title: 'Upload CLI test plan',
        goal: 'Test the upload command',
        details: 'Testing upload artifacts CLI',
        status: 'in_progress',
        tasks: [],
        dependencies: [],
        issue: [],
        docs: [],
        tags: [],
        epic: false,
        temp: false,
        pullRequest: [
          'https://github.com/acme/repo/pull/42',
          'https://github.com/acme/repo/pull/99',
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { cwdForIdentity: tempDir, skipUpdatedAt: true }
    );

    mockGatherPrContext.mockResolvedValueOnce(OPEN_PR_CONTEXT).mockResolvedValueOnce(pr2Context);

    mockFindPullRequestCommentByMarker.mockResolvedValue(null);

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    expect(mockPostPullRequestComment).toHaveBeenCalledTimes(2);
    expect(mockPostPullRequestComment).toHaveBeenCalledWith('acme', 'repo', 42, expect.any(String));
    expect(mockPostPullRequestComment).toHaveBeenCalledWith('acme', 'repo', 99, expect.any(String));
  });

  test('still attempts every PR when one comment post fails, then throws', async () => {
    await createArtifact({ filename: 'screenshot.png', mimeType: 'image/png', content: 'img' });

    const pr2Context = {
      ...OPEN_PR_CONTEXT,
      prUrl: 'https://github.com/acme/repo/pull/99',
      prNumber: 99,
    };

    await writePlanToDb(
      {
        id: PLAN_ID,
        uuid: PLAN_UUID,
        title: 'Upload CLI test plan',
        goal: 'Test the upload command',
        details: 'Testing upload artifacts CLI',
        status: 'in_progress',
        tasks: [],
        dependencies: [],
        issue: [],
        docs: [],
        tags: [],
        epic: false,
        temp: false,
        pullRequest: [
          'https://github.com/acme/repo/pull/42',
          'https://github.com/acme/repo/pull/99',
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { cwdForIdentity: tempDir, skipUpdatedAt: true }
    );

    mockGatherPrContext.mockResolvedValueOnce(OPEN_PR_CONTEXT).mockResolvedValueOnce(pr2Context);
    mockFindPullRequestCommentByMarker.mockResolvedValue(null);
    // Posting to PR 42 fails; PR 99 still gets attempted.
    mockPostPullRequestComment.mockImplementation(async (_owner, _repo, prNumber) => {
      if (prNumber === 42) {
        throw new Error('boom');
      }
      return { id: 222, htmlUrl: 'https://github.com/acme/repo/pull/99#issuecomment-222' };
    });

    await expect(handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand())).rejects.toThrow(
      /Failed to post artifacts comment to some PRs/
    );

    // Both PRs were attempted despite the failure on the first.
    expect(mockPostPullRequestComment).toHaveBeenCalledWith('acme', 'repo', 42, expect.any(String));
    expect(mockPostPullRequestComment).toHaveBeenCalledWith('acme', 'repo', 99, expect.any(String));
  });

  // ── Partial multi-PR failure surfaces a warning ───────────────────────────

  test('warns for a failing PR and still posts to the resolved PR', async () => {
    await createArtifact({ filename: 'screenshot.png', mimeType: 'image/png', content: 'img' });

    // Plan linked to two PRs
    await writePlanToDb(
      {
        id: PLAN_ID,
        uuid: PLAN_UUID,
        title: 'Upload CLI test plan',
        goal: 'Test the upload command',
        details: 'Testing upload artifacts CLI',
        status: 'in_progress',
        tasks: [],
        dependencies: [],
        issue: [],
        docs: [],
        tags: [],
        epic: false,
        temp: false,
        pullRequest: [
          'https://github.com/acme/repo/pull/42',
          'https://github.com/acme/repo/pull/99',
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { cwdForIdentity: tempDir, skipUpdatedAt: true }
    );

    // First PR resolves; second rejects
    mockGatherPrContext
      .mockResolvedValueOnce(OPEN_PR_CONTEXT)
      .mockRejectedValueOnce(new Error('Cannot resolve PR #99'));

    mockFindPullRequestCommentByMarker.mockResolvedValue(null);

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    // warn() should have been called mentioning the failed PR
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('https://github.com/acme/repo/pull/99')
    );
    // The resolved PR still receives its comment
    expect(mockPostPullRequestComment).toHaveBeenCalledTimes(1);
    expect(mockPostPullRequestComment).toHaveBeenCalledWith('acme', 'repo', 42, expect.any(String));
  });

  test('throws when all linked PRs fail to resolve', async () => {
    await createArtifact({ filename: 'screenshot.png', mimeType: 'image/png', content: 'img' });

    mockGatherPrContext.mockRejectedValue(new Error('Cannot resolve PR'));

    await expect(handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand())).rejects.toThrow();
    expect(mockPostPullRequestComment).not.toHaveBeenCalled();
  });

  // ── Explicit --pr override ────────────────────────────────────────────────

  test('targets only the explicit --pr PR when provided', async () => {
    await createArtifact({ filename: 'screenshot.png', mimeType: 'image/png', content: 'img' });

    await handleUploadArtifactsCommand(
      PLAN_ID,
      { pr: 'https://github.com/acme/repo/pull/42' },
      makeRootCommand()
    );

    expect(mockGatherPrContext).toHaveBeenCalledWith(
      expect.objectContaining({ prUrlOrNumber: 'https://github.com/acme/repo/pull/42' })
    );
    expect(mockPostPullRequestComment).toHaveBeenCalledTimes(1);
  });

  // ── Headless adapter ──────────────────────────────────────────────────────

  test('wraps work in a headless upload-artifacts session', async () => {
    await createArtifact({ filename: 'screenshot.png', mimeType: 'image/png', content: 'img' });

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    expect(mockRunWithHeadlessAdapterIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        command: 'upload-artifacts',
        interactive: true,
      })
    );
  });

  test('disables headless adapter when tunnel mode is active', async () => {
    mockIsTunnelActive.mockReturnValue(true);
    await createArtifact({ filename: 'screenshot.png', mimeType: 'image/png', content: 'img' });

    await handleUploadArtifactsCommand(PLAN_ID, { terminalInput: false }, makeRootCommand());

    expect(mockRunWithHeadlessAdapterIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, interactive: false })
    );
  });

  // ── No authToken on GitHub calls ──────────────────────────────────────────

  test('calls GitHub functions with no authToken (uses default token)', async () => {
    await createArtifact({ filename: 'screenshot.png', mimeType: 'image/png', content: 'img' });

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    // 4-argument call: no options object with authToken
    expect(mockFindPullRequestCommentByMarker).toHaveBeenCalledWith(
      'acme',
      'repo',
      42,
      expect.any(String)
    );
    expect(mockFindPullRequestCommentByMarker.mock.calls[0]).toHaveLength(4);

    expect(mockPostPullRequestComment).toHaveBeenCalledWith('acme', 'repo', 42, expect.any(String));
    expect(mockPostPullRequestComment.mock.calls[0]).toHaveLength(4);
  });

  // ── Per-plan marker ───────────────────────────────────────────────────────

  test('uses a per-plan marker containing the plan UUID', async () => {
    await createArtifact({ filename: 'screenshot.png', mimeType: 'image/png', content: 'img' });

    await handleUploadArtifactsCommand(PLAN_ID, {}, makeRootCommand());

    const expectedMarker = `<!-- tim:plan-artifacts:${PLAN_UUID} -->`;
    expect(mockFindPullRequestCommentByMarker).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Number),
      expectedMarker
    );
    const body = mockPostPullRequestComment.mock.calls[0][3] as string;
    expect(body.startsWith(`${expectedMarker}\n`)).toBe(true);
  });
});
