import { CommandHandler, type EnhancedCommand, type CommandDefinition } from '../types.js';
import type { ExecutionContext } from '../../types.js';
import { WORKFLOW_COMMANDS } from '../definitions.js';
import { WorkflowExecutor } from '../../workflows/executor.js';
import { log } from '../../../logging.js';

export class ImplementIssueHandler extends CommandHandler {
  readonly definition: CommandDefinition = WORKFLOW_COMMANDS.implement;

  constructor(private workflowExecutor: WorkflowExecutor) {
    super();
  }

  async execute(command: EnhancedCommand, context: ExecutionContext): Promise<void> {
    // Extract issue number
    const issueNumber = command.issueNumber || this.parseIssueNumber(command.args[0]);
    if (!issueNumber) {
      throw new Error('Could not determine issue number from command');
    }

    log(`Starting implementation workflow for issue #${issueNumber}`);

    // Create webhook event for the workflow
    const webhookEvent = {
      action: 'opened',
      issue: {
        number: issueNumber,
        title: `Issue #${issueNumber}`, // Will be fetched by workflow
        body: '',
        html_url: `https://github.com/${context.event.repository.owner.login}/${context.event.repository.name}/issues/${issueNumber}`,
      },
      repository: context.event.repository,
      installation: context.event.installation,
    };

    // Start the workflow
    const workflowId = await this.workflowExecutor.executeIssue(webhookEvent);

    // Post initial comment
    await context.octokit.rest.issues.createComment({
      owner: context.event.repository.owner.login,
      repo: context.event.repository.name,
      issue_number: issueNumber,
      body: `🚀 Starting implementation for issue #${issueNumber}\n\nWorkflow ID: \`${workflowId}\`\n\nI'll analyze the issue, create a plan, implement the changes, and open a PR when ready.`,
    });

    log(`Implementation workflow started with ID: ${workflowId}`);
  }

  private parseIssueNumber(arg: string): number | null {
    // Handle #123 format
    const hashMatch = arg.match(/^#(\d+)$/);
    if (hashMatch) {
      return parseInt(hashMatch[1], 10);
    }

    // Handle plain number
    const num = parseInt(arg, 10);
    if (!isNaN(num)) {
      return num;
    }

    // Handle GitHub URL
    const urlMatch = arg.match(/\/issues\/(\d+)/);
    if (urlMatch) {
      return parseInt(urlMatch[1], 10);
    }

    return null;
  }
}
