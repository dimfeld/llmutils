import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';
import type { ReviewIssueRow } from '$tim/db/review.js';
import {
  buildPatch,
  validatePatch,
  isPositiveInteger,
  nullIfEmpty,
  type ReviewIssuePatch,
  type FormState,
} from './review_issue_editor_utils.js';
import ReviewIssueEditor from './ReviewIssueEditor.svelte';

function makeIssue(overrides: Partial<ReviewIssueRow> = {}): ReviewIssueRow {
  return {
    id: 1,
    review_id: 10,
    severity: 'minor',
    category: 'other',
    content: 'This is an issue.',
    file: null,
    line: null,
    start_line: null,
    suggestion: null,
    source: null,
    side: 'RIGHT',
    submittedInPrReviewId: null,
    resolved: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeFormState(issue: ReviewIssueRow, overrides: Partial<FormState> = {}): FormState {
  return {
    severity: issue.severity,
    category: issue.category,
    file: issue.file ?? '',
    startLine: issue.start_line ?? '',
    line: issue.line ?? '',
    side: issue.side,
    content: issue.content,
    suggestion: issue.suggestion ?? '',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// isPositiveInteger
// ─────────────────────────────────────────────────────────────

describe('isPositiveInteger', () => {
  test('accepts simple positive integers', () => {
    expect(isPositiveInteger('1')).toBe(true);
    expect(isPositiveInteger('10')).toBe(true);
    expect(isPositiveInteger('999')).toBe(true);
  });

  test('rejects zero', () => {
    expect(isPositiveInteger('0')).toBe(false);
  });

  test('rejects negative numbers', () => {
    expect(isPositiveInteger('-1')).toBe(false);
  });

  test('rejects non-numeric strings', () => {
    expect(isPositiveInteger('abc')).toBe(false);
    expect(isPositiveInteger('')).toBe(false);
    expect(isPositiveInteger('1.5')).toBe(false);
  });

  test('rejects leading zeros', () => {
    expect(isPositiveInteger('01')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// nullIfEmpty
// ─────────────────────────────────────────────────────────────

describe('nullIfEmpty', () => {
  test('returns null for empty string', () => {
    expect(nullIfEmpty('')).toBeNull();
  });

  test('returns null for whitespace-only string', () => {
    expect(nullIfEmpty('   ')).toBeNull();
  });

  test('returns trimmed value for non-empty string', () => {
    expect(nullIfEmpty('  hello  ')).toBe('hello');
    expect(nullIfEmpty('hello')).toBe('hello');
  });
});

// ─────────────────────────────────────────────────────────────
// buildPatch — only changed fields
// ─────────────────────────────────────────────────────────────

describe('buildPatch', () => {
  test('returns null when nothing changed', () => {
    const issue = makeIssue();
    const form = makeFormState(issue);
    expect(buildPatch(form, issue)).toBeNull();
  });

  test('includes only the changed content field', () => {
    const issue = makeIssue({ content: 'original content' });
    const form = makeFormState(issue, { content: 'updated content' });
    const patch = buildPatch(form, issue);
    expect(patch).toEqual({ content: 'updated content' });
  });

  test('includes only the changed severity field', () => {
    const issue = makeIssue({ severity: 'minor' });
    const form = makeFormState(issue, { severity: 'major' });
    const patch = buildPatch(form, issue);
    expect(patch).toEqual({ severity: 'major' });
  });

  test('includes multiple changed fields', () => {
    const issue = makeIssue({ severity: 'minor', content: 'old content' });
    const form = makeFormState(issue, { severity: 'critical', content: 'new content' });
    const patch = buildPatch(form, issue);
    expect(patch).toEqual({ severity: 'critical', content: 'new content' });
  });

  test('converts empty file to null', () => {
    const issue = makeIssue({ file: 'src/foo.ts' });
    const form = makeFormState(issue, { file: '' });
    const patch = buildPatch(form, issue);
    expect(patch).toEqual({ file: null });
  });

  test('does not include file when unchanged', () => {
    const issue = makeIssue({ file: 'src/foo.ts' });
    const form = makeFormState(issue);
    const patch = buildPatch(form, issue);
    expect(patch).toBeNull();
  });

  test('includes file when it changes from null to a value', () => {
    const issue = makeIssue({ file: null });
    const form = makeFormState(issue, { file: 'src/bar.ts' });
    const patch = buildPatch(form, issue);
    expect(patch).toEqual({ file: 'src/bar.ts' });
  });

  test('converts empty startLine/line to null', () => {
    const issue = makeIssue({ start_line: '5', line: '10' });
    const form = makeFormState(issue, { startLine: '', line: '' });
    const patch = buildPatch(form, issue);
    expect(patch).toEqual({ startLine: null, line: null });
  });

  test('includes side when changed', () => {
    const issue = makeIssue({ side: 'RIGHT' });
    const form = makeFormState(issue, { side: 'LEFT' });
    const patch = buildPatch(form, issue);
    expect(patch).toEqual({ side: 'LEFT' });
  });

  test('converts empty suggestion to null', () => {
    const issue = makeIssue({ suggestion: 'Use a map instead' });
    const form = makeFormState(issue, { suggestion: '' });
    const patch = buildPatch(form, issue);
    expect(patch).toEqual({ suggestion: null });
  });

  test('trims content before comparing', () => {
    const issue = makeIssue({ content: 'some text' });
    const form = makeFormState(issue, { content: '  some text  ' });
    // trimmed content matches original → no patch
    expect(buildPatch(form, issue)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// validatePatch — validation rules
// ─────────────────────────────────────────────────────────────

describe('validatePatch', () => {
  test('returns null for a valid patch with no line fields', () => {
    const issue = makeIssue();
    const patch: ReviewIssuePatch = { content: 'Updated text' };
    expect(validatePatch(patch, issue)).toBeNull();
  });

  test('returns error when content is explicitly set to empty', () => {
    const issue = makeIssue();
    const patch: ReviewIssuePatch = { content: '' };
    expect(validatePatch(patch, issue)).toBe('Content is required.');
  });

  test('returns error when start_line is not a positive integer', () => {
    const issue = makeIssue({ line: '10' });
    const patch: ReviewIssuePatch = { startLine: '0' };
    expect(validatePatch(patch, issue)).toBe('Start line must be a positive integer.');
  });

  test('returns error when start_line is a negative number', () => {
    const issue = makeIssue({ line: '10' });
    const patch: ReviewIssuePatch = { startLine: '-5' };
    expect(validatePatch(patch, issue)).toBe('Start line must be a positive integer.');
  });

  test('returns error when line is not a positive integer', () => {
    const issue = makeIssue();
    const patch: ReviewIssuePatch = { line: 'abc' };
    expect(validatePatch(patch, issue)).toBe('Line must be a positive integer.');
  });

  test('returns error when start_line is greater than line', () => {
    const issue = makeIssue();
    const patch: ReviewIssuePatch = { startLine: '20', line: '10' };
    expect(validatePatch(patch, issue)).toBe('Start line must be less than or equal to line.');
  });

  test('returns error when start_line is set but line is cleared', () => {
    const issue = makeIssue({ line: '10' });
    const patch: ReviewIssuePatch = { startLine: '5', line: null };
    expect(validatePatch(patch, issue)).toBe('Start line cannot be set without line.');
  });

  test('returns null when start_line equals line (single line range)', () => {
    const issue = makeIssue();
    const patch: ReviewIssuePatch = { startLine: '10', line: '10' };
    expect(validatePatch(patch, issue)).toBeNull();
  });

  test('returns null for valid multi-line range', () => {
    const issue = makeIssue();
    const patch: ReviewIssuePatch = { startLine: '5', line: '15' };
    expect(validatePatch(patch, issue)).toBeNull();
  });

  test('merges patch start_line with existing issue line when only start_line changes', () => {
    // issue already has line='10', patch only changes startLine
    const issue = makeIssue({ line: '10' });
    const patch: ReviewIssuePatch = { startLine: '3' };
    expect(validatePatch(patch, issue)).toBeNull();
  });

  test('returns error when existing start_line (from issue) is greater than new line', () => {
    const issue = makeIssue({ start_line: '20', line: '25' });
    // patch updates line to 5, but existing start_line is 20 → invalid
    const patch: ReviewIssuePatch = { line: '5' };
    expect(validatePatch(patch, issue)).toBe('Start line must be less than or equal to line.');
  });
});

// ─────────────────────────────────────────────────────────────
// ReviewIssueEditor SSR rendering
// ─────────────────────────────────────────────────────────────

describe('ReviewIssueEditor rendering', () => {
  test('renders form fields with values from the issue', () => {
    const issue = makeIssue({
      severity: 'major',
      category: 'bug',
      file: 'src/example.ts',
      start_line: '5',
      line: '10',
      side: 'LEFT',
      content: 'This needs fixing.',
      suggestion: 'Try this instead',
    });

    const { body } = render(ReviewIssueEditor, {
      props: {
        issue,
        saving: false,
        onSave: vi.fn(),
        onCancel: vi.fn(),
      },
    });

    expect(body).toContain('src/example.ts');
    expect(body).toContain('This needs fixing.');
    expect(body).toContain('Try this instead');
    expect(body).toContain('Save');
    expect(body).toContain('Cancel');
  });

  test('shows Saving… button text and disables inputs when saving=true', () => {
    const issue = makeIssue();
    const { body } = render(ReviewIssueEditor, {
      props: {
        issue,
        saving: true,
        onSave: vi.fn(),
        onCancel: vi.fn(),
      },
    });

    expect(body).toContain('Saving');
    // disabled attribute present on button
    expect(body).toContain('disabled');
  });

  test('renders severity select with all options', () => {
    const issue = makeIssue({ severity: 'critical' });
    const { body } = render(ReviewIssueEditor, {
      props: { issue, saving: false, onSave: vi.fn(), onCancel: vi.fn() },
    });

    expect(body).toContain('Critical');
    expect(body).toContain('Major');
    expect(body).toContain('Minor');
    expect(body).toContain('Info');
  });

  test('renders category select with all options', () => {
    const issue = makeIssue({ category: 'security' });
    const { body } = render(ReviewIssueEditor, {
      props: { issue, saving: false, onSave: vi.fn(), onCancel: vi.fn() },
    });

    expect(body).toContain('Security');
    expect(body).toContain('Performance');
    expect(body).toContain('Bug');
    expect(body).toContain('Style');
  });

  test('renders side select with LEFT and RIGHT options', () => {
    const issue = makeIssue({ side: 'RIGHT' });
    const { body } = render(ReviewIssueEditor, {
      props: { issue, saving: false, onSave: vi.fn(), onCancel: vi.fn() },
    });

    expect(body).toContain('RIGHT');
    expect(body).toContain('LEFT');
  });
});
