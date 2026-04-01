import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { selectHierarchicalIssueComments } from './issue_utils.js';
import type { IssueWithComments, IssueData } from '../common/issue_tracker/types.js';

// Mock the modules before importing
vi.mock('console', () => ({
  log: vi.fn(() => {}),
}));

vi.mock('../common/formatting.js', () => ({
  singleLineWithPrefix: vi.fn((prefix: string, text: string) => prefix + text),
  limitLines: vi.fn((text: string) => text),
}));

vi.mock('@inquirer/prompts', () => ({
  checkbox: vi.fn(),
}));

// Import the mocked modules
import { checkbox } from '@inquirer/prompts';
import { singleLineWithPrefix, limitLines } from '../common/formatting.js';

// Get the mocked functions
const mockCheckbox = vi.mocked(checkbox);
const mockSingleLineWithPrefix = vi.mocked(singleLineWithPrefix);
const mockLimitLines = vi.mocked(limitLines);

const mockParentIssue: IssueData = {
  id: 'TEAM-123',
  number: 'TEAM-123',
  title: 'Parent Issue',
  body: 'Parent issue body',
  htmlUrl: 'https://linear.app/team/issue/TEAM-123',
  state: 'open',
  createdAt: '2023-01-01T00:00:00Z',
  updatedAt: '2023-01-01T00:00:00Z',
  user: { id: 'user1', login: 'author', name: 'Author' },
  assignees: [],
};

const mockChildIssue1: IssueData = {
  id: 'TEAM-124',
  number: 'TEAM-124',
  title: 'Child Issue 1',
  body: 'Child 1 body',
  htmlUrl: 'https://linear.app/team/issue/TEAM-124',
  state: 'open',
  createdAt: '2023-01-01T00:00:00Z',
  updatedAt: '2023-01-01T00:00:00Z',
  user: { id: 'user1', login: 'author', name: 'Author' },
  assignees: [],
};

const mockChildIssue2: IssueData = {
  id: 'TEAM-125',
  number: 'TEAM-125',
  title: 'Child Issue 2',
  body: 'Child 2 body',
  htmlUrl: 'https://linear.app/team/issue/TEAM-125',
  state: 'open',
  createdAt: '2023-01-01T00:00:00Z',
  updatedAt: '2023-01-01T00:00:00Z',
  user: { id: 'user1', login: 'author', name: 'Author' },
  assignees: [],
};

const mockHierarchicalIssue: IssueWithComments = {
  issue: mockParentIssue,
  comments: [],
  children: [
    {
      issue: mockChildIssue1,
      comments: [],
    },
    {
      issue: mockChildIssue2,
      comments: [],
    },
  ],
};

describe('selectHierarchicalIssueComments', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    // Mock process.stdout.rows
    Object.defineProperty(process.stdout, 'rows', {
      value: 30,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('should allow user to select subset of subissues', async () => {
    // Mock checkbox to select only the first subissue, then select parent content
    let checkboxCallCount = 0;
    mockCheckbox.mockImplementation(() => {
      checkboxCallCount++;
      if (checkboxCallCount === 1) {
        // First call: subissue selection (select only first child)
        return Promise.resolve([0]); // Select only first child
      } else {
        // Second call: content selection (select parent body)
        return Promise.resolve([1]); // Select parent body (index 1)
      }
    });

    const result = await selectHierarchicalIssueComments(mockHierarchicalIssue, true);

    // Should have been called twice
    expect(mockCheckbox).toHaveBeenCalledTimes(2);

    // First call should be for subissue selection
    expect(mockCheckbox.mock.calls[0][0]).toMatchObject({
      message: 'Select subissues to import for TEAM-123 - Parent Issue:',
      choices: [
        { name: 'TEAM-124: Child Issue 1', value: 0, checked: true },
        { name: 'TEAM-125: Child Issue 2', value: 1, checked: true },
      ],
      required: false,
    });

    // Result should only include the selected child
    expect(result.childrenContent).toHaveLength(1);
    expect(result.childrenContent[0].issueData.issue.number).toBe('TEAM-124');
  });

  test('should handle case where no subissues are selected', async () => {
    // Mock checkbox to select no subissues, then select parent content
    let checkboxCallCount = 0;
    mockCheckbox.mockImplementation(() => {
      checkboxCallCount++;
      if (checkboxCallCount === 1) {
        // First call: subissue selection (select none)
        return Promise.resolve([]);
      } else {
        // Second call: content selection (select parent body)
        return Promise.resolve([1]); // Select parent body
      }
    });

    const result = await selectHierarchicalIssueComments(mockHierarchicalIssue, true);

    // Should still call content selection for parent
    expect(mockCheckbox).toHaveBeenCalledTimes(2);

    // Result should have no children content
    expect(result.childrenContent).toHaveLength(0);
    expect(result.parentContent).toHaveLength(1);
  });

  test('should handle issue with no children', async () => {
    const issueWithNoChildren: IssueWithComments = {
      issue: mockParentIssue,
      comments: [],
    };

    // Mock checkbox for content selection only
    mockCheckbox.mockImplementation(() => Promise.resolve([1])); // Select parent body

    const result = await selectHierarchicalIssueComments(issueWithNoChildren, true);

    // Should only be called once (for content selection)
    expect(mockCheckbox).toHaveBeenCalledTimes(1);

    // Result should have parent content but no children
    expect(result.parentContent).toHaveLength(1);
    expect(result.childrenContent).toHaveLength(0);
  });

  test('should update content selection message based on selected children', async () => {
    // Mock checkbox to select both subissues, then select content
    let checkboxCallCount = 0;
    mockCheckbox.mockImplementation(() => {
      checkboxCallCount++;
      if (checkboxCallCount === 1) {
        // First call: select both subissues
        return Promise.resolve([0, 1]);
      } else {
        // Second call: select some content
        return Promise.resolve([1]);
      }
    });

    await selectHierarchicalIssueComments(mockHierarchicalIssue, true);

    // Check that the second call (content selection) has the correct message
    expect(mockCheckbox.mock.calls[1][0].message).toBe(
      'Select content from TEAM-123 - Parent Issue and 2 selected child issue(s)'
    );
  });
});
