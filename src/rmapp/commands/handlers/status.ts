import { CommandHandler, type EnhancedCommand, type CommandDefinition } from '../types.js';
import type { ExecutionContext } from '../../types.js';
import { WORKFLOW_COMMANDS } from '../definitions.js';
import { StateStore } from '../../state/store.js';
import { formatDistanceToNow } from 'date-fns';

export class StatusHandler extends CommandHandler {
  readonly definition: CommandDefinition = WORKFLOW_COMMANDS.status;

  constructor(private store: StateStore) {
    super();
  }

  async execute(command: EnhancedCommand, context: ExecutionContext): Promise<void> {
    const verbose = command.options.verbose === true;
    const json = command.options.json === true;
    const workflowId = command.options['workflow-id'] as string | undefined;

    let workflows;
    if (workflowId) {
      const workflow = await this.store.getWorkflow(workflowId);
      workflows = workflow ? [workflow] : [];
    } else {
      workflows = await this.store.listActiveWorkflows();
    }

    if (json) {
      // Post JSON response
      const response = {
        workflows: workflows.map((w) => ({
          id: w.id,
          type: w.type,
          status: w.status,
          repository: w.repository,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
          metadata: w.metadata,
        })),
      };

      await this.postComment(context, `\`\`\`json\n${JSON.stringify(response, null, 2)}\n\`\`\``);
    } else {
      // Format human-readable status
      const lines: string[] = ['## 📊 Workflow Status\n'];

      if (workflows.length === 0) {
        lines.push('No active workflows found.');
      } else {
        for (const workflow of workflows) {
          lines.push(this.formatWorkflow(workflow, verbose));
        }
      }

      await this.postComment(context, lines.join('\n'));
    }
  }

  private formatWorkflow(workflow: any, verbose: boolean): string {
    const lines: string[] = [];

    const statusEmoji: Record<string, string> = {
      pending: '⏳',
      in_progress: '🔄',
      completed: '✅',
      failed: '❌',
      cancelled: '🚫',
    };
    const emoji = statusEmoji[workflow.status] || '❓';

    lines.push(`### ${emoji} ${workflow.type === 'issue' ? 'Issue' : 'PR'} Workflow`);
    lines.push(`- **ID**: \`${workflow.id}\``);
    lines.push(`- **Status**: ${workflow.status}`);
    lines.push(`- **Repository**: ${workflow.repository.owner}/${workflow.repository.name}`);

    if (workflow.type === 'issue') {
      lines.push(`- **Issue**: #${workflow.issueNumber} - ${workflow.issueTitle}`);
      if (workflow.steps) {
        lines.push('- **Progress**:');
        lines.push(`  - Analyzed: ${workflow.steps.analyzed ? '✅' : '⏳'}`);
        lines.push(`  - Plan Generated: ${workflow.steps.planGenerated ? '✅' : '⏳'}`);
        lines.push(`  - Implemented: ${workflow.steps.implemented ? '✅' : '⏳'}`);
        lines.push(`  - PR Created: ${workflow.steps.prCreated ? '✅' : '⏳'}`);
      }
    } else if (workflow.type === 'pr_review') {
      lines.push(`- **PR**: #${workflow.prNumber} - ${workflow.prTitle}`);
      if (workflow.steps) {
        lines.push('- **Progress**:');
        lines.push(`  - Comments Parsed: ${workflow.steps.commentsParsed ? '✅' : '⏳'}`);
        lines.push(`  - Changes Applied: ${workflow.steps.changesApplied ? '✅' : '⏳'}`);
        lines.push(`  - Responded: ${workflow.steps.responded ? '✅' : '⏳'}`);
      }
    }

    lines.push(`- **Started**: ${formatDistanceToNow(workflow.createdAt, { addSuffix: true })}`);
    lines.push(
      `- **Last Updated**: ${formatDistanceToNow(workflow.updatedAt, { addSuffix: true })}`
    );

    if (workflow.error) {
      lines.push(`- **Error**: ${workflow.error}`);
    }

    if (verbose && workflow.metadata) {
      lines.push('\n**Metadata**:');
      lines.push('```json');
      lines.push(JSON.stringify(workflow.metadata, null, 2));
      lines.push('```');
    }

    lines.push('');
    return lines.join('\n');
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
}
