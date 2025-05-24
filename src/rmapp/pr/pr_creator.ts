import type { Octokit } from 'octokit';
import { logSpawn } from '../../rmfilter/utils';
import type { PlanSchema } from '../../rmplan/planSchema';
import { ChangeAnalyzer } from './change_analyzer';
import { PRTemplateGenerator } from './template_generator';
import type { PRContext, PRCreationResult, CommitStrategy } from './types';

export class PRCreator {
  private changeAnalyzer: ChangeAnalyzer;
  private templateGenerator: PRTemplateGenerator;

  constructor(
    private octokit: Octokit,
    private commitStrategy: CommitStrategy = {
      groupByFeature: true,
      maxCommitsPerPR: 50,
      squashMerge: false,
    }
  ) {
    this.changeAnalyzer = new ChangeAnalyzer();
    this.templateGenerator = new PRTemplateGenerator();
  }

  async createPR(
    context: PRContext,
    issueTitle: string,
    issueBody: string,
    analysis: any,
    plan: PlanSchema,
    workDir: string
  ): Promise<PRCreationResult> {
    try {
      // Ensure branch is pushed
      const pushResult = await this.pushBranch(context.branchName, workDir);
      if (!pushResult.success) {
        return {
          success: false,
          error: `Failed to push branch: ${pushResult.error}`,
        };
      }

      // Analyze changes
      const changes = await this.changeAnalyzer.analyzeChanges(
        context.branchName,
        context.baseRef,
        workDir
      );

      // Generate PR template
      const template = this.templateGenerator.generateTemplate(
        {
          issueNumber: context.issueNumber,
          issueTitle,
          issueBody,
          analysis,
          plan,
          branchName: context.branchName,
          baseRef: context.baseRef,
        },
        changes
      );

      // Create the PR
      const pr = await this.octokit.rest.pulls.create({
        owner: context.owner,
        repo: context.repo,
        title: template.title,
        body: template.body,
        head: context.branchName,
        base: context.baseRef,
        draft: template.draft,
      });

      // Add labels if specified
      if (template.labels && template.labels.length > 0) {
        await this.addLabels(context, pr.data.number, template.labels);
      }

      // Link to issue
      await this.linkToIssue(context, pr.data.number);

      return {
        success: true,
        prNumber: pr.data.number,
        prUrl: pr.data.html_url,
      };
    } catch (error) {
      console.error('Failed to create PR:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async pushBranch(
    branchName: string,
    workDir: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // First, ensure all changes are committed
      const statusProc = logSpawn(['git', 'status', '--porcelain'], {
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: workDir,
      });
      const statusOutput = await new Response(statusProc.stdout as ReadableStream<Uint8Array>).text();
      await statusProc.exited;

      if (statusOutput && statusOutput.trim()) {
        // There are uncommitted changes
        const addProc = logSpawn(['git', 'add', '-A'], { cwd: workDir });
        await addProc.exited;
        
        const commitProc = logSpawn(
          ['git', 'commit', '-m', 'Final changes before PR creation'],
          { cwd: workDir }
        );
        await commitProc.exited;
      }

      // Push the branch
      const pushProc = logSpawn(
        ['git', 'push', '-u', 'origin', branchName],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: workDir,
        }
      );
      
      const pushOutput = await new Response(pushProc.stdout as ReadableStream<Uint8Array>).text();
      const pushExitCode = await pushProc.exited;
      
      const pushResult = {
        success: pushExitCode === 0,
        output: pushOutput,
      };

      if (!pushResult.success) {
        return {
          success: false,
          error: pushResult.output || 'Push failed',
        };
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async addLabels(
    context: PRContext,
    prNumber: number,
    labels: string[]
  ): Promise<void> {
    try {
      // First, ensure labels exist in the repo
      const existingLabels = await this.octokit.rest.issues.listLabelsForRepo({
        owner: context.owner,
        repo: context.repo,
      });

      const existingLabelNames = new Set(
        existingLabels.data.map((label) => label.name.toLowerCase())
      );

      // Filter to only existing labels
      const validLabels = labels.filter((label: string) =>
        existingLabelNames.has(label.toLowerCase())
      );

      if (validLabels.length > 0) {
        await this.octokit.rest.issues.addLabels({
          owner: context.owner,
          repo: context.repo,
          issue_number: prNumber,
          labels: validLabels,
        });
      }
    } catch (error) {
      console.error('Failed to add labels:', error);
      // Non-fatal error, continue
    }
  }

  private async linkToIssue(context: PRContext, prNumber: number): Promise<void> {
    try {
      // Add a comment on the issue linking to the PR
      await this.octokit.rest.issues.createComment({
        owner: context.owner,
        repo: context.repo,
        issue_number: context.issueNumber,
        body: `🤖 I've created a pull request for this issue: #${prNumber}\n\nThe implementation is ready for review!`,
      });
    } catch (error) {
      console.error('Failed to link PR to issue:', error);
      // Non-fatal error, continue
    }
  }

  async updatePR(
    context: PRContext,
    prNumber: number,
    updates: Partial<{ title: string; body: string; draft: boolean }>
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.octokit.rest.pulls.update({
        owner: context.owner,
        repo: context.repo,
        pull_number: prNumber,
        ...updates,
      });

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}