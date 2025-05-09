import type { ParsedTestFailure, RmfixRunResult, OutputFormat } from './types';
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

/**
 * General parsing function to determine the format and parse the output.
 * @param output The result of the command execution.
 * @param format The desired output format, or 'auto' to attempt auto-detection.
 * @param baseDir The base directory of the project.
 * @returns An array of ParsedTestFailure objects, or an empty array if no failures are found or parsing fails.
 */
export function parseOutput(
  output: RmfixRunResult,
  format: OutputFormat | 'auto',
  baseDir: string
): ParsedTestFailure[] {
  // 1. If format is 'json' or ('auto'):
  if (format === 'json' || format === 'auto') {
    const jsonSource = output.stdout.trim() ? output.stdout : output.fullOutput;
    try {
      // a. Try to parse output.stdout (or output.fullOutput if stdout is empty) as JSON.
      const parsedJson = JSON.parse(jsonSource);
      // b. If successful and isJestJson returns true, call parseJestJsonOutput and return its result.
      if (isJestJson(parsedJson)) {
        debugLog('[rmfix-parsers] Detected Jest/Vitest JSON format.');
        return parseJestJsonOutput(jsonSource, baseDir);
      }
    } catch (error) {
      if (format === 'json') {
        // If specifically requested JSON and it failed, log it.
        debugLog(
          `[rmfix-parsers] Failed to parse as JSON: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      // If 'auto' or JSON parsing failed, will fall through to next parsers.
    }
  }

  // 2. If format is 'tap' or ('auto' and JSON parsing failed):
  if (format === 'tap' || (format === 'auto' && format !== 'json')) {
    // Placeholder for TAP parsing
    debugLog('[rmfix-parsers] TAP parsing not yet implemented.');
  }

  // 3. If format is 'text' or ('auto' and other parsers failed):
  if (format === 'text' || (format === 'auto' && format !== 'json' && format !== 'tap')) {
    // Placeholder for text/regex parsing
    debugLog('[rmfix-parsers] Text/regex parsing not yet implemented.');
  }

  // 4. If no failures found or no parser matched, return an empty array.
  return [];
}
