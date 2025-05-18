import { describe, test, expect, spyOn } from 'bun:test';
import { getInstructionsFromGithubIssue } from './issues.ts';
import * as logging from '../../logging.ts';
import { parseRmprOptions } from '../../rmpr/comment_options.ts';

describe('getInstructionsFromGithubIssue', () => {
  test('parses and combines RmprOptions from issue body and comments', async () => {
    // Mock fetchIssueAndComments
    const fetchIssueAndComments = async () => ({
      issue: {
        number: 123,
        title: 'Test Issue',
        body: 'Issue body\n--rmpr include-all with-imports',
      },
      comments: [
        { body: 'Comment 1\n--rmpr with-importers' },
        { body: 'Comment 2\n--rmpr include src/utils.ts' },
      ],
    });

    // Mock selectIssueComments
    const selectIssueComments = async () => ['Issue body', 'Comment 1', 'Comment 2'];

    // Spy on console.log to suppress output
    const logSpy = spyOn(logging, 'log').mockImplementation(() => {});

    // Mock parsePrOrIssueNumber
    const parsePrOrIssueNumber = () => ({ owner: 'test', repo: 'repo', number: 123 });

    // Replace the original functions
    const originalFetch = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(await import('./issues.ts')),
      'fetchIssueAndComments'
    )?.value;
    const originalSelect = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(await import('./issues.ts')),
      'selectIssueComments'
    )?.value;
    const originalParse = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(await import('./issues.ts')),
      'parsePrOrIssueNumber'
    )?.value;

    Object.defineProperty(Object.getPrototypeOf(await import('./issues.ts')), 'fetchIssueAndComments', {
      value: fetchIssueAndComments,
    });
    Object.defineProperty(Object.getPrototypeOf(await import('./issues.ts')), 'selectIssueComments', {
      value: selectIssueComments,
    });
    Object.defineProperty(Object.getPrototypeOf(await import('./issues.ts')), 'parsePrOrIssueNumber', {
      value: parsePrOrIssueNumber,
    });

    try {
      const result = await getInstructionsFromGithubIssue('#123');
      
      expect(result.rmprOptions).toEqual({
        includeAll: true,
        withImports: true,
        withImporters: true,
        include: ['src/utils.ts'],
      });
      
      expect(result.plan).toBe('Issue body\n\nComment 1\n\nComment 2');
      expect(result.suggestedFileName).toBe('issue-123-test-issue.md');
    } finally {
      // Restore original functions
      Object.defineProperty(Object.getPrototypeOf(await import('./issues.ts')), 'fetchIssueAndComments', {
        value: originalFetch,
      });
      Object.defineProperty(Object.getPrototypeOf(await import('./issues.ts')), 'selectIssueComments', {
        value: originalSelect,
      });
      Object.defineProperty(Object.getPrototypeOf(await import('./issues.ts')), 'parsePrOrIssueNumber', {
        value: originalParse,
      });
      logSpy.mockRestore();
    }
  });

  test('handles issue with no RmprOptions', async () => {
    // Mock fetchIssueAndComments
    const fetchIssueAndComments = async () => ({
      issue: {
        number: 123,
        title: 'Test Issue',
        body: 'Issue body',
      },
      comments: [
        { body: 'Comment 1' },
      ],
    });

    // Mock selectIssueComments
    const selectIssueComments = async () => ['Issue body', 'Comment 1'];

    // Spy on console.log to suppress output
    const logSpy = spyOn(logging, 'log').mockImplementation(() => {});

    // Mock parsePrOrIssueNumber
    const parsePrOrIssueNumber = () => ({ owner: 'test', repo: 'repo', number: 123 });

    // Replace the original functions
    const originalFetch = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(await import('./issues.ts')),
      'fetchIssueAndComments'
    )?.value;
    const originalSelect = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(await import('./issues.ts')),
      'selectIssueComments'
    )?.value;
    const originalParse = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(await import('./issues.ts')),
      'parsePrOrIssueNumber'
    )?.value;

    Object.defineProperty(Object.getPrototypeOf(await import('./issues.ts')), 'fetchIssueAndComments', {
      value: fetchIssueAndComments,
    });
    Object.defineProperty(Object.getPrototypeOf(await import('./issues.ts')), 'selectIssueComments', {
      value: selectIssueComments,
    });
    Object.defineProperty(Object.getPrototypeOf(await import('./issues.ts')), 'parsePrOrIssueNumber', {
      value: parsePrOrIssueNumber,
    });

    try {
      const result = await getInstructionsFromGithubIssue('#123');
      
      expect(result.rmprOptions).toBeNull();
      expect(result.plan).toBe('Issue body\n\nComment 1');
      expect(result.suggestedFileName).toBe('issue-123-test-issue.md');
    } finally {
      // Restore original functions
      Object.defineProperty(Object.getPrototypeOf(await import('./issues.ts')), 'fetchIssueAndComments', {
        value: originalFetch,
      });
      Object.defineProperty(Object.getPrototypeOf(await import('./issues.ts')), 'selectIssueComments', {
        value: originalSelect,
      });
      Object.defineProperty(Object.getPrototypeOf(await import('./issues.ts')), 'parsePrOrIssueNumber', {
        value: originalParse,
      });
      logSpy.mockRestore();
    }
  });
});
