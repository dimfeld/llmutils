import { db, commandHistory as commandHistoryTable } from './db/index.js';
import { config } from './config.js';
import { log, warn, error, debugLog } from '../logging.js';
import crypto from 'node:crypto';
import { startPlanGenerationTask, startImplementationTask } from './core/task_manager.js';
import { getGitRoot } from '../rmfilter/utils.js';
import { eq } from 'drizzle-orm';
import { canUserPerformAction } from './core/auth_manager.js';

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

  // Insert into command_history and get ID
  let originalCommandId: number | undefined;
  try {
    const insertedCmd = await db
      .insert(commandHistoryTable)
      .values({
        commandName: command,
        platform: 'github',
        userId: commenter,
        rawCommand: fullCommand,
        status: 'pending_auth',
      })
      .returning({ id: commandHistoryTable.id });
    originalCommandId = insertedCmd[0]?.id;
  } catch (e) {
    error('Failed to log command to command_history:', e);
  }

  if (!originalCommandId) {
    error('Failed to record command in history, aborting processing.');
    return;
  }

  // Perform permission check
  const hasPermission = await canUserPerformAction(commenter, repository.full_name);
  if (!hasPermission) {
    warn(
      `User ${commenter} does not have sufficient permissions for ${repository.full_name} to run command '@bot ${command}'.`
    );
    await db
      .update(commandHistoryTable)
      .set({ status: 'failed', errorMessage: 'Permission denied' })
      .where(eq(commandHistoryTable.id, originalCommandId));

    // For now, we just log and return.
    // TODO: Post a reply comment (future enhancement)
    return;
  }

  // If permission check passes, update status to 'processing'
  await db
    .update(commandHistoryTable)
    .set({ status: 'processing' })
    .where(eq(commandHistoryTable.id, originalCommandId));

  if (command === 'plan') {
    log(
      `'@bot plan' command received from ${commenter} for issue ${issue.html_url}. Args: '${args}'`
    );

    // Determine the target issue URL
    const targetIssueUrl = args && args.startsWith('http') ? args : issue.html_url;
    const repoFullName = repository.full_name;

    // Get originalCommandId (we already have it from the insert above)
    if (!originalCommandId) {
      error('Failed to get command ID from command_history insert');
      return;
    }

    // Determine repoPath
    let repoPath: string;
    try {
      // This assumes the bot is running in a checkout of the *target* repository.
      // For MVP, we'll proceed with this assumption.
      repoPath = await getGitRoot();
      if (!repoPath) throw new Error('Could not determine git root.');

      // Optional: Check if this repo matches the webhook's repository
      // For now, we'll just log a warning if there might be a mismatch
      debugLog(`Using repo path: ${repoPath} for repository: ${repoFullName}`);
    } catch (e) {
      error('Failed to determine repository path for plan generation:', e);
      // Update command_history to 'failed'
      await db
        .update(commandHistoryTable)
        .set({
          status: 'failed',
          errorMessage: 'Failed to determine repo path',
        })
        .where(eq(commandHistoryTable.id, originalCommandId));
      // TODO: Post a comment back to GitHub about the failure
      return;
    }

    // Asynchronously start the plan generation
    startPlanGenerationTask({
      platform: 'github',
      userId: commenter,
      issueUrl: targetIssueUrl,
      repoFullName: repoFullName,
      repoPath: repoPath,
      githubCommentId: payload.comment.id,
      originalCommandId: originalCommandId,
    })
      .then((taskId) => {
        if (taskId) {
          log(`Successfully started plan generation task ${taskId} from GitHub command.`);
          // Further notifications will be handled by thread_manager
        } else {
          log(`Plan generation task failed to start from GitHub command.`);
          // Error already logged by startPlanGenerationTask
        }
      })
      .catch((e) => {
        error('Unhandled error from startPlanGenerationTask (GitHub):', e);
      });

    // The webhook returns quickly while plan generation happens in background
  } else if (command === 'implement') {
    log(
      `'@bot implement' command received from ${commenter} for issue ${issue.html_url}. Args: '${args}'`
    );

    // Determine the target issue URL
    const targetIssueUrl = args && args.startsWith('http') ? args : issue.html_url;
    const repoFullName = repository.full_name;

    // Determine repoPath
    let repoPath: string;
    try {
      // This assumes the bot is running in a checkout of the *target* repository.
      // For MVP, we'll proceed with this assumption.
      repoPath = await getGitRoot();
      if (!repoPath) throw new Error('Could not determine git root.');

      // Optional: Check if this repo matches the webhook's repository
      // For now, we'll just log a warning if there might be a mismatch
      debugLog(`Using repo path: ${repoPath} for repository: ${repoFullName}`);
    } catch (e) {
      error('Failed to determine repository path for implementation:', e);
      // Update command_history to 'failed'
      await db
        .update(commandHistoryTable)
        .set({
          status: 'failed',
          errorMessage: 'Failed to determine repo path',
        })
        .where(eq(commandHistoryTable.id, originalCommandId));
      // TODO: Post a comment back to GitHub about the failure
      return;
    }

    // Asynchronously start the implementation
    startImplementationTask({
      platform: 'github',
      userId: commenter,
      issueUrl: targetIssueUrl,
      repoFullName: repoFullName,
      repoPath: repoPath,
      githubCommentId: payload.comment.id,
      originalCommandId: originalCommandId,
    })
      .then((taskId) => {
        if (taskId) {
          log(`Successfully started implementation task ${taskId} from GitHub command.`);
          // Further notifications will be handled by thread_manager
        } else {
          log(`Implementation task failed to start from GitHub command.`);
          // Error already logged by startImplementationTask
        }
      })
      .catch((e) => {
        error('Unhandled error from startImplementationTask (GitHub):', e);
      });

    // The webhook returns quickly while implementation happens in background
  } else {
    log(`Unknown command: @bot ${command}`);
    // Update command_history to 'failed' for unknown commands
    if (originalCommandId) {
      await db
        .update(commandHistoryTable)
        .set({
          status: 'failed',
          errorMessage: 'Unknown command',
        })
        .where(eq(commandHistoryTable.id, originalCommandId));
    }
  }
}
