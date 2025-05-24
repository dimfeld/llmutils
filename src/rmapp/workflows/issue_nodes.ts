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
import { AnalysisPipeline, AnalysisCache } from '../analysis/index.js';
import type { GitHubIssue, RepoContext } from '../analysis/types.js';
import { PlanGenerationPipeline } from '../planning/index.js';
import { PRCreator } from '../pr/index.js';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { log, error } from '../../logging.js';
import { load } from 'js-yaml';
import type { PlanSchema } from '../../rmplan/planSchema.js';

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
  private analysisPipeline = new AnalysisPipeline();
  private analysisCache: AnalysisCache | null = null;

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
    // This prompt is now only used as a fallback
    return `Analyze this GitHub issue and extract key information.

Issue #${context.issueNumber}: ${context.issueTitle}

${context.issueBody}

Please analyze and provide:
1. Key requirements (bullet points)
2. Files and areas likely to be affected
3. Suggested implementation approach
4. Complexity assessment (simple/medium/complex)
5. Any relevant tags or labels

Repository: ${context.webhookEvent.repository?.owner?.login || 'unknown'}/${context.webhookEvent.repository?.name || 'unknown'}

Focus on understanding what needs to be done and where in the codebase changes will be needed.`;
  }

  protected async executeWithArgs(
    args: void,
    context: IssueWorkflowContext,
    store: SharedStore<IssueWorkflowContext, WorkflowEvent>
  ): Promise<NodeExecutionResult> {
    try {
      // Initialize cache if not already done
      if (!this.analysisCache && context.store) {
        this.analysisCache = new AnalysisCache(context.store);
      }

      // Check cache first
      let analysis = await this.analysisCache?.get(context.issueNumber);
      
      if (!analysis) {
        // Fetch full issue details from GitHub
        const issue: GitHubIssue = {
          number: context.issueNumber,
          title: context.issueTitle,
          body: context.issueBody || '',
          state: 'open',
          html_url: `https://github.com/${context.webhookEvent.repository.owner.login}/${context.webhookEvent.repository.name}/issues/${context.issueNumber}`,
          user: { login: context.webhookEvent.issue?.user?.login || 'unknown' },
          labels: context.webhookEvent.issue?.labels || [],
          created_at: context.webhookEvent.issue?.created_at || new Date().toISOString(),
          updated_at: context.webhookEvent.issue?.updated_at || new Date().toISOString(),
        };

        const repoContext: RepoContext = {
          owner: context.webhookEvent.repository?.owner?.login || 'unknown',
          repo: context.webhookEvent.repository?.name || 'unknown',
          defaultBranch: (context.webhookEvent.repository as any)?.default_branch || 'main',
          workDir: context.workspaceDir || '/tmp/workspace',
        };

        // Run analysis pipeline
        log(`Running analysis pipeline for issue #${context.issueNumber}`);
        analysis = await this.analysisPipeline.analyze(issue, repoContext);
        
        // Cache the result
        await this.analysisCache?.set(context.issueNumber, analysis);
      }

      // Convert to legacy format for backward compatibility
      const legacyAnalysis: IssueAnalysis = {
        requirements: analysis.requirements.map(r => r.description),
        affectedFiles: analysis.technicalScope.affectedFiles,
        suggestedApproach: analysis.suggestedApproach || '',
        complexity: this.mapComplexity(analysis),
        tags: [],
      };

      // Update the workflow
      await context.store.updateIssueWorkflowStep(context.workflowId, 'analyzed', true);

      return {
        success: true,
        artifacts: { 
          analysis: legacyAnalysis,
          enrichedAnalysis: analysis 
        },
      };
    } catch (error) {
      log('Error in AnalyzeIssueNode:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to analyze issue',
      };
    }
  }

  private mapComplexity(analysis: any): 'simple' | 'medium' | 'complex' {
    const fileCount = analysis.technicalScope.affectedFiles.length;
    const reqCount = analysis.requirements.length;
    
    if (fileCount <= 2 && reqCount <= 2) return 'simple';
    if (fileCount >= 10 || reqCount >= 8) return 'complex';
    return 'medium';
  }

  // Override base class method to skip Claude execution
  protected async processExecutorResult(
    result: any,
    args: void,
    context: IssueWorkflowContext
  ): Promise<NodeExecutionResult> {
    // This method is not used when executeWithArgs is overridden
    return { success: true };
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
  private planGenerator = new PlanGenerationPipeline();

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

  protected async executeWithArgs(
    args: IssueAnalysis,
    context: IssueWorkflowContext,
    store: SharedStore<IssueWorkflowContext, WorkflowEvent>
  ): Promise<NodeExecutionResult> {
    try {
      // Get the enriched analysis if available
      const enrichedAnalysis = context.artifacts.get('enrichedAnalysis');
      if (!enrichedAnalysis) {
        log('No enriched analysis found, using basic analysis');
        // Fall back to base class implementation
        return super.executeWithClaude(args);
      }

      // Generate plan path
      const planPath = join(
        context.workspaceDir || '/tmp',
        'tasks',
        `issue-${context.issueNumber}-plan.yml`
      );

      // Generate the plan using the pipeline
      log(`Generating plan for issue #${context.issueNumber}`);
      const plan = await this.planGenerator.generate(
        enrichedAnalysis,
        context.workspaceDir || '/tmp',
        planPath
      );

      // Update workflow data
      await context.store.updateIssueWorkflowData(context.workflowId, {
        planPath,
      });
      await context.store.updateIssueWorkflowStep(context.workflowId, 'planGenerated', true);

      return {
        success: true,
        artifacts: { plan, planPath },
      };
    } catch (error) {
      log('Error in GeneratePlanNode:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate plan',
      };
    }
  }

  protected getPrompt(args: IssueAnalysis, context: IssueWorkflowContext): string {
    // This is now only used as fallback
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
    // This method is not used when executeWithArgs is overridden
    // but kept for fallback compatibility
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
  private prCreator: PRCreator;
  protected claudeCodeConfig: Partial<ClaudeCodeExecutorOptions> = {};
  protected model = 'claude-3-5-sonnet-20241022';

  constructor(state: 'creating_pr', private octokit: any) {
    super(state);
    this.prCreator = new PRCreator(octokit);
  }

  // Override to not use Claude Code for this node
  protected async executeWithArgs(
    args: void,
    context: IssueWorkflowContext,
    store: SharedStore<IssueWorkflowContext, WorkflowEvent>
  ): Promise<NodeExecutionResult> {
    try {
      // Get workspace information
      const workspaceId = context.artifacts.get('workspaceId');
      if (!workspaceId) {
        throw new Error('No workspace ID available');
      }

      const workspace = await context.store.getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error('Workspace not found');
      }

      // Load plan
      const planPath = context.artifacts.get('planPath');
      if (!planPath || !existsSync(planPath)) {
        throw new Error('Plan file not found');
      }

      const planContent = readFileSync(planPath, 'utf-8');
      const plan = load(planContent) as PlanSchema;

      // Get issue details
      const issue = await context.store.getIssue(context.issueNumber);
      if (!issue) {
        throw new Error('Issue not found');
      }

      // Get analysis
      const analysisJson = context.artifacts.get('analysis');
      const analysis = analysisJson ? JSON.parse(analysisJson) : null;

      // Create the PR
      const result = await this.prCreator.createPR(
        {
          owner: context.repoOwner,
          repo: context.repoName,
          issueNumber: context.issueNumber,
          branchName: workspace.branchName || `issue-${context.issueNumber}`,
          baseRef: workspace.baseRef || 'main',
        },
        issue.title,
        issue.body || '',
        analysis,
        plan,
        workspace.path
      );

      if (result.success && result.prNumber) {
        await context.store.updateIssueWorkflowStep(context.workflowId, 'prCreated', true);
        await context.store.updateIssueWorkflowData(context.workflowId, {
          prNumber: result.prNumber,
          branchName: workspace.branchName,
        });

        log(`Created PR #${result.prNumber} for issue #${context.issueNumber}`);

        return {
          success: true,
          artifacts: { prNumber: result.prNumber, prUrl: result.prUrl },
        };
      }

      return {
        success: false,
        error: result.error || 'Failed to create PR',
      };
    } catch (err) {
      error('Failed to create PR:', err);
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  protected shouldProcessEvent(event: WorkflowEvent): boolean {
    return event.type === 'workflow_step_complete' && event.step === 'testing';
  }

  protected async prepareArgs(context: IssueWorkflowContext): Promise<void> {
    return undefined;
  }

  protected getPrompt(args: void, context: IssueWorkflowContext): string {
    // Not used since we override executeWithArgs
    return '';
  }

  protected async processExecutorResult(
    result: any,
    args: void,
    context: IssueWorkflowContext
  ): Promise<NodeExecutionResult> {
    // Not used since we override executeWithArgs
    return { success: false, error: 'Should not reach here' };
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
