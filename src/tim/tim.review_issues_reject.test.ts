import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const { handleReviewIssuesRejectCommandMock, handleReviewIssuesClearCommandMock } = vi.hoisted(
  () => ({
    handleReviewIssuesRejectCommandMock: vi.fn(async () => {}),
    handleReviewIssuesClearCommandMock: vi.fn(async () => {}),
  })
);

vi.mock('./commands/review.js', () => ({
  handleReviewIssuesRejectCommand: handleReviewIssuesRejectCommandMock,
  handleReviewIssuesClearCommand: handleReviewIssuesClearCommandMock,
  handleReviewIssuesListCommand: vi.fn(async () => {}),
  handleReviewIssuesResolveCommand: vi.fn(async () => {}),
}));

import { program } from './tim.ts';

async function runTimCli(args: string[]): Promise<void> {
  await program.parseAsync(['node', 'tim', ...args]);
}

describe('tim review-issues reject Commander registration', () => {
  beforeAll(() => {
    program.exitOverride();
  });

  beforeEach(() => {
    handleReviewIssuesRejectCommandMock.mockClear();
    handleReviewIssuesClearCommandMock.mockClear();
  });

  test('registers all documented options and passes them through', async () => {
    await runTimCli([
      'review-issues',
      'reject',
      '123',
      '--reason',
      'Not applicable',
      '--from-review',
      '/tmp/output.json',
      '--issue',
      '2',
      '--file',
      'src/example.ts',
      '--line',
      '10',
      '--content',
      'Some content',
      '--severity',
      'minor',
      '--category',
      'style',
      '--suggestion',
      'Do this instead',
    ]);

    expect(handleReviewIssuesRejectCommandMock).toHaveBeenCalledTimes(1);
    const [planId, options] = handleReviewIssuesRejectCommandMock.mock.calls[0];
    expect(planId).toBe(123);
    expect(options).toMatchObject({
      reason: 'Not applicable',
      fromReview: '/tmp/output.json',
      issue: '2',
      file: 'src/example.ts',
      line: '10',
      content: 'Some content',
      severity: 'minor',
      category: 'style',
      suggestion: 'Do this instead',
    });
  });

  test('requires --reason', async () => {
    await expect(runTimCli(['review-issues', 'reject', '123'])).rejects.toThrow();
    expect(handleReviewIssuesRejectCommandMock).not.toHaveBeenCalled();
  });

  test('requires a planId argument', async () => {
    await expect(
      runTimCli(['review-issues', 'reject', '--reason', 'Not applicable'])
    ).rejects.toThrow();
    expect(handleReviewIssuesRejectCommandMock).not.toHaveBeenCalled();
  });

  test('registers the clear command and passes --all through', async () => {
    await runTimCli(['review-issues', 'clear', '123', '--all']);

    expect(handleReviewIssuesClearCommandMock).toHaveBeenCalledTimes(1);
    const [planId, options] = handleReviewIssuesClearCommandMock.mock.calls[0];
    expect(planId).toBe(123);
    expect(options).toMatchObject({ all: true });
  });
});
