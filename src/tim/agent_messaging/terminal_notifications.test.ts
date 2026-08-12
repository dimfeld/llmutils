import { describe, expect, test } from 'vitest';

import {
  FORCE_STOP_STALE_CONTEXT_WARNING,
  NO_COMPLETED_ASSISTANT_MESSAGE,
  formatTerminalNotification,
  selectTerminalResult,
  shouldSuppressTerminalNotification,
  type TerminalNotificationInput,
} from './terminal_notifications.js';

const baseInput: TerminalNotificationInput = {
  agentName: 'worker',
  cause: 'natural',
};

describe('terminal notification policy', () => {
  test.each([
    ['exact', 'Done.', 'Done.', true],
    ['boundary whitespace', '  Done.\n', '\tDone.  ', true],
    ['case difference', 'Done.', 'done.', false],
    ['punctuation difference', 'Done.', 'Done!', false],
    ['internal whitespace difference', 'two words', 'two  words', false],
    ['peer target as the latest successful message', 'Done.', 'Done.', false, 'peer'],
    ['blank completed result', '   ', '   ', false],
    ['blank outbound result', 'Done.', '   ', false],
  ])(
    '%s applies only the approved exact comparison',
    (
      _name: string,
      completed: string,
      outbound: string,
      expected: boolean,
      target: string = 'orchestrator'
    ) => {
      expect(
        shouldSuppressTerminalNotification({
          ...baseInput,
          lastCompletedAssistantMessage: completed,
          lastSuccessfulOutbound: { target, content: outbound },
        })
      ).toBe(expected);
    }
  );

  test('keeps forced and provider-failure causes outside duplicate suppression', () => {
    for (const cause of ['forced-stop', 'provider-failure'] as const) {
      expect(
        shouldSuppressTerminalNotification({
          ...baseInput,
          cause,
          lastCompletedAssistantMessage: 'Done.',
          lastSuccessfulOutbound: { target: 'orchestrator', content: 'Done.' },
        })
      ).toBe(false);
    }
  });

  test.each([
    ['self-finish fallback', 'self-finish', 'fallback', 'fallback'],
    ['graceful-stop fallback', 'graceful-stop', 'fallback', 'fallback'],
    ['natural fallback is ignored', 'natural', 'fallback', undefined],
    ['completed result wins over fallback', 'self-finish', 'fallback', 'completed'],
  ])(
    '%s selects only the allowed terminal result',
    (
      _name: string,
      cause: 'natural' | 'self-finish' | 'graceful-stop',
      fallback: string,
      expected: string | undefined
    ) => {
      expect(
        selectTerminalResult({
          ...baseInput,
          cause,
          lastCompletedAssistantMessage: expected === 'completed' ? 'completed' : undefined,
          finishFallbackMessage: fallback,
        })
      ).toBe(expected);
    }
  );

  test('fallback-only self-finish and blank output are never deduplicated', () => {
    expect(
      formatTerminalNotification({
        ...baseInput,
        cause: 'self-finish',
        finishFallbackMessage: 'fallback status',
        lastSuccessfulOutbound: {
          target: 'orchestrator',
          content: 'fallback status',
        },
      })
    ).toMatchObject({ suppressed: false, content: expect.stringContaining('fallback status') });

    expect(
      formatTerminalNotification({
        ...baseInput,
        lastCompletedAssistantMessage: '   ',
        lastSuccessfulOutbound: { target: 'orchestrator', content: '   ' },
      })
    ).toMatchObject({
      suppressed: false,
      content: expect.stringContaining(NO_COMPLETED_ASSISTANT_MESSAGE),
    });
  });

  test('forced output is never deduplicated and contains only safe context', () => {
    const result = formatTerminalNotification({
      ...baseInput,
      cause: 'forced-stop',
      lastCompletedAssistantMessage: 'completed result',
      finishFallbackMessage: 'stop instruction must not appear',
      lastSuccessfulOutbound: { target: 'orchestrator', content: 'completed result' },
    });

    expect(result).toEqual({
      suppressed: false,
      content: `completed result\n\n${FORCE_STOP_STALE_CONTEXT_WARNING}`,
    });
    expect(result.content).not.toContain('stop instruction');
  });

  test('forced output uses an explicit no-result marker', () => {
    expect(
      formatTerminalNotification({
        ...baseInput,
        cause: 'forced-stop',
      })
    ).toEqual({
      suppressed: false,
      content: `${NO_COMPLETED_ASSISTANT_MESSAGE}\n\n${FORCE_STOP_STALE_CONTEXT_WARNING}`,
    });

    expect(
      formatTerminalNotification({
        ...baseInput,
        cause: 'forced-stop',
        lastCompletedAssistantMessage: ' \t\n ',
      })
    ).toEqual({
      suppressed: false,
      content: `${NO_COMPLETED_ASSISTANT_MESSAGE}\n\n${FORCE_STOP_STALE_CONTEXT_WARNING}`,
    });
  });

  test('provider failures are never deduplicated or exposed with raw diagnostics', () => {
    expect(
      formatTerminalNotification({
        ...baseInput,
        cause: 'provider-failure',
        lastCompletedAssistantMessage: 'old result',
        lastSuccessfulOutbound: { target: 'orchestrator', content: 'old result' },
      })
    ).toEqual({
      suppressed: false,
      content: 'Agent worker failed before completing.',
    });
  });
});
