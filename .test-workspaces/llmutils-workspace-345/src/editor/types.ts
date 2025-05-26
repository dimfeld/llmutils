export interface ProcessFileOptions {
  content: string;
  writeRoot: string;
  dryRun?: boolean;
  suppressLogging?: boolean;
  ignoreFiles?: string[];
}

export interface MatchLocation {
  startLine: number;
  startIndex: number;
  contextLines: string[];
}

export interface ClosestMatchResult {
  lines: string[];
  // 1-indexed line number
  startLine: number;
  endLine: number;
  score: number;
  // Add startIndex if feasible later, might be complex with fuzzy matching
}

/**
 * Base interface for all edit result types
 */
export interface BaseEditResult {
  filePath: string;
  originalText: string;
  updatedText: string;
}

/**
 * Represents a successful edit application
 */
export interface SuccessResult extends BaseEditResult {
  type: 'success';
  startLine: number;
}

/**
 * Represents a failure where the original text couldn't be found exactly
 */
export interface NoMatchFailure extends BaseEditResult {
  type: 'noMatch';
  closestMatch: ClosestMatchResult | null;
}

/**
 * Represents a failure where the original text was found in multiple locations
 */
export interface NotUniqueFailure extends BaseEditResult {
  type: 'notUnique';
  matchLocations: MatchLocation[];
}

export type FailureResult = NoMatchFailure | NotUniqueFailure;
export type EditResult = SuccessResult | FailureResult;
