import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

const spawnMock = mock(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
const getGitRootMock = mock(async () => '/repo');
const logMock = mock(() => {});
const warnMock = mock(() => {});
const debugMock = mock(() => {});

function buildLineSplitter() {
  let fragment = '';
  return (input: string) => {
    const full = fragment + input;
    const segments = full.split('\n');
    fragment = segments.pop() || '';
    return segments.filter((line) => line.length > 0);
  };
}

beforeEach(async () => {
  spawnMock.mockClear();
  getGitRootMock.mockClear();
  logMock.mockClear();
  warnMock.mockClear();
  debugMock.mockClear();

  await moduleMocker.mock('../../common/process.ts', () => ({
    spawnAndLogOutput: spawnMock,
    createLineSplitter: buildLineSplitter,
  }));

  await moduleMocker.mock('../../common/git.ts', () => ({
    getGitRoot: getGitRootMock,
  }));

  await moduleMocker.mock('../../logging.ts', () => ({
    log: logMock,
    warn: warnMock,
    debugLog: debugMock,
  }));
});

afterEach(() => {
  moduleMocker.clear();
});

describe('runClaudeCodeGeneration', () => {
  test('runs optional research step and returns both outputs', async () => {
    const planningPrompt = 'plan';
    const researchPrompt = 'research';
    const generationPrompt = 'generate';

    const responses = [
      {
        exitCode: 0,
        lines: ['{"session_id":"session-123"}'],
      },
      {
        exitCode: 0,
        lines: [
          '{"type":"result","subtype":"success","result":"Research notes","total_cost_usd":0.01,"duration_ms":1000,"num_turns":2}',
        ],
      },
      {
        exitCode: 0,
        lines: [
          '{"type":"result","subtype":"success","result":"Final plan","total_cost_usd":0.02,"duration_ms":2000,"num_turns":3}',
        ],
      },
    ];

    let callIndex = 0;
    spawnMock.mockImplementation(async (_cmd, options) => {
      const response = responses[callIndex++] ?? { exitCode: 0, lines: [] as string[] };
      response.lines.forEach((line) => options?.formatStdout?.(`${line}\n`));
      return { exitCode: response.exitCode, stdout: '', stderr: '' };
    });

    const { runClaudeCodeGeneration } = await import('./claude_code_orchestrator.js');

    const result = await runClaudeCodeGeneration({
      planningPrompt,
      researchPrompt,
      generationPrompt,
      options: { includeDefaultTools: true },
    });

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      generationOutput: 'Final plan',
      researchOutput: 'Research notes',
    });
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('Planning Phase'));
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('Research Preservation Phase'));
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('Generation Phase'));
  });

  test('skips research step when prompt not provided', async () => {
    const responses = [
      {
        exitCode: 0,
        lines: ['{"session_id":"session-456"}'],
      },
      {
        exitCode: 0,
        lines: [
          '{"type":"result","subtype":"success","result":"Only plan","total_cost_usd":0.01,"duration_ms":1500,"num_turns":2}',
        ],
      },
    ];

    let callIndex = 0;
    spawnMock.mockImplementation(async (_cmd, options) => {
      const response = responses[callIndex++] ?? { exitCode: 0, lines: [] as string[] };
      response.lines.forEach((line) => options?.formatStdout?.(`${line}\n`));
      return { exitCode: response.exitCode, stdout: '', stderr: '' };
    });

    const { runClaudeCodeGeneration } = await import('./claude_code_orchestrator.js');

    const result = await runClaudeCodeGeneration({
      planningPrompt: 'plan',
      generationPrompt: 'generate',
      options: { includeDefaultTools: true },
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ generationOutput: 'Only plan', researchOutput: undefined });
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('Planning Phase'));
    expect(logMock).not.toHaveBeenCalledWith(
      expect.stringContaining('Research Preservation Phase')
    );
  });

  test('continues when research step exits with error', async () => {
    const responses = [
      {
        exitCode: 0,
        lines: ['{"session_id":"session-789"}'],
      },
      {
        exitCode: 42,
        lines: [
          '{"type":"result","subtype":"success","result":"ignored","total_cost_usd":0.01,"duration_ms":1200,"num_turns":2}',
        ],
      },
      {
        exitCode: 0,
        lines: [
          '{"type":"result","subtype":"success","result":"Plan output","total_cost_usd":0.02,"duration_ms":2200,"num_turns":3}',
        ],
      },
    ];

    let callIndex = 0;
    spawnMock.mockImplementation(async (_cmd, options) => {
      const response = responses[callIndex++] ?? { exitCode: 0, lines: [] as string[] };
      response.lines.forEach((line) => options?.formatStdout?.(`${line}\n`));
      return { exitCode: response.exitCode, stdout: '', stderr: '' };
    });

    const { runClaudeCodeGeneration } = await import('./claude_code_orchestrator.js');

    const result = await runClaudeCodeGeneration({
      planningPrompt: 'plan',
      researchPrompt: 'research',
      generationPrompt: 'generate',
      options: { includeDefaultTools: true },
    });

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(result.generationOutput).toBe('Plan output');
    expect(result.researchOutput).toBe('ignored');
    expect(warnMock).toHaveBeenCalled();
  });
});
