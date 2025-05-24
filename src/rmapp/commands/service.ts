import type { ExecutionContext } from '../types.js';
import { EnhancedCommandParser } from './parser.js';
import { CommandRouter } from './router.js';
import { BranchCommandQueue } from './queue.js';
import { WorkflowExecutor } from '../workflows/executor.js';
import { StateStore } from '../state/store.js';
import {
  ImplementIssueHandler,
  StatusHandler,
  HelpHandler,
  RmfilterHandler,
  RmplanHandler,
  RmrunHandler,
} from './handlers/index.js';
import type { EnhancedCommand } from './types.js';
import { log } from '../../logging.js';

export class CommandService {
  private parser: EnhancedCommandParser;
  private router: CommandRouter;
  private queue: BranchCommandQueue;
  private store: StateStore;

  constructor(
    botName: string,
    private workflowExecutor: WorkflowExecutor,
    stateStore: StateStore
  ) {
    this.parser = new EnhancedCommandParser(botName);
    this.router = new CommandRouter();
    this.queue = new BranchCommandQueue();
    this.store = stateStore;

    // Register handlers
    this.registerHandlers();

    // Set up queue event handlers
    this.setupQueueHandlers();
  }

  private registerHandlers(): void {
    // Workflow handlers
    this.router.register('implement', new ImplementIssueHandler(this.workflowExecutor));
    this.router.register('status', new StatusHandler(this.store));

    // Help handler
    this.router.register('help', new HelpHandler());

    // Tool handlers
    this.router.register('rmfilter', new RmfilterHandler());
    this.router.register('rmplan', new RmplanHandler());
    this.router.register('rmrun', new RmrunHandler());

    // TODO: Add more handlers as we implement them
    // this.router.register('apply-review', new ApplyReviewHandler(this.workflowExecutor));
    // this.router.register('cancel', new CancelHandler(this.workflowExecutor));
    // this.router.register('retry', new RetryHandler(this.workflowExecutor));
  }

  private setupQueueHandlers(): void {
    this.queue.on('command:queued', (execution) => {
      log(`Command queued on branch ${execution.branch}: ${execution.command.command}`);
    });

    this.queue.on('command:started', (execution) => {
      log(`Command started on branch ${execution.branch}: ${execution.command.command}`);
    });

    this.queue.on('command:completed', (execution) => {
      log(`Command completed on branch ${execution.branch}: ${execution.command.command}`);
    });

    this.queue.on('command:failed', (execution, error) => {
      log(
        `Command failed on branch ${execution.branch}: ${execution.command.command} - ${error.message}`
      );
    });
  }

  async processCommand(
    commentBody: string,
    context: ExecutionContext
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Parse the command
      const command = this.parser.parse(commentBody, {
        issueNumber: context.event.issue?.number,
        prNumber: context.event.pull_request?.number,
      });

      if (!command) {
        return { success: false, error: 'No valid command found' };
      }

      log(`Parsed command: ${JSON.stringify(command)}`);

      // Handle help command immediately without queueing
      if (command.command === 'help' || command.command === 'status') {
        await this.router.route(command, context);
        return { success: true };
      }

      // For workflow commands, check branch availability
      if (command.type === 'workflow' && command.branch) {
        const canExecute = await this.queue.canExecute(command, command.branch);

        if (!canExecute) {
          await this.postBusyMessage(context, command);
        }

        // Enqueue the command
        const execution = await this.queue.enqueue(command);

        // If queued (not running immediately), we're done for now
        if (execution.status === 'queued') {
          return { success: true };
        }
      }

      // Execute the command
      try {
        await this.router.routeWithSubcommands(command, context);

        // Mark as complete if it was queued
        if (command.branch) {
          await this.queue.complete(command.branch, true);
        }

        return { success: true };
      } catch (error) {
        // Mark as failed if it was queued
        if (command.branch) {
          await this.queue.fail(command.branch, error as Error);
        }
        throw error;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`Command processing failed: ${errorMessage}`);

      // Post error message
      await this.postErrorMessage(context, errorMessage);

      return { success: false, error: errorMessage };
    }
  }

  private async postBusyMessage(
    context: ExecutionContext,
    command: EnhancedCommand
  ): Promise<void> {
    const status = this.queue.getStatus(command.branch);
    const activeCommand = status.active[0];
    const queueLength = status.queued.length;

    const message = [
      `⏳ Branch \`${command.branch}\` is currently busy with another command.`,
      ``,
      `**Active command**: ${activeCommand?.command.command}`,
      `**Queue length**: ${queueLength}`,
      ``,
      `Your command has been added to the queue and will execute when the branch is available.`,
    ].join('\n');

    await this.postComment(context, message);
  }

  private async postErrorMessage(context: ExecutionContext, error: string): Promise<void> {
    const message = [
      `❌ Command failed with error:`,
      ``,
      `\`\`\``,
      error,
      `\`\`\``,
      ``,
      `Please check the command syntax and try again. Use \`@bot help\` to see available commands.`,
    ].join('\n');

    await this.postComment(context, message);
  }

  private async postComment(context: ExecutionContext, body: string): Promise<void> {
    if (context.event.issue) {
      await context.octokit.rest.issues.createComment({
        owner: context.event.repository.owner.login,
        repo: context.event.repository.name,
        issue_number: context.event.issue.number,
        body,
      });
    } else if (context.event.pull_request) {
      await context.octokit.rest.issues.createComment({
        owner: context.event.repository.owner.login,
        repo: context.event.repository.name,
        issue_number: context.event.pull_request.number,
        body,
      });
    }
  }

  getQueueStatus(): { active: any[]; queued: any[] } {
    return this.queue.getStatus();
  }
}
