export interface RmfixCliOptions {
  debug?: boolean;
  quiet?: boolean;
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
