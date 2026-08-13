import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createLineSplitter: vi.fn(() => (input: string) => input.split('\n').filter(Boolean)),
  isTunnelActive: vi.fn(() => true),
  spawnAndLogOutput: vi.fn(),
}));

vi.mock('../../common/process.js', () => ({
  createLineSplitter: mocks.createLineSplitter,
  spawnAndLogOutput: mocks.spawnAndLogOutput,
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: mocks.isTunnelActive,
}));

const { executeClaudePrompt } = await import('./run_prompt.js');

afterEach(() => {
  vi.clearAllMocks();
});

describe('run-prompt Claude formatter lifecycle', () => {
  test('reuses one formatter across output callbacks for tool correlation', async () => {
    let toolResultOutput: unknown;

    mocks.spawnAndLogOutput.mockImplementationOnce(
      async (
        _args: string[],
        options: { formatStdout: (chunk: string) => unknown }
      ): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
        signal: null;
        killedByInactivity: boolean;
      }> => {
        const toolUseLine = JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'run-prompt-tool',
                name: 'Bash',
                input: { command: 'printf run-prompt' },
              },
            ],
          },
          session_id: 'run-prompt-session',
        });
        const toolResultLine = JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'run-prompt-tool',
                content: 'run-prompt complete',
              },
            ],
          },
          session_id: 'run-prompt-session',
        });
        const resultLine = JSON.stringify({
          type: 'result',
          subtype: 'success',
          total_cost_usd: 0,
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: 'run-prompt complete',
          session_id: 'run-prompt-session',
        });

        options.formatStdout(`${toolUseLine}\n`);
        toolResultOutput = options.formatStdout(`${toolResultLine}\n`);
        options.formatStdout(`${resultLine}\n`);

        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        };
      }
    );

    await expect(
      executeClaudePrompt('Run the prompt.', {
        cwd: process.cwd(),
      })
    ).resolves.toBe('run-prompt complete');

    expect(toolResultOutput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'llm_tool_result',
          toolName: 'Bash',
        }),
      ])
    );
    expect(mocks.spawnAndLogOutput).toHaveBeenCalledOnce();
  });
});
