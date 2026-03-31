import micromatch from 'micromatch';
import type { PullRequest } from './github/pull_requests.ts';
import { parseCliArgsFromString } from './cli.ts';
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

function isSpecialCommentLine(line: string): boolean {
  return (
    line.startsWith('--rmpr') ||
    line.startsWith('rmpr: ') ||
    line.startsWith('--rmfilter') ||
    line.startsWith('rmfilter: ')
  );
}

/**
 * Parses command options from a comment body and returns cleaned comment.
 * @param commentBody The comment body text
 * @param prefix The prefix to look for (e.g., 'rmpr' or 'rmfilter')
 * @returns Parsed options (or null if none) and comment with prefix lines removed
 */
export function parseCommandOptionsFromComment(commentBody: string): ParseRmprResult {
  const lines = commentBody.split('\n');
  const prefixLines = lines.filter((line) => isSpecialCommentLine(line.trim()));
  // Keep non-prefix lines for the cleaned comment
  const cleanedLines = lines.filter((line) => !isSpecialCommentLine(line.trim()));
  const cleanedComment = cleanedLines.join('\n').trim();

  if (prefixLines.length === 0) {
    return { options: null, cleanedComment };
  }

  const options: RmprOptions = {};

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
          break;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }
  }

  return {
    options: Object.keys(options).length > 0 ? options : null,
    cleanedComment,
  };
}
