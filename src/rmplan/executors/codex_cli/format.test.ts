import { describe, expect, test } from 'bun:test';
import { createCodexStdoutFormatter, formatCodexJsonMessage } from './format.ts';

describe('codex_cli/format', () => {
  test('parses initial non-msg line', () => {
    const line = JSON.stringify({ model: 'gpt-5', provider: 'openai', sandbox: 'read-only' });
    const res = formatCodexJsonMessage(line);
    expect(res.type).toBe('init');
    expect(res.message).toContain('Model: gpt-5');
  });

  test('parses task_started', () => {
    const line = JSON.stringify({
      id: '0',
      msg: { type: 'task_started', model_context_window: 272000 },
    });
    const res = formatCodexJsonMessage(line);
    expect(res.type).toBe('task_started');
    expect(res.message).toContain('Task Started');
  });

  test('handles plan update', () => {
    const line = JSON.stringify({
      id: '0',
      msg: {
        type: 'plan_update',
        explanation: 'Keeping tests green.',
        plan: [
          {
            step: 'Review current forms module implementation and existing tests to spot coverage gaps.',
            status: 'completed',
          },
          {
            step: 'Add or adjust tests to cover missing scenarios for onboarding form management.',
            status: 'in_progress',
          },
          {
            step: 'Run targeted checks (type check, lint, tests) to verify everything passes.',
            status: 'pending',
          },
        ],
      },
    });
    const res = formatCodexJsonMessage(line);
    expect(res.type).toBe('plan_update');
    expect(res.message).toContain('Plan Update');
    expect(res.message).toContain('✓');
    expect(res.message).toContain('→');
    expect(res.message).toContain('Explanation: Keeping tests green.');
  });

  test('handles agent reasoning', () => {
    const line = JSON.stringify({ id: '0', msg: { type: 'agent_reasoning', text: 'thinking...' } });
    const res = formatCodexJsonMessage(line);
    expect(res.type).toBe('agent_reasoning');
    expect(res.message).toContain('thinking...');
  });

  test('ignores section break', () => {
    const line = JSON.stringify({ id: '0', msg: { type: 'agent_reasoning_section_break' } });
    const res = formatCodexJsonMessage(line);
    expect(res.type).toBe('agent_reasoning_section_break');
    expect(res.message).toBeUndefined();
  });

  test('formats exec begin', () => {
    const line = JSON.stringify({
      id: '0',
      msg: {
        type: 'exec_command_begin',
        call_id: 'c1',
        command: ['bash', '-lc', 'echo hi'],
        cwd: '/code',
      },
    });
    const res = formatCodexJsonMessage(line);
    expect(res.type).toBe('exec_command_begin');
    expect(res.message).toContain('Exec Begin');
    expect(res.message).toContain('bash -lc echo hi');
  });

  test('truncates exec end output to 20 lines', () => {
    const longOut = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const line = JSON.stringify({
      id: '0',
      msg: { type: 'exec_command_end', call_id: 'c1', exit_code: 0, stdout: longOut },
    });
    const res = formatCodexJsonMessage(line);
    expect(res.type).toBe('exec_command_end');
    const msg = res.message ?? '';
    const count = msg.split('\n').filter((l) => l.startsWith('line ')).length;
    expect(count).toBe(20);
    expect(msg).toContain('(truncated long output...)');
  });

  test('captures final agent message', () => {
    const { formatChunk, getFinalAgentMessage } = createCodexStdoutFormatter();
    const lines = [
      JSON.stringify({ id: '0', msg: { type: 'task_started' } }),
      JSON.stringify({ id: '0', msg: { type: 'agent_reasoning', text: 'thinks' } }),
      JSON.stringify({ id: '0', msg: { type: 'agent_message', message: 'FINAL ANSWER' } }),
    ];
    for (const l of lines) {
      formatChunk(l + '\n');
    }
    expect(getFinalAgentMessage()).toBe('FINAL ANSWER');
  });

  test('handles malformed JSON safely', () => {
    const res = formatCodexJsonMessage('{not-json');
    expect(res.type).toBe('parse_error');
  });
});
