import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GitHubAppConfig, WebhookEvent } from './types';
import { WebhookHandler } from './webhook_handler';
import { MentionParser } from './mention_parser';
import { GitHubAuth } from './github_auth';
import { CommandExecutor } from './command_executor';
import { error, log } from '../logging';

export class GitHubAppServer {
  private webhookHandler: WebhookHandler;
  private mentionParser: MentionParser;
  private githubAuth: GitHubAuth;
  private server: ReturnType<typeof createServer>;

  constructor(private config: GitHubAppConfig) {
    this.webhookHandler = new WebhookHandler(config);
    this.mentionParser = new MentionParser(config.botName);
    this.githubAuth = new GitHubAuth(config);

    this.server = createServer(this.handleRequest.bind(this));
  }

  start(): void {
    const port = this.config.port || 3000;
    this.server.listen(port, () => {
      log(`GitHub App server listening on port ${port}`);
      log(`Bot name: @${this.config.botName}`);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        log('Server stopped');
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    try {
      // Read the request body
      const body = await this.readBody(req);

      // Convert headers to a plain object
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') {
          headers[key] = value;
        } else if (Array.isArray(value)) {
          headers[key] = value[0];
        }
      }

      // Handle the webhook
      const event = await this.webhookHandler.handleWebhook(headers, body);

      if (!event) {
        res.writeHead(200);
        res.end('OK - Event ignored');
        return;
      }

      // Process the event asynchronously
      this.processEvent(event).catch((e) => {
        error('Failed to process event:', e);
      });

      res.writeHead(200);
      res.end('OK - Processing');
    } catch (e) {
      error('Error handling webhook:', e);
      res.writeHead(500);
      res.end('Internal server error');
    }
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        resolve(body);
      });
      req.on('error', reject);
    });
  }

  private async processEvent(event: WebhookEvent): Promise<void> {
    if (!event.comment || !event.installation) {
      return;
    }

    // Parse the command from the comment
    const command = this.mentionParser.parse(event.comment.body);
    if (!command) {
      log('No valid command found in comment');
      return;
    }

    log(`Parsed command: ${command.command} with args:`, command.args);

    // Get authenticated Octokit for this installation
    const octokit = await this.githubAuth.getInstallationOctokit(event.installation.id);
    if (!octokit) {
      error('Failed to get installation Octokit');
      return;
    }

    // Create a unique workspace directory name
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const workspaceDir = `rmapp-${event.repository.name}-${timestamp}`;

    // Execute the command
    const executor = new CommandExecutor({
      octokit,
      event,
      workspaceDir,
      command,
    });

    await executor.execute();
  }
}
