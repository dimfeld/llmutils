export interface ParsedTestFailure {
  testFilePath?: string;
  testName?: string;
  errorMessage: string;
  rawFailureDetails?: string;
}

export type OutputFormat = 'json' | 'tap' | 'text';

export interface RmfixCliOptions {
  debug?: boolean;
  quiet?: boolean;
  format?: OutputFormat;
  // ... other rmfix specific flags will go here
}

export interface RmfixCoreOptions {
  command: string;
  commandArgs: string[];
  rmfilterArgs: string[];
  cliOptions: RmfixCliOptions;
}

export interface RmfixRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  fullOutput: string;
}
