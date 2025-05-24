import { CommandHandler, type EnhancedCommand, type CommandDefinition } from '../types.js';
import type { ExecutionContext } from '../../types.js';
import { TOOL_COMMANDS } from '../definitions.js';
import { ResponseHandler } from '../../response_handler.js';
import { spawnAndLogOutput } from '../../../rmfilter/utils.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { log } from '../../../logging.js';

export class RmfilterHandler extends CommandHandler {
  readonly definition: CommandDefinition = TOOL_COMMANDS.rmfilter;

  async execute(command: EnhancedCommand, context: ExecutionContext): Promise<void> {
    const responseHandler = new ResponseHandler(context.octokit);

    // Post initial progress comment
    const progressCommentId = await responseHandler.postInProgressComment(
      context.event,
      `${command.command} ${command.args.join(' ')}`
    );

    try {
      // Create a temporary directory for the execution
      const tempDir = await fs.mkdtemp(path.join('/tmp', 'rmapp-'));
      log(`Created temp directory: ${tempDir}`);

      // Clone the repository to the temp directory
      const repoUrl = context.event.repository.clone_url;
      const cloneResult = await spawnAndLogOutput(
        ['git', 'clone', '--depth', '1', repoUrl, tempDir],
        { cwd: '/' }
      );

      if (cloneResult.exitCode !== 0) {
        throw new Error(`Failed to clone repository: ${cloneResult.stderr}`);
      }

      // If it's a PR, checkout the PR branch
      if (context.event.pull_request) {
        const prNumber = context.event.pull_request.number;
        const checkoutResult = await spawnAndLogOutput(
          ['git', 'fetch', 'origin', `pull/${prNumber}/head:pr-${prNumber}`],
          { cwd: tempDir }
        );

        if (checkoutResult.exitCode === 0) {
          await spawnAndLogOutput(['git', 'checkout', `pr-${prNumber}`], { cwd: tempDir });
        }
      }

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
      const result = await spawnAndLogOutput(rmfilterArgs, { cwd: tempDir });

      if (result.exitCode !== 0) {
        throw new Error(`rmfilter failed: ${result.stderr}`);
      }

      // Update the progress comment with results
      if (progressCommentId) {
        const formattedResult = responseHandler.formatExecutionResult(result.stdout, true);
        await responseHandler.updateComment(context.event, progressCommentId, formattedResult);
      } else {
        await responseHandler.postComment(context.event, result.stdout);
      }

      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);

      if (progressCommentId) {
        const formattedError = responseHandler.formatExecutionResult(errorMessage, false);
        await responseHandler.updateComment(context.event, progressCommentId, formattedError);
      } else {
        await responseHandler.postErrorComment(context.event, errorMessage);
      }

      throw new Error(errorMessage);
    }
  }
}
