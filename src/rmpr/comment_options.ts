import micromatch from 'micromatch';
import type { PullRequest } from '../common/github/pull_requests.ts';
import { parseCliArgsFromString } from '../rmfilter/utils.ts';
import { debugLog } from '../logging.ts';

/** Options parsed from --rmpr lines in a comment body */
export interface RmprOptions {
  includeAll?: boolean;
  noImports?: boolean;
  withImporters?: boolean;
  include?: string[];
  rmfilter?: string[];
}

export function combineRmprOptions(a: RmprOptions, b: RmprOptions): RmprOptions {
  return {
    includeAll: a.includeAll || b.includeAll,
    noImports: a.noImports && b.noImports,
    withImporters: a.withImporters || b.withImporters,
    include: [...(a.include ?? []), ...(b.include ?? [])],
    rmfilter: [...(a.rmfilter ?? []), ...(b.rmfilter ?? [])],
  };
}

export function argsFromRmprOptions(pr: PullRequest, options: RmprOptions): string[] {
  const args: string[] = [];
  let prFiles = pr.files.nodes.map((f) => f.path);
  if (options.includeAll) {
    args.push(...prFiles);
  }
  if (!options.noImports) {
    args.push('--with-imports');
  }
  if (options.withImporters) {
    args.push('with-importers');
  }
  if (options.include) {
    for (let includePath of options.include) {
      if (includePath.startsWith('pr:')) {
        includePath = includePath.slice(3);
        // Filter globs to PR files only
        const matchedFiles = micromatch(prFiles, includePath);
        args.push(...matchedFiles);
        debugLog(`Added PR-matched files for --rmpr include pr:${includePath}:`, matchedFiles);
      } else {
        args.push(includePath);
        debugLog(`Added file/dir for --rmpr include ${includePath}`);
      }
    }
  }
  if (options.rmfilter) {
    args.push(...options.rmfilter);
  }
  return args;
}

/**
 * Parses --rmpr options from a comment body.
 * @param commentBody The comment body text
 * @returns Parsed RmprOptions or null if no valid --rmpr options are found
 */
export function parseRmprOptions(commentBody: string): RmprOptions | null {
  const lines = commentBody.split('\n');
  const rmprLines = lines.filter((line) => {
    line = line.trim();
    return line.startsWith('--rmpr') || line.startsWith('rmpr: ');
  });
  if (rmprLines.length === 0) {
    return null;
  }

  const options: RmprOptions = {};
  for (const line of rmprLines) {
    const args = parseCliArgsFromString(line.replace(/^(?:--rmpr|rmpr:)\s+/, '').trim());
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === 'include-all') {
        options.includeAll = true;
        i++;
      } else if (arg === 'no-imports') {
        options.noImports = true;
        i++;
      } else if (arg === 'with-importers') {
        options.withImporters = true;
        i++;
      } else if (arg === 'include') {
        if (i + 1 < args.length) {
          options.include = options.include || [];
          options.include.push(...args[i + 1].split(','));
          // include consumes all remaining args
          break;
        } else {
          i++;
        }
      } else if (arg === 'rmfilter') {
        if (i + 1 < args.length) {
          options.rmfilter = options.rmfilter || [];
          options.rmfilter.push(...args.slice(i + 1).flatMap((x) => x.split(' ')));
          break; // rmfilter consumes all remaining args
        } else {
          i++;
        }
      } else {
        i++;
      }
    }
  }

  return Object.keys(options).length > 0 ? options : null;
}
