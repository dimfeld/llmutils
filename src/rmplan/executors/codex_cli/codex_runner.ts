import type { RmplanConfig } from '../../configSchema';
import { spawnAndLogOutput } from '../../../common/process';
import { error } from '../../../logging';
import { createCodexStdoutFormatter } from './format';

/**
 * Runs a single-step Codex execution with JSON streaming enabled and returns the final agent message.
 */
export async function executeCodexStep(
  prompt: string,
  cwd: string,
  rmplanConfig: RmplanConfig
): Promise<string> {
  const allowAllTools = ['true', '1'].includes(process.env.ALLOW_ALL_TOOLS || '');
  const sandboxSettings = allowAllTools
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : ['--sandbox', 'workspace-write'];

  const formatter = createCodexStdoutFormatter();
  const args = [
    'codex',
    '--enable',
    'web_search_request',
    'exec',
    // For the types of tasks we're doing we already want high.
    // Make this configurable in the future
    '-c',
    'model_reasoning_effort=high',
    ...sandboxSettings,
  ];

  if (
    !allowAllTools &&
    rmplanConfig?.isUsingExternalStorage &&
    rmplanConfig.externalRepositoryConfigDir
  ) {
    const writableRoots = JSON.stringify([rmplanConfig.externalRepositoryConfigDir]);
    args.push('-c', `sandbox_workspace_write.writable_roots=${writableRoots}`);
  }

  args.push(prompt, '--json');

  const { exitCode, stdout, stderr } = await spawnAndLogOutput(args, {
    cwd,
    env: {
      ...process.env,
      AGENT: process.env.AGENT || '1',
    },
    formatStdout: (chunk: string) => formatter.formatChunk(chunk),
    // stderr is not JSON – print as-is
  });

  if (exitCode !== 0) {
    throw new Error(`codex exited with code ${exitCode}`);
  }

  // Prefer a FAILED agent message when available to surface failures reliably
  const failedMsg =
    typeof (formatter as any).getFailedAgentMessage === 'function'
      ? (formatter as any).getFailedAgentMessage()
      : undefined;
  const final = failedMsg || formatter.getFinalAgentMessage();
  if (!final) {
    // Provide helpful context for debugging
    error('Codex returned no final agent message. Enable debug logs for details.');
    throw new Error('No final agent message found in Codex output.');
  }

  return final;
}
