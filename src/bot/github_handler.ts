import { db, commandHistory } from './db/index.js';
import { config } from './config.js';
import { log, warn, error, debugLog } from '../logging.js';
import crypto from 'node:crypto';

interface GitHubIssueCommentPayload {
  action: string;
  issue: {
    url: string;
    html_url: string;
    number: number;
    title: string;
    user: { login: string };
    body: string | null;
  };
  comment: {
    id: number;
    html_url: string;
    user: { login: string };
    body: string;
  };
  repository: {
    full_name: string;
    html_url: string;
  };
  sender: {
    login: string;
  };
}

async function verifyGitHubSignature(request: Request, rawBody: string): Promise<boolean> {
  if (!config.GITHUB_WEBHOOK_SECRET) {
    warn(
      'GITHUB_WEBHOOK_SECRET is not set. Skipping webhook signature validation. THIS IS INSECURE FOR PRODUCTION.'
    );
    return true;
  }

  const signature = request.headers.get('X-Hub-Signature-256');
  if (!signature) {
    warn('No X-Hub-Signature-256 header found on webhook request.');
    return false;
  }

  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', config.GITHUB_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex')}`;

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    warn('Webhook signature mismatch.');
    return false;
  }
  return true;
}

export async function handleGitHubWebhook(request: Request): Promise<Response> {
  const eventType = request.headers.get('X-GitHub-Event');
  debugLog(`Received GitHub webhook event: ${eventType}`);

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (err) {
    error('Failed to read webhook request body:', err);
    return new Response('Invalid request body', { status: 400 });
  }

  if (!(await verifyGitHubSignature(request, rawBody))) {
    return new Response('Signature verification failed', { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    error('Failed to parse webhook JSON payload:', err);
    return new Response('Invalid JSON payload', { status: 400 });
  }

  if (eventType === 'issue_comment' && payload.action === 'created') {
    await processIssueComment(payload as GitHubIssueCommentPayload);
    return new Response('Webhook processed', { status: 200 });
  }

  debugLog(`Ignoring event type: ${eventType}, action: ${payload.action}`);
  return new Response('Event type not handled', { status: 200 });
}

async function processIssueComment(payload: GitHubIssueCommentPayload): Promise<void> {
  const commenter = payload.sender.login;
  const commentBody = payload.comment.body;
  const issue = payload.issue;
  const repository = payload.repository;

  log(
    `New comment by ${commenter} on issue #${issue.number} (${issue.title}) in ${repository.full_name}`
  );
  debugLog(`Comment body: ${commentBody.substring(0, 100)}...`);

  const commandRegex = /@bot\s+(\w+)(?:\s+(.*))?/;
  const match = commentBody.match(commandRegex);

  if (!match) {
    debugLog('No bot command found in comment.');
    return;
  }

  const command = match[1].toLowerCase();
  const args = match[2]?.trim() || '';
  const fullCommand = `@bot ${command} ${args}`.trim();

  try {
    await db.insert(commandHistory).values({
      commandName: command,
      platform: 'github',
      userId: commenter,
      rawCommand: fullCommand,
      status: 'pending',
    });
  } catch (e) {
    error('Failed to log command to command_history:', e);
  }

  if (command === 'plan') {
    log(
      `'@bot plan' command received from ${commenter} for issue ${issue.html_url}. Args: '${args}'`
    );
  } else {
    log(`Unknown command: @bot ${command}`);
  }
}
