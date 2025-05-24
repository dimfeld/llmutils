import { WorkflowNode } from './base_node.js';
import { FinalNode, ErrorNode } from '../../state_machine/nodes.js';
import type { SharedStore } from '../../state_machine/store.js';
import type { StateResult } from '../../state_machine/types.js';
import type {
  WorkflowEvent,
  IssueWorkflowContext,
  IssueAnalysis,
  NodeExecutionResult,
} from './types.js';
import type { ClaudeCodeExecutorOptions } from '../../rmplan/executors/claude_code.js';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

export type IssueWorkflowState =
  | 'analyzing'
  | 'planning'
  | 'implementing'
  | 'testing'
  | 'creating_pr'
  | 'complete'
  | 'failed';

// Analyze Issue Node
export class AnalyzeIssueNode extends WorkflowNode<
  'analyzing',
  IssueWorkflowContext,
  void,
  IssueWorkflowState
> {
  protected claudeCodeConfig: Partial<ClaudeCodeExecutorOptions> = {
    allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch'],
    includeDefaultTools: false,
  };
  protected model = 'claude-3-5-sonnet-20241022';

  protected shouldProcessEvent(event: WorkflowEvent): boolean {
    return event.type === 'workflow_start';
  }

  protected async prepareArgs(context: IssueWorkflowContext): Promise<void> {
    return undefined;
  }

  protected getPrompt(args: void, context: IssueWorkflowContext): string {
    return `Analyze this GitHub issue and extract key information.

Issue #${context.issueNumber}: ${context.issueTitle}

${context.issueBody}

Please analyze and provide:
1. Key requirements (bullet points)
2. Files and areas likely to be affected
3. Suggested implementation approach
4. Complexity assessment (simple/medium/complex)
5. Any relevant tags or labels

Repository: ${context.webhookEvent.repository.owner.login}/${context.webhookEvent.repository.name}

Focus on understanding what needs to be done and where in the codebase changes will be needed.`;
  }

  protected async processExecutorResult(
    result: any,
    args: void,
    context: IssueWorkflowContext
  ): Promise<NodeExecutionResult> {
    try {
      // Parse the Claude response to extract analysis
      const analysis: IssueAnalysis = {
        requirements: this.extractBulletPoints(result, 'requirements'),
        affectedFiles: this.extractFileList(result),
        suggestedApproach: this.extractSection(result, 'approach'),
        complexity: this.extractComplexity(result),
        tags: this.extractTags(result),
      };

      // Update the workflow
      await context.store.updateIssueWorkflowStep(context.workflowId, 'analyzed', true);

      return {
        success: true,
        artifacts: { analysis },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to parse analysis',
      };
    }
  }

  private extractBulletPoints(text: string, section: string): string[] {
    const sectionRegex = new RegExp(`${section}[:\\s]*([\\s\\S]*?)(?=\\n\\n|\\d+\\.|$)`, 'i');
    const match = text.match(sectionRegex);
    if (!match) return [];

    const bulletRegex = /[-*•]\s*(.+)/g;
    const bullets = [];
    let bulletMatch;
    while ((bulletMatch = bulletRegex.exec(match[1])) !== null) {
      bullets.push(bulletMatch[1].trim());
    }
    return bullets;
  }

  private extractFileList(text: string): string[] {
    const fileRegex = /(?:src\/|tests?\/|lib\/|app\/)[^\s,]+\.[a-zA-Z]+/g;
    const matches = text.match(fileRegex) || [];
    return [...new Set(matches)];
  }

  private extractSection(text: string, section: string): string {
    const sectionRegex = new RegExp(`${section}[:\\s]*([\\s\\S]*?)(?=\\n\\n|\\d+\\.|$)`, 'i');
    const match = text.match(sectionRegex);
    return match ? match[1].trim() : '';
  }

  private extractComplexity(text: string): 'simple' | 'medium' | 'complex' {
    const complexityMatch = text.match(/complexity[:\s]*(simple|medium|complex)/i);
    return (complexityMatch?.[1]?.toLowerCase() as any) || 'medium';
  }

  private extractTags(text: string): string[] {
    const tagMatch = text.match(/tags?[:\s]*([^\n]+)/i);
    if (!tagMatch) return [];
    return tagMatch[1].split(/[,\s]+/).filter((tag) => tag.length > 0);
  }

  protected getNextState(): IssueWorkflowState {
    return 'planning';
  }

  protected getErrorState(): IssueWorkflowState {
    return 'failed';
  }
}

// Generate Plan Node
export class GeneratePlanNode extends WorkflowNode<
  'planning',
  IssueWorkflowContext,
  IssueAnalysis,
  IssueWorkflowState
> {
  protected claudeCodeConfig: Partial<ClaudeCodeExecutorOptions> = {
    allowedTools: ['Read', 'Glob', 'Grep', 'Write'],
    includeDefaultTools: false,
  };
  protected model = 'claude-3-5-sonnet-20241022';

  protected shouldProcessEvent(event: WorkflowEvent): boolean {
    return event.type === 'workflow_step_complete' && event.step === 'analyzing';
  }

  protected async prepareArgs(context: IssueWorkflowContext): Promise<IssueAnalysis> {
    const analysis = context.artifacts.get('analysis');
    if (!analysis) {
      throw new Error('No analysis available');
    }
    return analysis;
  }

  protected getPrompt(args: IssueAnalysis, context: IssueWorkflowContext): string {
    return `Generate an implementation plan for this issue.

Issue: ${context.issueTitle}

Analysis:
${JSON.stringify(args, null, 2)}

Create a step-by-step plan in YAML format that can be executed by rmplan.
The plan should include:
1. Clear, actionable steps
2. Files to modify or create
3. Testing requirements
4. Any necessary refactoring

Save the plan to: tasks/issue-${context.issueNumber}-plan.yml

Make sure each step has clear instructions that an AI assistant can follow.`;
  }

  protected async processExecutorResult(
    result: any,
    args: IssueAnalysis,
    context: IssueWorkflowContext
  ): Promise<NodeExecutionResult> {
    const planPath = join(
      context.workspaceDir || process.cwd(),
      `tasks/issue-${context.issueNumber}-plan.yml`
    );

    if (existsSync(planPath)) {
      await context.store.updateIssueWorkflowStep(context.workflowId, 'planGenerated', true);
      await context.store.updateIssueWorkflowData(context.workflowId, { planPath });

      return {
        success: true,
        artifacts: { planPath },
      };
    }

    return {
      success: false,
      error: 'Plan file not created',
    };
  }

  protected getNextState(): IssueWorkflowState {
    return 'implementing';
  }

  protected getErrorState(): IssueWorkflowState {
    return 'failed';
  }
}

// Implement Issue Node
export class ImplementIssueNode extends WorkflowNode<
  'implementing',
  IssueWorkflowContext,
  string,
  IssueWorkflowState
> {
  protected claudeCodeConfig: Partial<ClaudeCodeExecutorOptions> = {
    includeDefaultTools: true,
    allowedTools: ['TodoWrite', 'TodoRead'],
  };
  protected model = 'claude-3-5-sonnet-20241022';

  protected shouldProcessEvent(event: WorkflowEvent): boolean {
    return event.type === 'workflow_step_complete' && event.step === 'planning';
  }

  protected async prepareArgs(context: IssueWorkflowContext): Promise<string> {
    const planPath = context.artifacts.get('planPath');
    if (!planPath) {
      throw new Error('No plan path available');
    }
    return planPath;
  }

  protected getPrompt(args: string, context: IssueWorkflowContext): string {
    return `Execute the implementation plan for issue #${context.issueNumber}.

The plan is located at: ${args}

Please:
1. Read the plan file
2. Execute each step carefully
3. Use TodoWrite to track your progress
4. Make all necessary code changes
5. Ensure the implementation matches the requirements

Original issue: ${context.issueTitle}`;
  }

  protected async processExecutorResult(
    result: any,
    args: string,
    context: IssueWorkflowContext
  ): Promise<NodeExecutionResult> {
    // The implementation is done by Claude Code
    await context.store.updateIssueWorkflowStep(context.workflowId, 'implemented', true);

    return {
      success: true,
      artifacts: { implementationComplete: true },
    };
  }

  protected getNextState(): IssueWorkflowState {
    return 'testing';
  }

  protected getErrorState(): IssueWorkflowState {
    return 'failed';
  }
}

// Test Implementation Node
export class TestImplementationNode extends WorkflowNode<
  'testing',
  IssueWorkflowContext,
  void,
  IssueWorkflowState
> {
  protected claudeCodeConfig: Partial<ClaudeCodeExecutorOptions> = {
    allowedTools: ['Bash', 'Read'],
    includeDefaultTools: false,
  };
  protected model = 'claude-3-5-sonnet-20241022';

  protected shouldProcessEvent(event: WorkflowEvent): boolean {
    return event.type === 'workflow_step_complete' && event.step === 'implementing';
  }

  protected async prepareArgs(context: IssueWorkflowContext): Promise<void> {
    return undefined;
  }

  protected getPrompt(args: void, context: IssueWorkflowContext): string {
    return `Run tests to verify the implementation for issue #${context.issueNumber}.

Please:
1. Run the project's test suite (bun test)
2. Run type checking (bun run check)
3. Run linting (bun run lint)
4. Report any failures

If any tests fail, provide details about what needs to be fixed.`;
  }

  protected async processExecutorResult(
    result: any,
    args: void,
    context: IssueWorkflowContext
  ): Promise<NodeExecutionResult> {
    // Check if tests passed based on Claude's response
    const testsPass =
      !result.toLowerCase().includes('fail') && !result.toLowerCase().includes('error');

    if (testsPass) {
      return {
        success: true,
        artifacts: { testsPass: true },
      };
    }

    return {
      success: false,
      error: 'Tests failed. Manual intervention required.',
    };
  }

  protected getNextState(): IssueWorkflowState {
    return 'creating_pr';
  }

  protected getErrorState(): IssueWorkflowState {
    return 'failed';
  }
}

// Create PR Node
export class CreatePRNode extends WorkflowNode<
  'creating_pr',
  IssueWorkflowContext,
  void,
  IssueWorkflowState
> {
  protected claudeCodeConfig: Partial<ClaudeCodeExecutorOptions> = {
    allowedTools: ['Bash'],
    includeDefaultTools: false,
  };
  protected model = 'claude-3-5-sonnet-20241022';

  protected shouldProcessEvent(event: WorkflowEvent): boolean {
    return event.type === 'workflow_step_complete' && event.step === 'testing';
  }

  protected async prepareArgs(context: IssueWorkflowContext): Promise<void> {
    return undefined;
  }

  protected getPrompt(args: void, context: IssueWorkflowContext): string {
    const branchName = `issue-${context.issueNumber}`;

    return `Create a pull request for issue #${context.issueNumber}.

Steps:
1. Create a new branch: ${branchName}
2. Commit all changes with a descriptive message
3. Push the branch
4. Create a PR using gh CLI

PR title should be: "Fix #${context.issueNumber}: ${context.issueTitle}"

PR body should:
- Reference the issue with "Fixes #${context.issueNumber}"
- Summarize the changes made
- Include any relevant testing information`;
  }

  protected async processExecutorResult(
    result: any,
    args: void,
    context: IssueWorkflowContext
  ): Promise<NodeExecutionResult> {
    // Extract PR number from the result
    const prMatch = result.match(/pull request #(\d+)/i) || result.match(/PR #(\d+)/i);
    const prNumber = prMatch ? parseInt(prMatch[1]) : undefined;

    if (prNumber) {
      await context.store.updateIssueWorkflowStep(context.workflowId, 'prCreated', true);
      await context.store.updateIssueWorkflowData(context.workflowId, {
        prNumber,
        branchName: `issue-${context.issueNumber}`,
      });

      return {
        success: true,
        artifacts: { prNumber },
      };
    }

    return {
      success: false,
      error: 'Failed to create PR',
    };
  }

  protected getNextState(): IssueWorkflowState {
    return 'complete';
  }

  protected getErrorState(): IssueWorkflowState {
    return 'failed';
  }
}

// Terminal nodes
export class IssueCompleteNode extends FinalNode<'complete', IssueWorkflowContext, WorkflowEvent> {
  async post(
    result: null,
    store: SharedStore<IssueWorkflowContext, WorkflowEvent>
  ): Promise<StateResult<'complete', WorkflowEvent>> {
    await store.context.store.updateWorkflow(store.context.workflowId, {
      status: 'completed',
    });

    // Post success comment
    const prNumber = store.context.artifacts.get('prNumber');
    if (prNumber && store.context.octokit) {
      await store.context.octokit.rest.issues.createComment({
        owner: store.context.webhookEvent.repository.owner.login,
        repo: store.context.webhookEvent.repository.name,
        issue_number: store.context.issueNumber,
        body: `✅ Implementation complete! Created PR #${prNumber}`,
      });
    }

    return { status: 'terminal' };
  }
}

export class IssueFailedNode extends ErrorNode<'failed', IssueWorkflowContext, WorkflowEvent> {
  async post(
    result: null,
    store: SharedStore<IssueWorkflowContext, WorkflowEvent>
  ): Promise<StateResult<'failed', WorkflowEvent>> {
    await store.context.store.updateWorkflow(store.context.workflowId, {
      status: 'failed',
    });

    // Post failure comment
    if (store.context.octokit) {
      const lastError = store.context.artifacts.get('lastNodeResult')?.error || 'Unknown error';

      await store.context.octokit.rest.issues.createComment({
        owner: store.context.webhookEvent.repository.owner.login,
        repo: store.context.webhookEvent.repository.name,
        issue_number: store.context.issueNumber,
        body: `❌ Failed to implement issue: ${lastError}\n\nPlease check the logs for more details.`,
      });
    }

    return { status: 'terminal' };
  }
}
