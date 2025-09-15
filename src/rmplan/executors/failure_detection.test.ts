import { describe, expect, test } from 'bun:test';
import {
  detectFailedLine,
  detectFailedLineAnywhere,
  extractFailureDetails,
  parseFailedReport,
  parseFailedReportAnywhere,
  sliceFromFirstFailed,
} from './failure_detection.ts';

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

  test('detects FAILED appearing later with detectFailedLineAnywhere and slices correctly', () => {
    const msg = `Intro line\n\nSome preface\nFAILED: Later failure line\nProblems:\n- X`;
    const detFirst = detectFailedLine(msg);
    expect(detFirst.failed).toBeFalse();

    const detAny = detectFailedLineAnywhere(msg);
    expect(detAny.failed).toBeTrue();
    expect(detAny.summary).toBe('Later failure line');

    const sliced = sliceFromFirstFailed(msg)!;
    expect(sliced.startsWith('FAILED:')).toBeTrue();
    expect(sliced).toContain('Problems:');

    // extractFailureDetails uses strict first-line detection and should not parse from full message
    expect(extractFailureDetails(msg)).toBeUndefined();

    // But parseFailedReportAnywhere should succeed by slicing first
    const parsed = parseFailedReportAnywhere(msg);
    expect(parsed.failed).toBeTrue();
    expect(parsed.details?.problems).toContain('X');
  });

  test('handles Windows newlines and varied heading casing', () => {
    const msg = `\r\n  \r\nFAILED: Mixed-casing headings and CRLF\r\nrequirements:\r\n- R1\r\n\r\nPROBLEMS:\r\n- P1\r\n\r\nPossible Solutions:\r\n- S1\r\n`;

    const det = detectFailedLine(msg);
    expect(det.failed).toBeTrue();
    expect(det.summary).toContain('Mixed-casing');

    const details = extractFailureDetails(msg)!;
    expect(details.requirements).toContain('R1');
    expect(details.problems).toContain('P1');
    expect(details.solutions).toContain('S1');
  });
});
