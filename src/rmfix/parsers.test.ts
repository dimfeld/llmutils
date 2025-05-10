import { describe, it, expect } from 'bun:test';
import { parseJestJsonOutput, isJestJson } from './parsers';
import type { ParsedTestFailure } from './types';

const MOCK_BASE_DIR = '/project/root';

describe('parseJestJsonOutput', () => {
  it('Test Case 1: should parse valid Jest JSON with failures', () => {
    const jestJsonString = JSON.stringify({
      numTotalTestSuites: 2,
      numPassedTestSuites: 1,
      numFailedTestSuites: 1,
      numTotalTests: 3,
      numPassedTests: 1,
      numFailedTests: 2,
      success: false,
      startTime: 1678886400000,
      testResults: [
        {
          name: '/project/root/src/example.test.js',
          status: 'failed',
          assertionResults: [
            {
              fullName: 'Example Test Suite > Test 1',
              status: 'failed',
              failureMessages: ['Error: Test 1 failed\n    at <stacktrace>'],
              title: 'Test 1',
            },
            {
              fullName: 'Example Test Suite > Test 2',
              status: 'failed',
              failureMessages: ['Error: Test 2 failed horribly\n    at <another stacktrace>'],
              title: 'Test 2',
            },
          ],
        },
        {
          name: '/project/root/src/another.test.js',
          status: 'passed',
          assertionResults: [
            {
              fullName: 'Another Test Suite > Test A',
              status: 'passed',
              title: 'Test A',
            },
          ],
        },
      ],
    });

    const expectedFailures: ParsedTestFailure[] = [
      {
        testFilePath: '/project/root/src/example.test.js',
        testName: 'Example Test Suite > Test 1',
        errorMessage: 'Error: Test 1 failed\n    at <stacktrace>',
        rawFailureDetails: 'Error: Test 1 failed\n    at <stacktrace>',
      },
      {
        testFilePath: '/project/root/src/example.test.js',
        testName: 'Example Test Suite > Test 2',
        errorMessage: 'Error: Test 2 failed horribly\n    at <another stacktrace>',
        rawFailureDetails: 'Error: Test 2 failed horribly\n    at <another stacktrace>',
      },
    ];

    const result = parseJestJsonOutput(jestJsonString, MOCK_BASE_DIR);
    expect(result).toEqual(expectedFailures);
  });

  it('Test Case 2: should return an empty array for valid Jest JSON with no failures', () => {
    const jestJsonString = JSON.stringify({
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      success: true,
      startTime: 1678886400000,
      testResults: [
        {
          name: '/project/root/src/another.test.js',
          status: 'passed',
          assertionResults: [
            {
              fullName: 'Another Test Suite > Test A',
              status: 'passed',
              title: 'Test A',
            },
          ],
        },
      ],
    });

    const result = parseJestJsonOutput(jestJsonString, MOCK_BASE_DIR);
    expect(result).toEqual([]);
  });

  it('Test Case 3: should return an empty array for an invalid JSON string', () => {
    const invalidJsonString = 'This is not JSON {';
    const result = parseJestJsonOutput(invalidJsonString, MOCK_BASE_DIR);
    expect(result).toEqual([]);
  });

  it('Test Case 4: should return an empty array for JSON that is not Jest/Vitest format', () => {
    const nonJestJsonString = JSON.stringify({
      someOtherKey: 'someValue',
      data: [1, 2, 3],
    });

    const parsedNonJestJson = JSON.parse(nonJestJsonString);
    expect(isJestJson(parsedNonJestJson)).toBe(false);

    const result = parseJestJsonOutput(nonJestJsonString, MOCK_BASE_DIR);
    expect(result).toEqual([]);
  });

  it('should handle missing fullName or failureMessages gracefully', () => {
    const jestJsonString = JSON.stringify({
      numTotalTests: 1,
      success: false,
      testResults: [
        {
          name: '/project/root/src/edgecase.test.js',
          status: 'failed',
          assertionResults: [
            {
              // fullName is missing
              status: 'failed',
              failureMessages: ['Error: A test failed'],
            },
            {
              fullName: 'Edge Case Test > No Message',
              status: 'failed',
              // failureMessages is missing
            },
          ],
        },
      ],
    });
    // The current implementation skips failures if testFilePath or testName (from fullName) is missing.
    // If failureMessages is missing, errorMessage becomes empty string.
    const result = parseJestJsonOutput(jestJsonString, MOCK_BASE_DIR);
    // Expecting one failure because the second one has a fullName.
    expect(result.length).toBe(1);
    expect(result[0].testName).toBe('Edge Case Test > No Message');
    expect(result[0].errorMessage).toBe('');
  });
});
