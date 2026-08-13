import { describe, expect, test } from 'vitest';
import { createClaudeOutputStreamFormatter } from './output_stream_formatter.js';

describe('ClaudeOutputStreamFormatter', () => {
  test('reuses the splitter and formatter across chunks', () => {
    const formatter = createClaudeOutputStreamFormatter('sonnet');
    const init = formatter.formatChunk(
      `${JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'stream-session',
        tools: [],
        mcp_servers: [],
      })}\n`
    );

    expect(init.structuredMessages).toEqual([
      expect.objectContaining({ type: 'agent_session_start', model: 'sonnet' }),
    ]);

    const resultLine = JSON.stringify({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0,
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: 'done',
      session_id: 'stream-session',
    });

    expect(formatter.formatChunk(resultLine).formattedResults).toEqual([]);

    const formatted = formatter.formatChunk('\n');

    expect(formatted.formattedResults).toEqual([
      expect.objectContaining({ type: 'result', resultText: 'done' }),
    ]);
    expect(formatted.structuredMessages).toEqual([
      expect.objectContaining({ type: 'agent_session_end', sessionId: 'stream-session' }),
    ]);
  });
});
