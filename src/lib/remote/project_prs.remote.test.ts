import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { upsertPrStatus } from '$tim/db/pr_status.js';
import { invokeCommand, invokeQuery } from '$lib/test-utils/invoke_command.js';

let currentDb: Database;
let currentWebhookServerUrl: string | null = null;
const { ingestWebhookEvents, refreshProjectPrsService, getGitHubUsername, resolveGitHubToken } =
  vi.hoisted(() => ({
    ingestWebhookEvents: vi.fn(),
    refreshProjectPrsService: vi.fn(),
    getGitHubUsername: vi.fn(),
    resolveGitHubToken: vi.fn(),
  }));

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

vi.mock('$common/github/webhook_client.js', () => ({
  getWebhookServerUrl: () => currentWebhookServerUrl,
}));

vi.mock('$common/github/webhook_ingest.js', () => ({
  ingestWebhookEvents,
  formatWebhookIngestErrors: (errors: string[]) =>
    errors.length > 0 ? `Webhook ingestion had issues: ${errors.join('; ')}` : undefined,
}));

vi.mock('$common/github/project_pr_service.js', () => ({
  refreshProjectPrs: refreshProjectPrsService,
}));

vi.mock('$common/github/user.js', () => ({
  getGitHubUsername,
  normalizeGitHubUsername: (value: string | null | undefined) => value?.toLowerCase() ?? '',
}));

vi.mock('$common/github/token.js', () => ({
  resolveGitHubToken,
}));

describe('project_prs remote functions', () => {
  let tempDir: string;
  let projectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-project-prs-remote-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    projectId = getOrCreateProject(currentDb, 'github.com__example__repo').id;
    currentWebhookServerUrl = null;

    ingestWebhookEvents.mockReset();
    refreshProjectPrsService.mockReset();
    getGitHubUsername.mockReset();
    resolveGitHubToken.mockReset();

    ingestWebhookEvents.mockResolvedValue({
      eventsIngested: 1,
      prsUpdated: [],
      errors: [],
    });
    refreshProjectPrsService.mockResolvedValue({ newLinks: [] });
    getGitHubUsername.mockResolvedValue('dimfeld');
    resolveGitHubToken.mockReturnValue('token');
  });

  afterEach(() => {
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('refreshProjectPrs uses webhook ingestion alone when no token is configured', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    resolveGitHubToken.mockReturnValue(null);
    const { refreshProjectPrs } = await import('./project_prs.remote.js');

    const result = await invokeCommand(refreshProjectPrs, { projectId: String(projectId) });

    expect(ingestWebhookEvents).toHaveBeenCalledWith(currentDb);
    expect(refreshProjectPrsService).not.toHaveBeenCalled();
    expect(result).toEqual({ newLinks: [] });
  });

  test('refreshProjectPrs returns error when webhook ingestion fails', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    ingestWebhookEvents.mockRejectedValueOnce(new Error('webhook server offline'));
    const { refreshProjectPrs } = await import('./project_prs.remote.js');

    const result = await invokeCommand(refreshProjectPrs, { projectId: String(projectId) });

    expect(result.error).toContain('Webhook ingestion failed');
    expect(result.error).toContain('webhook server offline');
    expect(refreshProjectPrsService).not.toHaveBeenCalled();
  });

  test('refreshProjectPrs surfaces non-throwing webhook ingestion errors', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    ingestWebhookEvents.mockResolvedValueOnce({
      eventsIngested: 1,
      prsUpdated: [],
      errors: ['delivery parse failed', 'follow-up refresh failed'],
    });
    const { refreshProjectPrs } = await import('./project_prs.remote.js');

    const result = await invokeCommand(refreshProjectPrs, { projectId: String(projectId) });

    expect(result.error).toContain('Webhook ingestion had issues');
    expect(result.error).toContain('delivery parse failed');
    expect(result.error).toContain('follow-up refresh failed');
    expect(refreshProjectPrsService).not.toHaveBeenCalled();
  });

  test('fullRefreshProjectPrs bypasses webhook ingestion', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    const { fullRefreshProjectPrs } = await import('./project_prs.remote.js');

    const result = await invokeCommand(fullRefreshProjectPrs, { projectId: String(projectId) });

    expect(ingestWebhookEvents).not.toHaveBeenCalled();
    expect(refreshProjectPrsService).toHaveBeenCalledWith(currentDb, projectId, 'dimfeld');
    expect(result).toEqual({ newLinks: [] });
  });

  test('getProjectPrs reports webhookConfigured when webhook mode is enabled', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    resolveGitHubToken.mockReturnValue(null);
    const { getProjectPrs } = await import('./project_prs.remote.js');

    const result = await invokeQuery(getProjectPrs, { projectId: String(projectId) });

    expect(result).toMatchObject({
      hasData: false,
      tokenConfigured: false,
      webhookConfigured: true,
    });
  });

  test('getProjectPrs returns cached webhook PRs even when username resolution fails', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    resolveGitHubToken.mockReturnValue(null);
    getGitHubUsername.mockResolvedValueOnce(null);
    upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/example/repo/pull/17',
      owner: 'example',
      repo: 'repo',
      prNumber: 17,
      title: 'Webhook cached PR',
      state: 'open',
      draft: false,
      author: 'someone-else',
      lastFetchedAt: '2026-03-30T10:00:00.000Z',
    });

    const { getProjectPrs } = await import('./project_prs.remote.js');
    const result = await invokeQuery(getProjectPrs, { projectId: String(projectId) });

    expect(result.username).toBeNull();
    expect(result.hasData).toBe(true);
    expect(result.reviewing).toEqual([]);
    expect(result.authored).toHaveLength(1);
    expect(result.authored[0]?.status.pr_url).toBe('https://github.com/example/repo/pull/17');
  });

  test('getProjectPrs aggregates all project PRs when projectId is all', async () => {
    const otherProjectId = getOrCreateProject(currentDb, 'github.com__example__other-repo').id;
    upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/example/repo/pull/17',
      owner: 'example',
      repo: 'repo',
      prNumber: 17,
      title: 'First project PR',
      state: 'open',
      draft: false,
      author: 'dimfeld',
      lastFetchedAt: '2026-03-30T10:00:00.000Z',
    });
    upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/example/other-repo/pull/23',
      owner: 'example',
      repo: 'other-repo',
      prNumber: 23,
      title: 'Second project PR',
      state: 'open',
      draft: false,
      author: 'dimfeld',
      lastFetchedAt: '2026-03-30T10:00:00.000Z',
    });

    const { getProjectPrs } = await import('./project_prs.remote.js');
    const result = await invokeQuery(getProjectPrs, { projectId: 'all' });

    expect(result.hasData).toBe(true);
    expect(result.authored).toHaveLength(2);
    expect(result.authored.map((pr) => pr.projectId).sort((a, b) => a - b)).toEqual(
      [projectId, otherProjectId].sort((a, b) => a - b)
    );
    expect(result.authored.map((pr) => pr.status.pr_number).sort((a, b) => a - b)).toEqual([
      17, 23,
    ]);
  });

  test('refreshProjectPrs falls back to refreshing all projects when projectId is all', async () => {
    const otherProjectId = getOrCreateProject(currentDb, 'github.com__example__other-repo').id;
    const { refreshProjectPrs } = await import('./project_prs.remote.js');

    const result = await invokeCommand(refreshProjectPrs, { projectId: 'all' });

    expect(result).toEqual({ newLinks: [] });
    expect(refreshProjectPrsService).toHaveBeenCalledTimes(2);
    expect(refreshProjectPrsService).toHaveBeenCalledWith(currentDb, projectId, 'dimfeld');
    expect(refreshProjectPrsService).toHaveBeenCalledWith(currentDb, otherProjectId, 'dimfeld');
  });
});
