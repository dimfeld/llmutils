import micromatch from 'micromatch';
import type { PullRequest } from '../common/github/pull_requests.ts';
import { parseCliArgsFromString } from '../rmfilter/utils.ts';
import { debugLog, warn } from '../logging.ts';

/** Options parsed from --rmpr lines in a comment body */
export interface RmprOptions {
  includeAll?: boolean;
  withImports?: boolean;
  withImporters?: boolean;
  include?: string[];
  rmfilter?: string[];
}

/** Result of parsing rmpr options, including cleaned comment */
export interface ParseRmprResult {
  options: RmprOptions | null;
  cleanedComment: string;
}

export function combineRmprOptions(a: RmprOptions, b: RmprOptions): RmprOptions {
  return {
    includeAll: a.includeAll || b.includeAll,
    withImports: a.withImports || b.withImports,
    withImporters: a.withImporters || b.withImporters,
    include: [...(a.include ?? []), ...(b.include ?? [])],
    rmfilter: [...(a.rmfilter ?? []), ...(b.rmfilter ?? [])],
  };
}

/**
 * Converts RmprOptions to command-line arguments for rmfilter.
 * If a PullRequest is provided, includes PR-specific options; otherwise, warns and skips them.
 * @param options The RmprOptions to convert
 * @param pr Optional PullRequest for PR-specific processing
 * @returns Array of string arguments suitable for passing to rmfilter
 */
export function argsFromRmprOptions(options: RmprOptions, pr?: PullRequest): string[] {
  const args: string[] = [];

  if (options.withImports) {
    args.push('--with-imports');
  }

  if (options.withImporters) {
    args.push('--with-importers');
  }

  if (options.include) {
    for (const pathSpec of options.include) {
      if (pathSpec.startsWith('pr:')) {
        if (pr) {
          if (!options.includeAll) {
            const includePath = pathSpec.slice(3);
            const prFiles = pr.files.nodes.map((f) => f.path);
            // Filter globs to PR files only
            const matchedFiles = micromatch(prFiles, [includePath, includePath + '/**/*']);
            args.push(...matchedFiles);
            debugLog(`Added PR-matched files for --rmpr include pr:${includePath}:`, matchedFiles);
          }
        } else {
          warn(`Skipping PR-specific include directive in generic context: ${pathSpec}`);
        }
      } else {
        args.push(pathSpec);
        debugLog(`Added file/dir for --rmpr include ${pathSpec}`);
      }
    }
  }

  if (options.rmfilter) {
    for (const pathSpec of options.rmfilter) {
      if (pathSpec.startsWith('pr:')) {
        if (pr) {
          const includePath = pathSpec.slice(3);
          const prFiles = pr.files.nodes.map((f) => f.path);
          // Filter globs to PR files only
          const matchedFiles = micromatch(prFiles, [includePath, includePath + '/**/*']);
          args.push(...matchedFiles);
          debugLog(`Added PR-matched files for --rmpr include pr:${includePath}:`, matchedFiles);
        } else {
          warn(`Skipping PR-specific include directive in generic context: ${pathSpec}`);
        }
      } else {
        args.push(pathSpec);
      }
    }
  }

  if (options.includeAll) {
    if (pr) {
      const prFiles = pr.files.nodes.map((f) => f.path);
      args.push(...prFiles);
    } else {
      warn('Skipping PR-specific "include-all" directive in generic context.');
    }
  }

  return args;
}

/**
 * Parses command options from a comment body and returns cleaned comment.
 * @param commentBody The comment body text
 * @param prefix The prefix to look for (e.g., 'rmpr' or 'rmfilter')
 * @returns Parsed options (or null if none) and comment with prefix lines removed
 */
export function parseCommandOptionsFromComment(
  commentBody: string,
  prefix: string
): ParseRmprResult {
  const isSpecialCommentLine = (line: string): boolean => {
    return (
      line.startsWith(`--${prefix}`) ||
      line.startsWith(`${prefix}: `) ||
      (prefix === 'rmpr' && (line.startsWith('--rmfilter') || line.startsWith('rmfilter: ')))
    );
  };

  const lines = commentBody.split('\n');
  const prefixLines = lines.filter((line) => isSpecialCommentLine(line.trim()));
  // Keep non-prefix lines for the cleaned comment
  const cleanedLines = lines.filter((line) => !isSpecialCommentLine(line.trim()));
  const cleanedComment = cleanedLines.join('\n').trim();

  if (prefixLines.length === 0) {
    return { options: null, cleanedComment };
  }

  const options: RmprOptions = {};

  if (prefix === 'rmfilter') {
    // For rmfilter prefix, just collect all arguments after the prefix
    for (const line of prefixLines) {
      const trimmedLine = line.trim();
      const args = parseCliArgsFromString(
        trimmedLine.replace(new RegExp(`^(?:--${prefix}|${prefix}:)\\s+`), '').trim()
      );
      options.rmfilter = options.rmfilter || [];
      options.rmfilter.push(...args);
    }
  } else {
    // Original parsing logic for rmpr
    for (const line of prefixLines) {
      const isRmfilterComment = line.startsWith('--rmfilter') || line.startsWith('rmfilter: ');
      const args = parseCliArgsFromString(
        line.replace(/^(?:--rmpr|rmpr:|--rmfilter|rmfilter:)\s+/, '').trim()
      );

      if (isRmfilterComment) {
        options.rmfilter = options.rmfilter || [];
        options.rmfilter.push('--', ...args);
        continue;
      }

      let i = 0;
      while (i < args.length) {
        const arg = args[i];
        if (arg === 'include-all') {
          options.includeAll = true;
          i++;
        } else if (arg === 'with-imports') {
          options.withImports = true;
          i++;
        } else if (arg === 'with-importers') {
          options.withImporters = true;
          i++;
        } else if (arg === 'include') {
          if (i + 1 < args.length) {
            options.include = options.include || [];
            options.include.push(...args.slice(i + 1).flatMap((x) => x.split(/[ ,]+/)));
            // include consumes all remaining args
            break;
          } else {
            i++;
          }
        } else if (arg === 'rmfilter') {
          if (i + 1 < args.length) {
            options.rmfilter = options.rmfilter || [];
            options.rmfilter.push('--', ...args.slice(i + 1).flatMap((x) => x.split(' ')));
            break; // rmfilter consumes all remaining args
          } else {
            i++;
          }
        } else {
          i++;
        }
      }
    }
  }

  return {
    options: Object.keys(options).length > 0 ? options : null,
    cleanedComment,
  };
}

/**
 * Parses --rmpr options from a comment body and returns cleaned comment.
 * @param commentBody The comment body text
 * @returns Parsed options (or null if none) and comment with rmpr lines removed
 */
export function parseRmprOptions(commentBody: string): ParseRmprResult {
  return parseCommandOptionsFromComment(commentBody, 'rmpr');
}
