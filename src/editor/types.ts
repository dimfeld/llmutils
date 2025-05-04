export interface ProcessFileOptions {
  content: string;
  writeRoot: string;
  dryRun?: boolean;
  suppressLogging?: boolean;
}

export interface MatchLocation {
  startLine: number;
  startIndex: number;
  contextLines: string[];
}

export interface ClosestMatchResult {
  lines: string[];
  startLine: number;
  endLine: number;
  score: number;
  // Add startIndex if feasible later, might be complex with fuzzy matching
}

/**
 * Base interface for all edit result types
 */
interface BaseEditResult {
  filePath: string;
  originalText: string;
  updatedText: string;
}

/**
 * Represents a successful edit application
 */
export interface SuccessResult extends BaseEditResult {
  type: 'success';
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
