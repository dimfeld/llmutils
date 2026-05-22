import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IssueDocument, IssueTrackerClient } from '../../common/issue_tracker/types.js';

// Hoist mock declarations — Vitest hoists vi.mock calls before imports.
vi.mock('../../common/issue_tracker/factory.js', () => ({
  getIssueTracker: vi.fn(),
}));

vi.mock('../../common/input.js', () => ({
  promptCheckbox: vi.fn(),
}));

vi.mock('../../logging.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../logging.js')>();
  return {
    ...real,
    warn: vi.fn(),
  };
});

import { getIssueTracker } from '../../common/issue_tracker/factory.js';
import { promptCheckbox } from '../../common/input.js';
import { warn } from '../../logging.js';
import { collectIssueDocuments, hasLinearIssueReferences } from './generate_issue_docs.js';
import { getDefaultConfig } from '../configSchema.js';

const mockGetIssueTracker = vi.mocked(getIssueTracker);
const mockPromptCheckbox = vi.mocked(promptCheckbox);
const mockWarn = vi.mocked(warn);

const LINEAR_ISSUE_URL = 'https://linear.app/company/issue/TEAM-123';
const LINEAR_ISSUE_URL_2 = 'https://linear.app/company/issue/TEAM-456';
const GITHUB_ISSUE_URL = 'https://github.com/org/repo/issues/456';

function makeDoc(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: 'doc-id',
    title: 'Test Document',
    url: 'https://linear.app/doc/doc-id',
    content: '# Test\nContent here.',
    source: 'issue',
    ...overrides,
  };
}

function makeTrackerWithDocs(
  fetchImpl: (id: string) => Promise<IssueDocument[]>
): IssueTrackerClient {
  return {
    fetchIssue: vi.fn() as any,
    fetchAllOpenIssues: vi.fn() as any,
    parseIssueIdentifier: vi.fn() as any,
    getDisplayName: vi.fn().mockReturnValue('Linear') as any,
    getConfig: vi.fn() as any,
    fetchIssueDocuments: fetchImpl,
  };
}

function makeTrackerWithoutDocs(): IssueTrackerClient {
  return {
    fetchIssue: vi.fn() as any,
    fetchAllOpenIssues: vi.fn() as any,
    parseIssueIdentifier: vi.fn() as any,
    getDisplayName: vi.fn().mockReturnValue('GitHub') as any,
    getConfig: vi.fn() as any,
    // fetchIssueDocuments intentionally absent
  };
}

describe('collectIssueDocuments', () => {
  let tmpDir: string;
  // Default config has no issueTracker set (defaults to 'github'). Tests that exercise
  // the Linear fetch path must use a config with issueTracker: 'linear'.
  const githubConfig = getDefaultConfig();
  const linearConfig = { ...getDefaultConfig(), issueTracker: 'linear' as const };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-gen-issue-docs-test-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('skip paths — no docs fetched', () => {
    test('returns undefined when plan has no issue field', async () => {
      const result = await collectIssueDocuments({
        plan: { id: 1, title: 'Test', status: 'pending', tasks: [] },
        baseDir: tmpDir,
        config: linearConfig,
        interactive: false,
      });

      expect(result).toBeUndefined();
      expect(mockGetIssueTracker).not.toHaveBeenCalled();
    });

    test('returns undefined when plan has only GitHub URLs', async () => {
      const result = await collectIssueDocuments({
        plan: { id: 1, title: 'Test', status: 'pending', tasks: [], issue: [GITHUB_ISSUE_URL] },
        baseDir: tmpDir,
        config: linearConfig,
        interactive: false,
      });

      expect(result).toBeUndefined();
      expect(mockGetIssueTracker).not.toHaveBeenCalled();
    });

    test('returns undefined when plan has an empty issue array', async () => {
      const result = await collectIssueDocuments({
        plan: { id: 1, title: 'Test', status: 'pending', tasks: [], issue: [] },
        baseDir: tmpDir,
        config: linearConfig,
        interactive: false,
      });

      expect(result).toBeUndefined();
      expect(mockGetIssueTracker).not.toHaveBeenCalled();
    });

    test('returns undefined when tracker lacks fetchIssueDocuments (GitHub tracker)', async () => {
      mockGetIssueTracker.mockResolvedValue(makeTrackerWithoutDocs());

      const result = await collectIssueDocuments({
        plan: { id: 1, title: 'Test', status: 'pending', tasks: [], issue: [LINEAR_ISSUE_URL] },
        baseDir: tmpDir,
        config: linearConfig,
        interactive: false,
      });

      expect(result).toBeUndefined();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    test('returns undefined silently when zero documents are found', async () => {
      mockGetIssueTracker.mockResolvedValue(makeTrackerWithDocs(vi.fn().mockResolvedValue([])));

      const result = await collectIssueDocuments({
        plan: { id: 1, title: 'Test', status: 'pending', tasks: [], issue: [LINEAR_ISSUE_URL] },
        baseDir: tmpDir,
        config: linearConfig,
        interactive: false,
      });

      expect(result).toBeUndefined();
      expect(mockPromptCheckbox).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    test('returns undefined and skips entirely when config.issueTracker is github, even with a Linear URL', async () => {
      // Regression: a plan with a Linear-looking URL but a github-configured project
      // must skip silently — no tracker lookup, no warning.
      const result = await collectIssueDocuments({
        plan: { id: 1, title: 'Test', status: 'pending', tasks: [], issue: [LINEAR_ISSUE_URL] },
        baseDir: tmpDir,
        config: githubConfig,
        interactive: false,
      });

      expect(result).toBeUndefined();
      expect(mockGetIssueTracker).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    test('returns undefined and skips entirely when config.issueTracker is unset (defaults to github), even with a Linear URL', async () => {
      const configWithNoTracker = { ...getDefaultConfig(), issueTracker: undefined };
      const result = await collectIssueDocuments({
        plan: { id: 1, title: 'Test', status: 'pending', tasks: [], issue: [LINEAR_ISSUE_URL] },
        baseDir: tmpDir,
        config: configWithNoTracker as any,
        interactive: false,
      });

      expect(result).toBeUndefined();
      expect(mockGetIssueTracker).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });
  });

  describe('warn paths — non-fatal, generation continues', () => {
    test('emits warning and returns undefined when getIssueTracker throws (missing API key)', async () => {
      mockGetIssueTracker.mockRejectedValue(new Error('LINEAR_API_KEY is missing'));

      const result = await collectIssueDocuments({
        plan: { id: 1, title: 'Test', status: 'pending', tasks: [], issue: [LINEAR_ISSUE_URL] },
        baseDir: tmpDir,
        config: linearConfig,
        interactive: false,
      });

      expect(result).toBeUndefined();
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('LINEAR_API_KEY is missing'));
    });

    test('emits warning and returns undefined when fetchIssueDocuments throws', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error: timeout'));
      mockGetIssueTracker.mockResolvedValue(makeTrackerWithDocs(mockFetch));

      const result = await collectIssueDocuments({
        plan: { id: 1, title: 'Test', status: 'pending', tasks: [], issue: [LINEAR_ISSUE_URL] },
        baseDir: tmpDir,
        config: linearConfig,
        interactive: false,
      });

      expect(result).toBeUndefined();
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('Network error: timeout'));
    });
  });

  describe('non-interactive default-all selection', () => {
    test('selects all documents without invoking the prompt and writes them to disk', async () => {
      const doc1 = makeDoc({ id: 'doc-1', title: 'Architecture Overview', content: '# Arch\n' });
      const doc2 = makeDoc({
        id: 'doc-2',
        title: 'API Spec',
        content: '# API\n',
        source: 'project',
      });
      mockGetIssueTracker.mockResolvedValue(
        makeTrackerWithDocs(vi.fn().mockResolvedValue([doc1, doc2]))
      );

      const result = await collectIssueDocuments({
        plan: { id: 42, title: 'Test', status: 'pending', tasks: [], issue: [LINEAR_ISSUE_URL] },
        baseDir: tmpDir,
        config: linearConfig,
        interactive: false,
      });

      expect(mockPromptCheckbox).not.toHaveBeenCalled();
      expect(result).toHaveLength(2);

      // All paths should be under .tim/issue-docs/42/
      for (const docPath of result!) {
        expect(path.isAbsolute(docPath)).toBe(false);
        expect(docPath.startsWith(path.join('.tim', 'issue-docs', '42'))).toBe(true);
        await expect(fs.access(path.join(tmpDir, docPath))).resolves.toBeFalsy();
      }
    });

    test('passes projectId to getIssueTracker when provided', async () => {
      const doc = makeDoc({ id: 'doc-1', title: 'Doc' });
      mockGetIssueTracker.mockResolvedValue(makeTrackerWithDocs(vi.fn().mockResolvedValue([doc])));

      await collectIssueDocuments({
        plan: { id: 42, title: 'Test', status: 'pending', tasks: [], issue: [LINEAR_ISSUE_URL] },
        baseDir: tmpDir,
        config: linearConfig,
        projectId: 7,
        interactive: false,
      });

      expect(mockGetIssueTracker).toHaveBeenCalledWith(linearConfig, { projectId: 7 });
    });
  });

  describe('deduplication', () => {
    test('deduplicates documents with the same id across multiple Linear URLs', async () => {
      const sharedDoc = makeDoc({ id: 'shared-doc', title: 'Shared', content: '# shared\n' });
      const uniqueDoc = makeDoc({ id: 'unique-doc', title: 'Unique', content: '# unique\n' });
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce([sharedDoc, uniqueDoc])
        .mockResolvedValueOnce([sharedDoc]); // duplicate
      mockGetIssueTracker.mockResolvedValue(makeTrackerWithDocs(mockFetch));

      const result = await collectIssueDocuments({
        plan: {
          id: 42,
          title: 'Test',
          status: 'pending',
          tasks: [],
          issue: [LINEAR_ISSUE_URL, LINEAR_ISSUE_URL_2],
        },
        baseDir: tmpDir,
        config: linearConfig,
        interactive: false,
      });

      expect(result).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test('deduplicates duplicate Linear issue URLs in plan.issue', async () => {
      const doc = makeDoc({ id: 'doc-1', title: 'Doc' });
      const mockFetch = vi.fn().mockResolvedValue([doc]);
      mockGetIssueTracker.mockResolvedValue(makeTrackerWithDocs(mockFetch));

      await collectIssueDocuments({
        plan: {
          id: 42,
          title: 'Test',
          status: 'pending',
          tasks: [],
          // Same issue URL twice
          issue: [LINEAR_ISSUE_URL, LINEAR_ISSUE_URL],
        },
        baseDir: tmpDir,
        config: linearConfig,
        interactive: false,
      });

      // Should only fetch once for the deduplicated identifier
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('interactive selection', () => {
    test('deselecting all documents returns undefined and writes no files', async () => {
      const doc = makeDoc({ id: 'doc-1', title: 'Some Doc', content: '# Doc\n' });
      mockGetIssueTracker.mockResolvedValue(makeTrackerWithDocs(vi.fn().mockResolvedValue([doc])));
      mockPromptCheckbox.mockResolvedValue([]); // user unchecks everything

      const result = await collectIssueDocuments({
        plan: { id: 42, title: 'Test', status: 'pending', tasks: [], issue: [LINEAR_ISSUE_URL] },
        baseDir: tmpDir,
        config: linearConfig,
        interactive: true,
      });

      expect(result).toBeUndefined();
      // Cache directory should not have been created
      await expect(fs.access(path.join(tmpDir, '.tim', 'issue-docs', '42'))).rejects.toThrow();
    });

    test('prompt shows [Issue] and [Project] prefixed choices with all checked', async () => {
      const issueDoc = makeDoc({ id: 'doc-issue', title: 'Issue Spec', source: 'issue' });
      const projectDoc = makeDoc({ id: 'doc-project', title: 'Project Design', source: 'project' });
      mockGetIssueTracker.mockResolvedValue(
        makeTrackerWithDocs(vi.fn().mockResolvedValue([issueDoc, projectDoc]))
      );
      // User selects both
      mockPromptCheckbox.mockResolvedValue([issueDoc.id, projectDoc.id]);

      await collectIssueDocuments({
        plan: { id: 42, title: 'Test', status: 'pending', tasks: [], issue: [LINEAR_ISSUE_URL] },
        baseDir: tmpDir,
        config: linearConfig,
        interactive: true,
      });

      expect(mockPromptCheckbox).toHaveBeenCalledTimes(1);
      const callArgs = mockPromptCheckbox.mock.calls[0]![0];
      expect(callArgs.choices).toHaveLength(2);
      expect(callArgs.choices[0]).toMatchObject({ name: '[Issue] Issue Spec', checked: true });
      expect(callArgs.choices[1]).toMatchObject({
        name: '[Project] Project Design',
        checked: true,
      });
    });

    test('writes only user-selected documents', async () => {
      const doc1 = makeDoc({ id: 'doc-1', title: 'Keep This', content: 'kept\n' });
      const doc2 = makeDoc({ id: 'doc-2', title: 'Skip This', content: 'skipped\n' });
      mockGetIssueTracker.mockResolvedValue(
        makeTrackerWithDocs(vi.fn().mockResolvedValue([doc1, doc2]))
      );
      // User only selects doc1
      mockPromptCheckbox.mockResolvedValue([doc1.id]);

      const result = await collectIssueDocuments({
        plan: { id: 42, title: 'Test', status: 'pending', tasks: [], issue: [LINEAR_ISSUE_URL] },
        baseDir: tmpDir,
        config: linearConfig,
        interactive: true,
      });

      expect(result).toHaveLength(1);
      const content = await fs.readFile(path.join(tmpDir, result![0]), 'utf8');
      expect(content).toBe('kept\n');
    });
  });
});

describe('hasLinearIssueReferences', () => {
  test('returns true when plan.issue contains a Linear URL', () => {
    expect(
      hasLinearIssueReferences({
        title: 'Test',
        status: 'pending',
        tasks: [],
        issue: [LINEAR_ISSUE_URL],
      })
    ).toBe(true);
  });

  test('returns true when plan.issue contains a Linear key (TEAM-123)', () => {
    expect(
      hasLinearIssueReferences({
        title: 'Test',
        status: 'pending',
        tasks: [],
        issue: ['TEAM-123'],
      })
    ).toBe(true);
  });

  test('returns false when plan has no issue field', () => {
    expect(hasLinearIssueReferences({ title: 'Test', status: 'pending', tasks: [] })).toBe(false);
  });

  test('returns false when plan has an empty issue array', () => {
    expect(
      hasLinearIssueReferences({ title: 'Test', status: 'pending', tasks: [], issue: [] })
    ).toBe(false);
  });

  test('returns false when plan has only non-Linear URLs', () => {
    expect(
      hasLinearIssueReferences({
        title: 'Test',
        status: 'pending',
        tasks: [],
        issue: [GITHUB_ISSUE_URL],
      })
    ).toBe(false);
  });

  test('returns true when plan has a mix of Linear and non-Linear URLs', () => {
    expect(
      hasLinearIssueReferences({
        title: 'Test',
        status: 'pending',
        tasks: [],
        issue: [GITHUB_ISSUE_URL, LINEAR_ISSUE_URL],
      })
    ).toBe(true);
  });
});
