import { describe, expect, test } from 'bun:test';
import { detectFailedLine, extractFailureDetails, parseFailedReport } from './failure_detection.ts';

describe('failure_detection utilities', () => {
  test('detects FAILED on first non-empty line and extracts details', () => {
    const msg = `\n\nFAILED: Implementer cannot proceed due to conflict\nRequirements:\n- Add /v1/items returns array\n- Keep legacy object map shape\n\nProblems:\n- Mutually exclusive response formats\n\nPossible solutions:\n- Clarify expected format\n- Support versioned endpoint`;

    const det = detectFailedLine(msg);
    expect(det.failed).toBeTrue();
    expect(det.summary).toContain('cannot proceed');

    const details = extractFailureDetails(msg)!;
    expect(details.requirements).toContain('/v1/items');
    expect(details.problems).toContain('Mutually exclusive');
    expect(details.solutions).toContain('versioned endpoint');

    const parsed = parseFailedReport(msg);
    expect(parsed.failed).toBeTrue();
    expect(parsed.details?.problems).toContain('Mutually exclusive');
  });

  test('falls back gracefully when sections missing', () => {
    const msg = `FAILED: Conflicting constraints\nThe rest of this message has no headings, just explanation.`;
    const det = detectFailedLine(msg);
    expect(det.failed).toBeTrue();

    const details = extractFailureDetails(msg)!;
    // When headings are missing, problems should fall back to text after FAILED line
    expect(details.problems).toContain('The rest of this message');
    // Requirements may be empty
    expect(details.requirements).toBe('');
    // Solutions may be undefined
    expect(details.solutions).toBeUndefined();
  });

  test('does not trigger when FAILED is not the first non-empty line', () => {
    const msg = `Intro text\nMore intro\n\nNOTE: something\nFAILED: This should be ignored`;
    const det = detectFailedLine(msg);
    expect(det.failed).toBeFalse();
    expect(parseFailedReport(msg).failed).toBeFalse();
  });
});
