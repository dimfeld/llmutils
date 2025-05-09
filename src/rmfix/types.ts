export interface RmfixCoreOptions {
  command: string;
  commandArgs: string[];
  rmfilterArgs: string[];
  // Add other core options as they become clear
}

export interface RmfixRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  fullOutput: string;
}
