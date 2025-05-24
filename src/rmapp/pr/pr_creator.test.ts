import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PRCreator } from './pr_creator';
import { ChangeAnalyzer } from './change_analyzer';
import { PRTemplateGenerator } from './template_generator';
import type { PlanSchema } from '../../rmplan/planSchema';

// Mock logSpawn
mock.module('../../rmfilter/utils', () => ({
  logSpawn: mock((cmd: string[], opts?: any) => {
    // Mock git commands
    if (cmd[0] === 'git') {
      if (cmd[1] === 'status') {
        return { 
          stdout: { pipeTo: mock() },
          stderr: { pipeTo: mock() },
          exited: Promise.resolve(0)
        };
      }
      if (cmd[1] === 'push') {
        return { 
          stdout: { pipeTo: mock() },
          stderr: { pipeTo: mock() },
          exited: Promise.resolve(0)
        };
      }
      if (cmd[1] === 'diff') {
        return { 
          stdout: new ReadableStream({
            start(controller) {
              if (cmd[2] === '--numstat') {
                controller.enqueue(new TextEncoder().encode('10\t5\tfile1.ts\n20\t10\tfile2.ts\n'));
              } else if (cmd[2] === '--name-only') {
                controller.enqueue(new TextEncoder().encode('file1.ts\nfile2.ts\ntest.spec.ts\n'));
              } else {
                controller.enqueue(new TextEncoder().encode(''));
              }
              controller.close();
            }
          }),
          stderr: { pipeTo: mock() },
          exited: Promise.resolve(0)
        };
      }
    }
    return { 
      stdout: { pipeTo: mock() },
      stderr: { pipeTo: mock() },
      exited: Promise.resolve(0)
    };
  }),
  debug: false,
  quiet: false,
  setDebug: mock(),
  setQuiet: mock()
}));

describe('PRCreator', () => {
  let mockOctokit: any;
  let prCreator: PRCreator;

  beforeEach(() => {
    mockOctokit = {
      rest: {
        pulls: {
          create: mock(() => ({
            data: {
              number: 123,
              html_url: 'https://github.com/owner/repo/pull/123',
            },
          })),
          update: mock(() => ({})),
        },
        issues: {
          listLabelsForRepo: mock(() => ({
            data: [
              { name: 'bug' },
              { name: 'enhancement' },
              { name: 'documentation' },
              { name: 'rmapp-generated' },
            ],
          })),
          addLabels: mock(() => ({})),
          createComment: mock(() => ({})),
        },
      },
    };

    prCreator = new PRCreator(mockOctokit);
  });

  describe('createPR', () => {
    it('should create a PR successfully', async () => {
      const plan: PlanSchema = {
        goal: 'Fix issue',
        details: 'Test plan',
        tasks: [
          {
            title: 'Test task',
            description: 'Test task description',
            files: [],
            steps: [
              {
                prompt: 'Test step',
                done: true,
              },
            ],
          },
        ],
      };

      const result = await prCreator.createPR(
        {
          owner: 'testowner',
          repo: 'testrepo',
          issueNumber: 42,
          branchName: 'issue-42',
          baseRef: 'main',
        },
        'Fix bug in authentication',
        'The login form is broken',
        { summary: 'Fix authentication bug' },
        plan,
        '/tmp/test-workspace'
      );

      expect(result.success).toBe(true);
      expect(result.prNumber).toBe(123);
      expect(result.prUrl).toBe('https://github.com/owner/repo/pull/123');

      // Verify PR was created with correct parameters
      expect(mockOctokit.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'testowner',
          repo: 'testrepo',
          head: 'issue-42',
          base: 'main',
        })
      );

      // Verify issue was linked
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'testowner',
          repo: 'testrepo',
          issue_number: 42,
        })
      );
    });

    it('should handle PR creation failure', async () => {
      mockOctokit.rest.pulls.create = mock(() => {
        throw new Error('API error');
      });

      const plan: PlanSchema = {
        goal: 'Fix issue',
        details: 'Test plan',
        tasks: [],
      };

      const result = await prCreator.createPR(
        {
          owner: 'testowner',
          repo: 'testrepo',
          issueNumber: 42,
          branchName: 'issue-42',
          baseRef: 'main',
        },
        'Fix bug',
        'Bug description',
        {},
        plan,
        '/tmp/test-workspace'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('API error');
    });
  });
});

describe('ChangeAnalyzer', () => {
  let analyzer: ChangeAnalyzer;

  beforeEach(() => {
    analyzer = new ChangeAnalyzer();
  });

  describe('assessRiskLevel', () => {
    it('should return high risk for breaking changes', () => {
      const analysis = analyzer['assessRiskLevel'](
        { filesChanged: 5, insertions: 100, deletions: 50 },
        ['test.spec.ts'],
        true
      );
      expect(analysis).toBe('high');
    });

    it('should return high risk for many file changes', () => {
      const analysis = analyzer['assessRiskLevel'](
        { filesChanged: 25, insertions: 300, deletions: 200 },
        ['test.spec.ts'],
        false
      );
      expect(analysis).toBe('high');
    });

    it('should return medium risk for moderate changes without tests', () => {
      const analysis = analyzer['assessRiskLevel'](
        { filesChanged: 8, insertions: 150, deletions: 50 },
        [],
        false
      );
      expect(analysis).toBe('medium');
    });

    it('should return low risk for small changes with tests', () => {
      const analysis = analyzer['assessRiskLevel'](
        { filesChanged: 3, insertions: 50, deletions: 20 },
        ['test.spec.ts'],
        false
      );
      expect(analysis).toBe('low');
    });
  });
});

describe('PRTemplateGenerator', () => {
  let generator: PRTemplateGenerator;

  beforeEach(() => {
    generator = new PRTemplateGenerator();
  });

  describe('generateTemplate', () => {
    it('should generate a template for a bug fix', () => {
      const context = {
        issueNumber: 42,
        issueTitle: 'Fix authentication bug',
        issueBody: 'The login form is broken',
        analysis: { summary: 'Authentication bug needs fixing' },
        plan: {
          goal: 'Fix the authentication system',
          details: 'Fix login form',
          tasks: [
            {
              title: 'Update login component',
              description: 'Update the login component',
              files: [],
              steps: [
                {
                  prompt: 'Fix validation logic',
                  done: true,
                },
              ],
            },
          ],
        },
        branchName: 'issue-42',
        baseRef: 'main',
      };

      const changes = {
        filesChanged: 3,
        insertions: 50,
        deletions: 20,
        testsCoverage: {
          hasTests: true,
          testFiles: ['login.test.ts'],
        },
        breaking: false,
        riskLevel: 'low' as const,
        affectedAreas: ['components', 'utils'],
      };

      const template = generator.generateTemplate(context, changes);

      expect(template.title).toBe('fix: Fix authentication bug (#42)');
      expect(template.body).toContain('Closes #42');
      expect(template.body).toContain('Authentication bug needs fixing'); // From analysis.summary
      expect(template.body).toContain('Update login component');
      expect(template.body).toContain('✅ Fix validation logic');
      expect(template.labels).toContain('bug');
      expect(template.labels).toContain('rmapp-generated');
      expect(template.draft).toBe(false);
    });

    it('should create a draft PR for high-risk changes', () => {
      const context = {
        issueNumber: 100,
        issueTitle: 'Refactor entire codebase',
        issueBody: 'Major refactoring needed',
        analysis: {},
        plan: {
          goal: 'Refactor entire codebase',
          details: 'Refactor',
          tasks: [],
        },
        branchName: 'issue-100',
        baseRef: 'main',
      };

      const changes = {
        filesChanged: 50,
        insertions: 1000,
        deletions: 800,
        testsCoverage: {
          hasTests: false,
          testFiles: [],
        },
        breaking: true,
        riskLevel: 'high' as const,
        affectedAreas: ['core'],
      };

      const template = generator.generateTemplate(context, changes);

      expect(template.draft).toBe(true);
      expect(template.labels).toContain('breaking-change');
      expect(template.labels).toContain('needs-careful-review');
    });
  });
});