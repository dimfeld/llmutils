import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../logging.js', () => ({
  error: vi.fn(),
}));

import { getDefaultConfig, type TimConfig } from '../../tim/configSchema.js';
import {
  buildDailyDigestSlackPayload,
  buildSlackTestMessagePayload,
  buildReviewRequestSlackPayload,
  clearSlackClientCache,
  createFetchSlackSender,
  getSlackPostSender,
  postDailyDigestMessage,
  postReviewRequestMessage,
  postSlackTestMessage,
  type DailyDigestPayloadInput,
  type ReviewRequestPr,
  type ReviewRequestReviewer,
  type SlackBlock,
  type SlackPostResult,
  type SlackPostSenderArgs,
} from './slack_client.js';

function buildConfig(slack: TimConfig['slack']): TimConfig {
  return { ...getDefaultConfig(), slack };
}

const testPr: ReviewRequestPr = {
  title: 'Add feature X',
  url: 'https://github.com/owner/repo/pull/42',
  author: 'alice',
  number: 42,
  owner: 'owner',
  repo: 'repo',
};

const mappedReviewer: ReviewRequestReviewer = { githubLogin: 'bob', slackUserId: 'U123BOB' };
const unmappedReviewer: ReviewRequestReviewer = { githubLogin: 'carol', slackUserId: null };
const unmappedReviewer2: ReviewRequestReviewer = { githubLogin: 'dave' };

function sectionText(block: SlackBlock): string {
  if (block.type !== 'section') {
    throw new Error(`Expected section block, received ${block.type}`);
  }

  return block.text.text;
}

function serializedBlocks(blocks: SlackBlock[]): string {
  return JSON.stringify(blocks);
}

function buildFetchResponse(options: {
  ok: boolean;
  status: number;
  jsonBody?: unknown;
  textBody?: string;
}): Response {
  return {
    ok: options.ok,
    status: options.status,
    json: async (): Promise<unknown> => options.jsonBody,
    text: async (): Promise<string> => options.textBody ?? '',
  } as Response;
}

describe('common/slack/slack_client', () => {
  beforeEach(() => {
    clearSlackClientCache();
  });

  afterEach(() => {
    clearSlackClientCache();
  });

  describe('buildReviewRequestSlackPayload', () => {
    test('formats mapped reviewers as <@id> and unmapped as backtick code spans', () => {
      const payload = buildReviewRequestSlackPayload('#reviews', testPr, [
        mappedReviewer,
        unmappedReviewer,
      ]);
      const blockText = payload.blocks[0].text.text;
      expect(blockText).toContain('<@U123BOB>');
      expect(blockText).toContain('`carol`');
    });

    test('multiple reviewers are joined by ", "', () => {
      const payload = buildReviewRequestSlackPayload('#reviews', testPr, [
        mappedReviewer,
        unmappedReviewer,
        unmappedReviewer2,
      ]);
      const blockText = payload.blocks[0].text.text;
      expect(blockText).toContain('<@U123BOB>, `carol`, `dave`');
    });

    test('PR title is rendered as a Slack mrkdwn link', () => {
      const payload = buildReviewRequestSlackPayload('#reviews', testPr, [mappedReviewer]);
      const blockText = payload.blocks[0].text.text;
      expect(blockText).toContain('<https://github.com/owner/repo/pull/42|Add feature X>');
    });

    test('author is present in the block text', () => {
      const payload = buildReviewRequestSlackPayload('#reviews', testPr, [mappedReviewer]);
      const blockText = payload.blocks[0].text.text;
      expect(blockText).toContain('alice');
    });

    test('includes PR change stats when available', () => {
      const payload = buildReviewRequestSlackPayload(
        '#reviews',
        {
          ...testPr,
          changedFiles: 3,
          additions: 42,
          deletions: 17,
        },
        [mappedReviewer]
      );
      const blockText = payload.blocks[0].text.text;

      expect(blockText).toContain('*Changes:* 3 files (+42/-17)');
      expect(payload.text).toContain('(3 files (+42/-17))');
    });

    test('omits PR change stats when unavailable', () => {
      const payload = buildReviewRequestSlackPayload('#reviews', testPr, [mappedReviewer]);
      const blockText = payload.blocks[0].text.text;

      expect(blockText).not.toContain('*Changes:*');
    });

    test('top-level text fallback contains title, author, and github logins', () => {
      const payload = buildReviewRequestSlackPayload('#reviews', testPr, [
        mappedReviewer,
        unmappedReviewer,
      ]);
      expect(payload.text).toBeTruthy();
      expect(payload.text).toContain('Add feature X');
      expect(payload.text).toContain('alice');
      expect(payload.text).toContain('bob');
      expect(payload.text).toContain('carol');
    });

    test('top-level text fallback escapes Slack control sequences and mentions', () => {
      const prWithMentions: ReviewRequestPr = {
        title: 'Please review <!channel>',
        url: 'https://github.com/owner/repo/pull/43',
        author: 'dev&<@U999>',
      };
      const payload = buildReviewRequestSlackPayload('#reviews', prWithMentions, [
        { githubLogin: 'alice&<@U123>', slackUserId: null },
      ]);

      expect(payload.text).not.toContain('<!channel>');
      expect(payload.text).not.toContain('<@');
      expect(payload.text).toContain('&lt;!channel&gt;');
      expect(payload.text).toContain('dev&amp;&lt;@U999&gt;');
      expect(payload.text).toContain('alice&amp;&lt;@U123&gt;');

      const blockText = payload.blocks[0].text.text;
      expect(blockText).toContain('&lt;!channel&gt;');
      expect(blockText).toContain('dev&amp;&lt;@U999&gt;');
      expect(blockText).toContain('`alice&amp;&lt;@U123&gt;`');
    });

    test('empty reviewers list renders the placeholder text', () => {
      const payload = buildReviewRequestSlackPayload('#reviews', testPr, []);
      expect(payload.blocks[0].text.text).toContain('_No reviewers listed_');
      expect(payload.text).toBeTruthy();
    });

    test('escapes & < > in title, author, and URL', () => {
      const prWithSpecials: ReviewRequestPr = {
        title: 'Fix <foo> & bar > baz',
        url: 'https://example.com/pr?a=1&b=2',
        author: 'dev<op>',
      };
      const payload = buildReviewRequestSlackPayload('#reviews', prWithSpecials, []);
      const blockText = payload.blocks[0].text.text;
      expect(blockText).toContain('Fix &lt;foo&gt; &amp; bar &gt; baz');
      expect(blockText).toContain('dev&lt;op&gt;');
      expect(blockText).toContain('a=1&amp;b=2');
    });

    test('backticks in github login are replaced with single quotes in code span', () => {
      const quirkyReviewer: ReviewRequestReviewer = {
        githubLogin: 'bot`name',
        slackUserId: null,
      };
      const payload = buildReviewRequestSlackPayload('#reviews', testPr, [quirkyReviewer]);
      const blockText = payload.blocks[0].text.text;
      expect(blockText).toContain("`bot'name`");
    });

    test('channel is set correctly in the payload', () => {
      const payload = buildReviewRequestSlackPayload('#code-reviews', testPr, [mappedReviewer]);
      expect(payload.channel).toBe('#code-reviews');
    });

    test('block type is section with mrkdwn text type', () => {
      const payload = buildReviewRequestSlackPayload('#ch', testPr, []);
      expect(payload.blocks).toHaveLength(1);
      expect(payload.blocks[0].type).toBe('section');
      expect(payload.blocks[0].text.type).toBe('mrkdwn');
    });
  });

  describe('postReviewRequestMessage with injected sender', () => {
    const config = buildConfig({
      workspaces: {
        work: { token: 'xoxb-test-token' },
      },
    });

    test('calls sender with resolved token and returns ok:true on success', async () => {
      const calls: SlackPostSenderArgs[] = [];
      const fakeSender = async (args: SlackPostSenderArgs): Promise<SlackPostResult> => {
        calls.push(args);
        return { ok: true };
      };

      const result = await postReviewRequestMessage({
        config,
        workspace: 'work',
        channel: '#reviews',
        pr: testPr,
        reviewers: [mappedReviewer],
        sender: fakeSender,
      });

      expect(result).toEqual({ ok: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].token).toBe('xoxb-test-token');
      expect(calls[0].payload.channel).toBe('#reviews');
      expect(calls[0].payload.blocks).toHaveLength(1);
    });

    test('returns failure result when sender returns ok:false, does not throw', async () => {
      const fakeSender = async (_args: SlackPostSenderArgs): Promise<SlackPostResult> => {
        return { ok: false, error: 'channel_not_found' };
      };

      const result = await postReviewRequestMessage({
        config,
        workspace: 'work',
        channel: '#reviews',
        pr: testPr,
        reviewers: [mappedReviewer],
        sender: fakeSender,
      });

      expect(result).toEqual({ ok: false, error: 'channel_not_found' });
    });

    test('passes mixed mapped and unmapped reviewers to the sender payload', async () => {
      const calls: SlackPostSenderArgs[] = [];
      const fakeSender = async (args: SlackPostSenderArgs): Promise<SlackPostResult> => {
        calls.push(args);
        return { ok: true };
      };

      await postReviewRequestMessage({
        config,
        workspace: 'work',
        channel: '#reviews',
        pr: testPr,
        reviewers: [mappedReviewer, unmappedReviewer],
        sender: fakeSender,
      });

      const blockText = calls[0].payload.blocks[0].text.text;
      expect(blockText).toContain('<@U123BOB>');
      expect(blockText).toContain('`carol`');
    });

    test('throws on misconfigured workspace (workspace not in config)', async () => {
      const fakeSender = async (_args: SlackPostSenderArgs): Promise<SlackPostResult> => {
        return { ok: true };
      };

      await expect(
        postReviewRequestMessage({
          config,
          workspace: 'nonexistent',
          channel: '#reviews',
          pr: testPr,
          reviewers: [mappedReviewer],
          sender: fakeSender,
        })
      ).rejects.toThrow('"nonexistent" is not configured');
    });
  });

  describe('buildDailyDigestSlackPayload', () => {
    const digestBothBuckets: DailyDigestPayloadInput = {
      approvedUnmerged: [
        {
          prUrl: 'https://github.com/octocat/hello-world/pull/1',
          prNumber: 1,
          title: 'Approved PR',
          author: 'alice',
        },
      ],
      staleAwaitingReview: [
        {
          prUrl: 'https://github.com/octocat/hello-world/pull/2',
          prNumber: 2,
          title: 'Needs review',
          author: 'bob',
          reviewers: [
            { login: 'carol', waitedMs: 90_000_000, waitedLabel: '25 hours' },
            { login: 'dave', waitedMs: 180_000_000, waitedLabel: '2 days' },
          ],
        },
      ],
    };

    test('formats both buckets with header, approved section, divider, and stale section', () => {
      const payload = buildDailyDigestSlackPayload(
        '#reviews',
        'octocat/hello-world',
        digestBothBuckets
      );

      expect(payload.channel).toBe('#reviews');
      expect(payload.blocks.map((block) => block.type)).toEqual([
        'section',
        'section',
        'divider',
        'section',
      ]);
      expect(sectionText(payload.blocks[0])).toBe('*Daily PR digest — octocat/hello-world*');
      expect(sectionText(payload.blocks[1])).toContain('*Approved, not yet merged*');
      expect(sectionText(payload.blocks[3])).toContain('*Awaiting review for > 1 day*');
    });

    test('omits divider and stale section when only approved bucket is populated', () => {
      const payload = buildDailyDigestSlackPayload('#reviews', 'octocat/hello-world', {
        approvedUnmerged: digestBothBuckets.approvedUnmerged,
        staleAwaitingReview: [],
      });

      expect(payload.blocks.map((block) => block.type)).toEqual(['section', 'section']);
      expect(serializedBlocks(payload.blocks)).toContain('Approved, not yet merged');
      expect(serializedBlocks(payload.blocks)).not.toContain('Awaiting review');
    });

    test('omits approved section and divider when only stale bucket is populated', () => {
      const payload = buildDailyDigestSlackPayload('#reviews', 'octocat/hello-world', {
        approvedUnmerged: [],
        staleAwaitingReview: digestBothBuckets.staleAwaitingReview,
      });

      expect(payload.blocks.map((block) => block.type)).toEqual(['section', 'section']);
      expect(serializedBlocks(payload.blocks)).not.toContain('Approved, not yet merged');
      expect(serializedBlocks(payload.blocks)).toContain('Awaiting review');
    });

    test('renders PR links and plain login code spans without Slack mentions', () => {
      const payload = buildDailyDigestSlackPayload(
        '#reviews',
        'octocat/hello-world',
        digestBothBuckets
      );
      const blocks = serializedBlocks(payload.blocks);

      expect(blocks).toContain('<https://github.com/octocat/hello-world/pull/1|Approved PR>');
      expect(blocks).toContain('`alice`');
      expect(blocks).toContain('<https://github.com/octocat/hello-world/pull/2|Needs review>');
      expect(blocks).toContain('`bob`');
      expect(blocks).not.toContain('<@');
    });

    test('lists all waiting reviewers as plain logins with waited labels', () => {
      const payload = buildDailyDigestSlackPayload(
        '#reviews',
        'octocat/hello-world',
        digestBothBuckets
      );
      const staleText = sectionText(payload.blocks[3]);

      expect(staleText).toContain('`carol` (25 hours)');
      expect(staleText).toContain('`dave` (2 days)');
    });

    test('renders both sections when different PRs are approved and awaiting review', () => {
      const digest: DailyDigestPayloadInput = {
        approvedUnmerged: [
          {
            prUrl: 'https://github.com/octocat/hello-world/pull/9',
            prNumber: 9,
            title: 'Approved but waiting',
            author: 'alice',
          },
        ],
        staleAwaitingReview: [
          {
            prUrl: 'https://github.com/octocat/hello-world/pull/10',
            prNumber: 10,
            title: 'Needs review',
            author: 'carol',
            reviewers: [{ login: 'bob', waitedMs: 90_000_000, waitedLabel: '25 hours' }],
          },
        ],
      };

      const payload = buildDailyDigestSlackPayload('#reviews', 'octocat/hello-world', digest);
      const approvedText = sectionText(payload.blocks[1]);
      const staleText = sectionText(payload.blocks[3]);

      expect(payload.blocks.map((block) => block.type)).toEqual([
        'section',
        'section',
        'divider',
        'section',
      ]);
      expect(approvedText).toContain(
        '<https://github.com/octocat/hello-world/pull/9|Approved but waiting>'
      );
      expect(staleText).toContain('<https://github.com/octocat/hello-world/pull/10|Needs review>');
      expect(staleText).toContain('`bob` (25 hours)');
      expect(serializedBlocks(payload.blocks)).not.toContain('<@');
    });

    test('escapes Slack mrkdwn control characters in titles, authors, reviewers, and wait labels', () => {
      const payload = buildDailyDigestSlackPayload('#reviews', 'octo&cat/repo<main>', {
        approvedUnmerged: [
          {
            prUrl: 'https://github.com/octo/repo/pull/3?x=1&y=<bad>',
            prNumber: 3,
            title: 'Fix & <broken> > thing',
            author: 'dev&<@U999>`name',
          },
        ],
        staleAwaitingReview: [
          {
            prUrl: 'https://github.com/octo/repo/pull/4',
            prNumber: 4,
            title: 'Review <this> & that',
            author: 'author<raw>',
            reviewers: [
              {
                login: 'reviewer&<@U123>`name',
                waitedMs: 90_000_000,
                waitedLabel: '25 <hours> & counting',
              },
            ],
          },
        ],
      });
      const blocks = serializedBlocks(payload.blocks);

      expect(blocks).toContain('octo&amp;cat/repo&lt;main&gt;');
      expect(blocks).toContain('Fix &amp; &lt;broken&gt; &gt; thing');
      expect(blocks).toContain("`dev&amp;&lt;@U999&gt;'name`");
      expect(blocks).toContain('Review &lt;this&gt; &amp; that');
      expect(blocks).toContain("`reviewer&amp;&lt;@U123&gt;'name`");
      expect(blocks).toContain('25 &lt;hours&gt; &amp; counting');
      expect(blocks).not.toContain('Fix & <broken>');
      expect(blocks).not.toContain('repo<main>');
      expect(blocks).not.toContain('<@U123>');
      expect(blocks).not.toContain('<@U999>');
    });

    test('chunks a large bucket across multiple section blocks under the Slack size limit', () => {
      const approvedUnmerged = Array.from({ length: 200 }, (_, index) => ({
        prUrl: `https://github.com/octocat/hello-world/pull/${index}`,
        prNumber: index,
        title: `A reasonably long pull request title number ${index} that takes up space`,
        author: `contributor-${index}`,
      }));

      const payload = buildDailyDigestSlackPayload('#reviews', 'octocat/hello-world', {
        approvedUnmerged,
        staleAwaitingReview: [],
      });

      const sectionBlocks = payload.blocks.filter((block) => block.type === 'section');
      // header + multiple approved sections
      expect(sectionBlocks.length).toBeGreaterThan(2);
      for (const block of sectionBlocks) {
        expect(sectionText(block).length).toBeLessThanOrEqual(2900);
      }
      // Every PR line is still present across the chunked blocks.
      const allText = serializedBlocks(payload.blocks);
      expect(allText).toContain('/pull/0|');
      expect(allText).toContain('/pull/199|');
      // Title only appears on the first approved section block, not repeated per chunk.
      const titleOccurrences = sectionBlocks.filter((block) =>
        sectionText(block).includes('*Approved, not yet merged*')
      ).length;
      expect(titleOccurrences).toBe(1);
    });
  });

  describe('postDailyDigestMessage with injected sender', () => {
    const config = buildConfig({
      workspaces: {
        work: { token: 'xoxb-test-token' },
      },
    });

    test('returns ok without invoking sender when both buckets are empty', async () => {
      const calls: SlackPostSenderArgs[] = [];
      const fakeSender = async (args: SlackPostSenderArgs): Promise<SlackPostResult> => {
        calls.push(args);
        return { ok: true };
      };

      const result = await postDailyDigestMessage({
        config,
        workspace: 'work',
        channel: '#reviews',
        repoFullName: 'octocat/hello-world',
        digest: { approvedUnmerged: [], staleAwaitingReview: [] },
        sender: fakeSender,
      });

      expect(result).toEqual({ ok: true });
      expect(calls).toHaveLength(0);
    });

    test('calls sender once with the built payload when content is present', async () => {
      const calls: SlackPostSenderArgs[] = [];
      const fakeSender = async (args: SlackPostSenderArgs): Promise<SlackPostResult> => {
        calls.push(args);
        return { ok: true };
      };

      const result = await postDailyDigestMessage({
        config,
        workspace: 'work',
        channel: '#reviews',
        repoFullName: 'octocat/hello-world',
        digest: {
          approvedUnmerged: [
            {
              prUrl: 'https://github.com/octocat/hello-world/pull/1',
              prNumber: 1,
              title: 'Approved PR',
              author: 'alice',
            },
          ],
          staleAwaitingReview: [],
        },
        sender: fakeSender,
      });

      expect(result).toEqual({ ok: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].token).toBe('xoxb-test-token');
      expect(calls[0].payload.channel).toBe('#reviews');
      expect(serializedBlocks(calls[0].payload.blocks)).toContain('Approved PR');
    });
  });

  describe('postSlackTestMessage with injected sender', () => {
    const config = buildConfig({
      workspaces: {
        work: { token: 'xoxb-test-token' },
      },
    });

    test('builds a simple Slack payload and escapes mrkdwn control sequences in the block', () => {
      const payload = buildSlackTestMessagePayload('#reviews', 'Hello <!channel> & <@U123>');

      expect(payload.channel).toBe('#reviews');
      expect(payload.text).toBe('Hello <!channel> & <@U123>');
      expect(payload.blocks[0].text.text).toBe('Hello &lt;!channel&gt; &amp; &lt;@U123&gt;');
    });

    test('calls sender with resolved token and requested channel', async () => {
      const calls: SlackPostSenderArgs[] = [];
      const fakeSender = async (args: SlackPostSenderArgs): Promise<SlackPostResult> => {
        calls.push(args);
        return { ok: true };
      };

      const result = await postSlackTestMessage({
        config,
        workspace: 'work',
        channel: '#reviews',
        message: 'test from tim',
        sender: fakeSender,
      });

      expect(result).toEqual({ ok: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].token).toBe('xoxb-test-token');
      expect(calls[0].payload.channel).toBe('#reviews');
      expect(calls[0].payload.blocks[0].text.text).toBe('test from tim');
    });

    test('returns failure result when sender returns ok:false', async () => {
      const fakeSender = async (_args: SlackPostSenderArgs): Promise<SlackPostResult> => {
        return { ok: false, error: 'not_in_channel' };
      };

      const result = await postSlackTestMessage({
        config,
        workspace: 'work',
        channel: '#reviews',
        message: 'test from tim',
        sender: fakeSender,
      });

      expect(result).toEqual({ ok: false, error: 'not_in_channel' });
    });
  });

  describe('getSlackPostSender caching', () => {
    test('returns the same sender instance for the same token', () => {
      const sender1 = getSlackPostSender('xoxb-token-a');
      const sender2 = getSlackPostSender('xoxb-token-a');
      expect(sender1).toBe(sender2);
    });

    test('returns different instances for different tokens', () => {
      const sender1 = getSlackPostSender('xoxb-token-a');
      const sender2 = getSlackPostSender('xoxb-token-b');
      expect(sender1).not.toBe(sender2);
    });

    test('clearSlackClientCache causes a fresh sender to be returned', () => {
      const sender1 = getSlackPostSender('xoxb-token-a');
      clearSlackClientCache();
      const sender2 = getSlackPostSender('xoxb-token-a');
      expect(sender1).not.toBe(sender2);
    });
  });

  describe('createFetchSlackSender', () => {
    const payload = buildReviewRequestSlackPayload('#reviews', testPr, [mappedReviewer]);

    test('returns ok:true when Slack returns HTTP ok and ok:true body', async () => {
      const fetchImpl = vi.fn(async () =>
        buildFetchResponse({ ok: true, status: 200, jsonBody: { ok: true } })
      ) as unknown as typeof fetch;
      const sender = createFetchSlackSender('xoxb-token', fetchImpl);

      const result = await sender({ token: 'xoxb-token', payload });

      expect(result).toEqual({ ok: true });
      expect(fetchImpl).toHaveBeenCalledOnce();
    });

    test('returns failure result on non-2xx HTTP response without throwing', async () => {
      const fetchImpl = vi.fn(async () =>
        buildFetchResponse({
          ok: false,
          status: 500,
          jsonBody: { ok: false },
          textBody: 'server exploded',
        })
      ) as unknown as typeof fetch;
      const sender = createFetchSlackSender('xoxb-token', fetchImpl);

      const result = await sender({ token: 'xoxb-token', payload });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('HTTP 500');
      expect(result.error).toContain('server exploded');
    });

    test('returns failure result on Slack ok:false body without throwing', async () => {
      const fetchImpl = vi.fn(async () =>
        buildFetchResponse({
          ok: true,
          status: 200,
          jsonBody: { ok: false, error: 'channel_not_found' },
        })
      ) as unknown as typeof fetch;
      const sender = createFetchSlackSender('xoxb-token', fetchImpl);

      const result = await sender({ token: 'xoxb-token', payload });

      expect(result).toEqual({ ok: false, error: 'channel_not_found' });
    });

    test('returns failure result on network exceptions without throwing', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch;
      const sender = createFetchSlackSender('xoxb-token', fetchImpl);

      const result = await sender({ token: 'xoxb-token', payload });

      expect(result).toEqual({ ok: false, error: 'network down' });
    });
  });
});
