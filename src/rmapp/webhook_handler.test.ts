import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { WebhookHandler } from './webhook_handler';
import type { WebhookEvent, GitHubAppConfig } from './types';

describe('WebhookHandler', () => {
  const config: GitHubAppConfig = {
    appId: 'test-app-id',
    privateKey: 'test-private-key',
    webhookSecret: 'test-secret',
    botName: 'testbot',
  };

  const handler = new WebhookHandler(config);

  describe('verifySignature', () => {
    test('verifies valid signature', () => {
      const payload = '{"test": "data"}';
      const hmac = createHmac('sha256', config.webhookSecret);
      const signature = `sha256=${hmac.update(payload).digest('hex')}`;

      expect(handler.verifySignature(payload, signature)).toBe(true);
    });

    test('rejects invalid signature', () => {
      const payload = '{"test": "data"}';
      const signature = 'sha256=invalid';

      expect(handler.verifySignature(payload, signature)).toBe(false);
    });

    test('rejects missing signature', () => {
      const payload = '{"test": "data"}';

      expect(handler.verifySignature(payload, undefined)).toBe(false);
    });
  });

  describe('isRelevantEvent', () => {
    test('accepts issue comment with bot mention', () => {
      const event: WebhookEvent = {
        action: 'created',
        issue: {
          number: 123,
          title: 'Test Issue',
          body: 'Issue body',
          html_url: 'https://github.com/owner/repo/issues/123',
        },
        comment: {
          id: 1,
          body: 'Hey @testbot rmplan generate',
          user: { login: 'user' },
        },
        repository: {
          owner: { login: 'owner' },
          name: 'repo',
          clone_url: 'https://github.com/owner/repo.git',
        },
      };

      expect(handler.isRelevantEvent(event)).toBe(true);
    });

    test('accepts PR comment with bot mention', () => {
      const event: WebhookEvent = {
        action: 'created',
        pull_request: {
          number: 456,
          title: 'Test PR',
          body: 'PR body',
          html_url: 'https://github.com/owner/repo/pull/456',
        },
        comment: {
          id: 2,
          body: '@testbot please run rmfilter',
          user: { login: 'user' },
        },
        repository: {
          owner: { login: 'owner' },
          name: 'repo',
          clone_url: 'https://github.com/owner/repo.git',
        },
      };

      expect(handler.isRelevantEvent(event)).toBe(true);
    });

    test('ignores comment without bot mention', () => {
      const event: WebhookEvent = {
        action: 'created',
        issue: {
          number: 123,
          title: 'Test Issue',
          body: 'Issue body',
          html_url: 'https://github.com/owner/repo/issues/123',
        },
        comment: {
          id: 3,
          body: 'Just a regular comment',
          user: { login: 'user' },
        },
        repository: {
          owner: { login: 'owner' },
          name: 'repo',
          clone_url: 'https://github.com/owner/repo.git',
        },
      };

      expect(handler.isRelevantEvent(event)).toBe(false);
    });

    test('ignores non-created actions', () => {
      const event: WebhookEvent = {
        action: 'edited',
        issue: {
          number: 123,
          title: 'Test Issue',
          body: 'Issue body',
          html_url: 'https://github.com/owner/repo/issues/123',
        },
        comment: {
          id: 4,
          body: '@testbot rmplan generate',
          user: { login: 'user' },
        },
        repository: {
          owner: { login: 'owner' },
          name: 'repo',
          clone_url: 'https://github.com/owner/repo.git',
        },
      };

      expect(handler.isRelevantEvent(event)).toBe(false);
    });

    test('ignores events without comments', () => {
      const event: WebhookEvent = {
        action: 'opened',
        issue: {
          number: 123,
          title: 'Test Issue',
          body: 'Issue body with @testbot',
          html_url: 'https://github.com/owner/repo/issues/123',
        },
        repository: {
          owner: { login: 'owner' },
          name: 'repo',
          clone_url: 'https://github.com/owner/repo.git',
        },
      };

      expect(handler.isRelevantEvent(event)).toBe(false);
    });
  });

  describe('handleWebhook', () => {
    test('processes valid webhook', async () => {
      const payload = JSON.stringify({
        action: 'created',
        issue: {
          number: 123,
          title: 'Test Issue',
          body: 'Issue body',
          html_url: 'https://github.com/owner/repo/issues/123',
        },
        comment: {
          id: 1,
          body: '@testbot rmplan generate',
          user: { login: 'user' },
        },
        repository: {
          owner: { login: 'owner' },
          name: 'repo',
          clone_url: 'https://github.com/owner/repo.git',
        },
        installation: {
          id: 12345,
        },
      });

      const hmac = createHmac('sha256', config.webhookSecret);
      const signature = `sha256=${hmac.update(payload).digest('hex')}`;

      const headers = {
        'x-hub-signature-256': signature,
      };

      const result = await handler.handleWebhook(headers, payload);
      expect(result).toBeTruthy();
      expect(result?.action).toBe('created');
      expect(result?.issue?.number).toBe(123);
    });

    test('rejects invalid signature', async () => {
      const payload = JSON.stringify({
        action: 'created',
        comment: { body: '@testbot test' },
      });

      const headers = {
        'x-hub-signature-256': 'sha256=invalid',
      };

      const result = await handler.handleWebhook(headers, payload);
      expect(result).toBeNull();
    });

    test('ignores irrelevant events', async () => {
      const payload = JSON.stringify({
        action: 'created',
        comment: { body: 'No bot mention here' },
        repository: {
          owner: { login: 'owner' },
          name: 'repo',
          clone_url: 'https://github.com/owner/repo.git',
        },
      });

      const hmac = createHmac('sha256', config.webhookSecret);
      const signature = `sha256=${hmac.update(payload).digest('hex')}`;

      const headers = {
        'x-hub-signature-256': signature,
      };

      const result = await handler.handleWebhook(headers, payload);
      expect(result).toBeNull();
    });
  });
});
