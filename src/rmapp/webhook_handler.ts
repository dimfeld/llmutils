import { createHmac } from 'node:crypto';
import type { WebhookEvent, GitHubAppConfig } from './types';
import { error, log } from '../logging';

export class WebhookHandler {
  constructor(private config: GitHubAppConfig) {}

  verifySignature(payload: string, signature: string | undefined): boolean {
    if (!signature) {
      return false;
    }

    const hmac = createHmac('sha256', this.config.webhookSecret);
    const digest = `sha256=${hmac.update(payload).digest('hex')}`;

    // Constant time comparison
    return (
      signature.length === digest.length &&
      signature.split('').every((char, i) => char === digest[i])
    );
  }

  isRelevantEvent(event: WebhookEvent): boolean {
    // We care about comments on issues and PRs that mention our bot
    if (!event.comment || !event.comment.body.includes(`@${this.config.botName}`)) {
      return false;
    }

    // Check if it's an issue comment or PR comment
    const isIssueComment = event.action === 'created' && event.issue;
    const isPRComment = event.action === 'created' && event.pull_request;

    return !!(isIssueComment || isPRComment);
  }

  async handleWebhook(headers: Record<string, string>, body: string): Promise<WebhookEvent | null> {
    // Verify webhook signature
    const signature = headers['x-hub-signature-256'];
    if (!this.verifySignature(body, signature)) {
      error('Invalid webhook signature');
      return null;
    }

    // Parse the event
    let event: WebhookEvent;
    try {
      event = JSON.parse(body);
    } catch (e) {
      error('Failed to parse webhook body:', e);
      return null;
    }

    // Check if we should process this event
    if (!this.isRelevantEvent(event)) {
      log('Ignoring irrelevant event');
      return null;
    }

    log(
      `Processing ${event.action} event on ${event.repository.owner.login}/${event.repository.name}`
    );
    return event;
  }
}
