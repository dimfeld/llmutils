import type { ParsedTestFailure } from './types';
import { debugLog } from '../logging';

// Minimal interfaces for Jest/Vitest JSON structure
interface JestAssertionResult {
  fullName?: string;
  status: string;
  failureMessages?: string[];
  // failureDetails?: any[]; // Potentially useful for more detailed rawFailureDetails in the future
}

interface JestTestResult {
  name: string;
  assertionResults: JestAssertionResult[];
  status: string;
}

interface JestJsonResponse {
  testResults: JestTestResult[];
  // Common top-level fields for identification
  numTotalTests?: number;
  success?: boolean;
  startTime?: number;
}

/**
 * Quickly checks if the parsed JSON data looks like Jest/Vitest output.
 * @param data The parsed JSON data.
 * @returns True if the data resembles Jest/Vitest JSON output, false otherwise.
 */
export function isJestJson(data: any): boolean {
  if (!data || typeof data !== 'object' || data === null) {
    return false;
  }
  // Check for the presence of testResults array and at least one other common top-level field.
  return (
    Array.isArray(data.testResults) &&
    (data.hasOwnProperty('numTotalTests') ||
      data.hasOwnProperty('success') ||
      data.hasOwnProperty('startTime'))
  );
}

/**
 * Parses JSON output from test runners like Jest and Vitest.
 * @param jsonString The JSON string output from the test runner.
 * @param baseDir The base directory of the project (currently unused as paths are kept absolute).
 * @returns An array of ParsedTestFailure objects. Returns an empty array on parsing errors or if no failures are found.
 */
export function parseJestJsonOutput(jsonString: string, baseDir: string): ParsedTestFailure[] {
  let parsedJson: JestJsonResponse;
  try {
    parsedJson = JSON.parse(jsonString) as JestJsonResponse;
  } catch (error) {
    debugLog(
      `[rmfix-parsers] Failed to parse JSON string: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }

  if (!isJestJson(parsedJson)) {
    debugLog('[rmfix-parsers] Parsed JSON does not appear to be Jest/Vitest output.');
    return [];
  }

  const failures: ParsedTestFailure[] = [];

  for (const testSuiteResult of parsedJson.testResults) {
    if (testSuiteResult && Array.isArray(testSuiteResult.assertionResults)) {
      for (const assertionResult of testSuiteResult.assertionResults) {
        if (assertionResult && assertionResult.status === 'failed') {
          const testFilePath = testSuiteResult.name;
          const testName = assertionResult.fullName;
          const errorMessage = (assertionResult.failureMessages || []).join('\n');
          const rawFailureDetails = errorMessage;

          if (testFilePath && testName) {
            failures.push({
              testFilePath,
              testName,
              errorMessage,
              rawFailureDetails,
            });
          } else {
            debugLog(
              `[rmfix-parsers] Skipping failed test in suite '${testSuiteResult.name}' due to missing testFilePath or testName.`
            );
          }
        }
      }
    }
  }

  return failures;
}
