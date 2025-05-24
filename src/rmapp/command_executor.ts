import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ExecutionContext } from './types';
import { error, log } from '../logging';
import { createWorkspace } from '../rmplan/workspace/workspace_manager';
import { spawnAndLogOutput } from '../rmfilter/utils';
import { ResponseHandler } from './response_handler';
import { loadConfig } from '../rmplan/configLoader';
import type { RmplanConfig } from '../rmplan/configSchema';

export class CommandExecutor {
  private responseHandler: ResponseHandler;

  constructor(private context: ExecutionContext) {
    this.responseHandler = new ResponseHandler(context.octokit);
  }

  async execute(): Promise<void> {
    const { command, event } = this.context;

    // Post initial progress comment
    const progressCommentId = await this.responseHandler.postInProgressComment(
      event,
      `${command.command} ${command.args.join(' ')}`
    );

    try {
      // Create a temporary directory for the execution
      const tempDir = await fs.mkdtemp(path.join('/tmp', 'rmapp-'));
      log(`Created temp directory: ${tempDir}`);

      // Clone the repository to the temp directory
      const repoUrl = event.repository.clone_url;
      const cloneResult = await spawnAndLogOutput(
        ['git', 'clone', '--depth', '1', repoUrl, tempDir],
        { cwd: '/' }
      );

      if (cloneResult.exitCode !== 0) {
        throw new Error(`Failed to clone repository: ${cloneResult.stderr}`);
      }

      // If it's a PR, checkout the PR branch
      if (event.pull_request) {
        const prNumber = event.pull_request.number;
        const checkoutResult = await spawnAndLogOutput(
          ['git', 'fetch', 'origin', `pull/${prNumber}/head:pr-${prNumber}`],
          { cwd: tempDir }
        );

        if (checkoutResult.exitCode === 0) {
          await spawnAndLogOutput(['git', 'checkout', `pr-${prNumber}`], { cwd: tempDir });
        }
      }

      // Execute the command based on what was requested
      let output: string;
      let success = true;

      switch (command.command) {
        case 'rmplan':
          output = await this.executeRmplan(tempDir);
          break;
        case 'rmfilter':
          output = await this.executeRmfilter(tempDir);
          break;
        case 'rmrun':
          output = await this.executeRmrun(tempDir);
          break;
        default:
          throw new Error(`Unknown command: ${command.command}`);
      }

      // Update the progress comment with results
      if (progressCommentId) {
        const formattedResult = this.responseHandler.formatExecutionResult(output, success);
        await this.responseHandler.updateComment(event, progressCommentId, formattedResult);
      } else {
        // Fallback to creating a new comment
        await this.responseHandler.postComment(event, output);
      }

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      error('Command execution failed:', errorMessage);

      if (progressCommentId) {
        const formattedError = this.responseHandler.formatExecutionResult(errorMessage, false);
        await this.responseHandler.updateComment(event, progressCommentId, formattedError);
      } else {
        await this.responseHandler.postErrorComment(event, errorMessage);
      }
    }
  }

  private async executeRmplan(workDir: string): Promise<string> {
    const { command } = this.context;

    // Build the rmplan command
    const rmplanArgs = ['rmplan', ...command.args];

    // Add options
    for (const [key, value] of Object.entries(command.options)) {
      if (value === true) {
        rmplanArgs.push(`--${key}`);
      } else {
        rmplanArgs.push(`--${key}`, String(value));
      }
    }

    // Add context files if provided
    if (command.contextFiles && command.contextFiles.length > 0) {
      rmplanArgs.push('--');
      rmplanArgs.push(...command.contextFiles);
    }

    // Execute rmplan
    const result = await spawnAndLogOutput(rmplanArgs, { cwd: workDir });

    if (result.exitCode !== 0) {
      throw new Error(`rmplan failed: ${result.stderr}`);
    }

    return result.stdout;
  }

  private async executeRmfilter(workDir: string): Promise<string> {
    const { command } = this.context;

    // Build the rmfilter command
    const rmfilterArgs = ['rmfilter'];

    // Add options
    for (const [key, value] of Object.entries(command.options)) {
      if (value === true) {
        rmfilterArgs.push(`--${key}`);
      } else {
        rmfilterArgs.push(`--${key}`, String(value));
      }
    }

    // Add files
    if (command.contextFiles && command.contextFiles.length > 0) {
      rmfilterArgs.push(...command.contextFiles);
    } else {
      rmfilterArgs.push(...command.args);
    }

    // Execute rmfilter
    const result = await spawnAndLogOutput(rmfilterArgs, { cwd: workDir });

    if (result.exitCode !== 0) {
      throw new Error(`rmfilter failed: ${result.stderr}`);
    }

    return result.stdout;
  }

  private async executeRmrun(workDir: string): Promise<string> {
    const { command } = this.context;

    // For rmrun, we need to pipe rmfilter output through the LLM
    // First run rmfilter
    const rmfilterOutput = await this.executeRmfilter(workDir);

    // Then execute rmrun with the filter output
    const rmrunArgs = ['rmrun'];

    // Add model option if specified
    if (command.options.model) {
      rmrunArgs.push('--model', String(command.options.model));
    }

    // Create a child process and pipe the input
    return new Promise((resolve, reject) => {
      const proc = spawn('bun', rmrunArgs, {
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`rmrun failed: ${stderr}`));
        } else {
          resolve(stdout);
        }
      });

      // Write the rmfilter output to stdin
      proc.stdin.write(rmfilterOutput);
      proc.stdin.end();
    });
  }

  private async loadRmplanConfig(workDir: string): Promise<RmplanConfig | null> {
    try {
      const config = await loadConfig(workDir);
      return config;
    } catch (e) {
      log('No rmplan config found, using defaults');
      return null;
    }
  }
}
