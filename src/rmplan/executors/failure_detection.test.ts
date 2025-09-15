import { describe, expect, it } from 'bun:test';
import { detectFailedLine, extractFailureDetails, parseFailedReport } from './failure_detection.ts';

describe('failure_detection', () => {
  it('detects FAILED only when the first non-empty line starts with FAILED:', () => {
    const out = '  \nFAILED: Could not proceed due to conflicts\nMore';
    const det = detectFailedLine(out);
    expect(det.failed).toBeTrue();
    expect(det.summary).toBe('Could not proceed due to conflicts');
  });

  it('does not detect when no FAILED present', () => {
    const det = detectFailedLine('All good.');
    expect(det.failed).toBeFalse();
  });

  it('extracts structured sections with standard headings', () => {
    const report = `FAILED: API response format conflict\n\nRequirements:\n- Return array of Item\n- Keep legacy object map\n\nProblems:\n- Mutually exclusive response shapes\n\nPossible solutions:\n- Add v1 endpoint with new shape\n- Keep v0 for legacy clients`;

    const details = extractFailureDetails(report)!;
    expect(details.requirements).toContain('array of Item');
    expect(details.problems).toContain('Mutually exclusive');
    expect(details.solutions).toContain('v1 endpoint');
  });

  it('handles synonyms and missing solutions', () => {
    const report = `FAILED: Build system constraints\n\nGoals:\n- Enable ESM only\n\nIssues:\n- Some tools require CJS\n`;
    const parsed = parseFailedReport(report);
    expect(parsed.failed).toBeTrue();
    expect(parsed.details?.requirements).toContain('Enable ESM only');
    expect(parsed.details?.problems).toContain('require CJS');
    expect(parsed.details?.solutions).toBeUndefined();
  });

  it('falls back to treating text after FAILED as problems when no headings present', () => {
    const report = `FAILED: Something went wrong\nWe could not do X because Y and Z.`;
    const details = extractFailureDetails(report)!;
    expect(details.problems).toContain('could not do X');
  });

  it('does not falsely detect typical pytest/Jest failure summaries', () => {
    const pytest = `============================= test session starts =============================\nplatform linux -- Python 3.11\ncollected 10 items\n\ntests/test_api.py::test_a PASSED\ntests/test_api.py::test_b FAILED\n\n=========================== short test summary info ===========================\nFAILED tests/test_api.py::test_b - AssertionError: expected 1 == 2\n`;
    const jest = `Test Suites: 1 failed, 3 passed, 4 total\nTests:       2 failed, 18 passed, 20 total\nSnapshots:   0 total\nTime:        3.123 s\nRan all test suites.\n`;
    expect(detectFailedLine(pytest).failed).toBeFalse();
    expect(detectFailedLine(jest).failed).toBeFalse();
  });
});
