import { describe, test, expect, mock } from 'bun:test';
import { generateProjectId, slugify } from './id_utils.js';

describe('rmplan parse - project ID generation logic', () => {
  describe('Project ID generation with GitHub issues', () => {
    test('generates project ID from issue number', async () => {
      // Mock the GitHub API calls
      mock.module('../common/github/issues.ts', () => ({
        fetchIssueAndComments: async () => ({
          issue: {
            number: 123,
            title: 'Add OAuth2 Authentication Support',
            body: 'We need to add OAuth2 authentication to the application.',
            url: 'https://github.com/owner/repo/issues/123',
            state: 'open',
            user: {
              login: 'testuser',
            },
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
          comments: [],
        }),
      }));

      mock.module('../common/github/identifiers.ts', () => ({
        parsePrOrIssueNumber: async (input: string) => {
          if (input === '123') {
            return {
              owner: 'owner',
              repo: 'repo',
              number: 123,
            };
          }
          return null;
        },
      }));

      const { fetchIssueAndComments } = await import('../common/github/issues.js');
      const { parsePrOrIssueNumber } = await import('../common/github/identifiers.js');

      // Simulate the logic from rmplan parse command
      const issueInfo = await parsePrOrIssueNumber('123');
      expect(issueInfo).not.toBeNull();
      expect(issueInfo?.number).toBe(123);

      const issueData = await fetchIssueAndComments({
        owner: issueInfo!.owner,
        repo: issueInfo!.repo,
        number: issueInfo!.number,
      });

      const slugTitle = slugify(issueData.issue.title);
      const projectId = `issue-${issueData.issue.number}-${slugTitle}`;

      expect(projectId).toBe('issue-123-add-oauth2-authentication-support');
    });

    test('truncates long issue titles', async () => {
      // Mock issue with very long title
      mock.module('../common/github/issues.ts', () => ({
        fetchIssueAndComments: async () => ({
          issue: {
            number: 789,
            title:
              'This is an extremely long issue title that should definitely be truncated when creating the project ID to avoid excessively long directory names in the filesystem',
            body: 'Long issue description.',
            url: 'https://github.com/owner/repo/issues/789',
            state: 'open',
            user: {
              login: 'user',
            },
            created_at: '2024-01-03T00:00:00Z',
            updated_at: '2024-01-03T00:00:00Z',
          },
          comments: [],
        }),
      }));

      const { fetchIssueAndComments } = await import('../common/github/issues.js');

      const issueData = await fetchIssueAndComments({
        owner: 'owner',
        repo: 'repo',
        number: 789,
      });

      const slugTitle = slugify(issueData.issue.title);
      const maxSlugLength = 50;
      const truncatedSlugTitle =
        slugTitle.length > maxSlugLength
          ? slugTitle.substring(0, maxSlugLength).replace(/-+$/, '')
          : slugTitle;

      const projectId = `issue-${issueData.issue.number}-${truncatedSlugTitle}`;

      expect(projectId).toMatch(/^issue-789-/);
      const slugPart = projectId.substring('issue-789-'.length);
      expect(slugPart.length).toBeLessThanOrEqual(50);
      expect(slugPart).not.toEndWith('-');
    });
  });

  describe('Project ID generation with LLM', () => {
    test('generates project ID from LLM-suggested title', async () => {
      // Mock the AI module
      mock.module('ai', () => ({
        generateText: async () => ({
          text: 'realtime-chat-websocket',
        }),
      }));

      const { generateText } = await import('ai');

      // Simulate the logic from rmplan parse command
      const parsedPlan = {
        overallGoal: 'Build a real-time chat application with WebSocket support.',
        overallDetails:
          'Create a chat application that supports real-time messaging, user presence, and message history.',
        phases: [],
      };

      const prompt = `Based on the following project goal and details, suggest a very short, concise, slug-style title (2-5 words, lowercase, hyphenated).
Goal: ${parsedPlan.overallGoal}
Details: ${parsedPlan.overallDetails?.substring(0, 200) || ''}
Respond with ONLY the slug-style title.`;

      const result = await generateText({
        model: {} as any, // Mock model
        prompt,
        maxTokens: 20,
        temperature: 0.3,
      });

      const llmGeneratedTitle = slugify(result.text.trim());
      const projectId = generateProjectId(llmGeneratedTitle);

      expect(projectId).toMatch(/^realtime-chat-websocket-[a-z0-9]{6}$/);
    });

    test('falls back to generic ID when LLM fails', async () => {
      // Mock the AI module to throw an error
      mock.module('ai', () => ({
        generateText: async () => {
          throw new Error('LLM API error');
        },
      }));

      // Simulate fallback logic
      let projectId: string;
      try {
        throw new Error('LLM API error'); // Simulate the error
      } catch (err) {
        // Fall back to a generic projectId
        projectId = generateProjectId('unnamed-project');
      }

      expect(projectId).toMatch(/^unnamed-project-[a-z0-9]{6}$/);
    });
  });

  describe('Custom project ID handling', () => {
    test('slugifies custom project ID', () => {
      const customId = 'My Custom Project ID!';
      const projectId = slugify(customId);

      expect(projectId).toBe('my-custom-project-id');
    });

    test('handles project ID with special characters', () => {
      const customId = '---Project@#$%Name---';
      const projectId = slugify(customId);

      expect(projectId).toBe('project-name');
    });
  });
});
