export interface CodeLocation {
  file: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  symbol?: string;
  type: 'function' | 'class' | 'method' | 'variable' | 'block' | 'file';
}

export interface LocationContext {
  beforeLines: string[];
  targetLines: string[];
  afterLines: string[];
  indentLevel: number;
  parentSymbols: string[];
}

export interface LocationMatch {
  location: CodeLocation;
  confidence: number;
  matchType: 'exact' | 'fuzzy' | 'contextual' | 'relative';
  evidence: string[];
}

export interface Symbol {
  name: string;
  type: 'function' | 'class' | 'method' | 'variable' | 'interface' | 'type';
  location: CodeLocation;
  signature?: string;
  members?: string[];
  file: string;
}

export interface SearchContext {
  file?: string;
  nearLine?: number;
  inClass?: string;
  preferredType?: Symbol['type'];
}

export interface GitDiff {
  files: DiffFile[];
  changedFiles: string[];
}

export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'add' | 'delete' | 'context';
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface FileContent {
  path: string;
  content: string;
  language?: string;
}

export interface Block {
  location: CodeLocation;
  content: string;
  type: 'function' | 'class' | 'method' | 'block';
}

export interface CacheContext {
  prNumber: number;
  fileHash: string;
  commitSha?: string;
}

export interface CachedLocation {
  location: CodeLocation;
  context: CacheContext;
  timestamp: number;
}

export class LocationNotFoundError extends Error {
  constructor(
    public reference: string,
    public suggestions: string[] = []
  ) {
    super(`Could not locate reference: ${reference}`);
    this.name = 'LocationNotFoundError';
  }
}