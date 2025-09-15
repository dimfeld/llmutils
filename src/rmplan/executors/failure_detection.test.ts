import { describe, expect, it } from 'bun:test';
import { detectFailedLine, extractFailureDetails, parseFailedReport } from './failure_detection.ts';

describe('failure_detection', () => {
  it('detects simple FAILED line with summary', () => {
    const out = 'Some logs here\nFAILED: Could not proceed due to conflicts\nMore';
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
});
