import type { GitDiff, CodeLocation, DiffHunk } from './types';

export class DiffMapper {
  private oldToNew: Map<number, number>;
  private newToOld: Map<number, number>;
  private deletedLines: Set<number>;
  private addedLines: Set<number>;

  constructor(private diff: GitDiff) {
    this.oldToNew = new Map();
    this.newToOld = new Map();
    this.deletedLines = new Set();
    this.addedLines = new Set();
    this.buildLineMapping();
  }

  private buildLineMapping(): void {
    for (const file of this.diff.files) {
      let oldLine = 1;
      let newLine = 1;

      for (const hunk of file.hunks) {
        // Jump to hunk start
        oldLine = hunk.oldStart;
        newLine = hunk.newStart;

        // Process each line in hunk
        for (const line of hunk.lines) {
          if (line.type === 'delete') {
            this.deletedLines.add(oldLine);
            oldLine++;
          } else if (line.type === 'add') {
            this.addedLines.add(newLine);
            newLine++;
          } else {
            // Context line - exists in both
            this.oldToNew.set(oldLine, newLine);
            this.newToOld.set(newLine, oldLine);
            oldLine++;
            newLine++;
          }
        }
      }
    }
  }

  mapLocation(location: CodeLocation, direction: 'oldToNew' | 'newToOld'): CodeLocation | null {
    const mapping = direction === 'oldToNew' ? this.oldToNew : this.newToOld;
    
    const newStart = mapping.get(location.startLine);
    const newEnd = mapping.get(location.endLine);

    if (newStart && newEnd) {
      // Lines exist in both versions
      return {
        ...location,
        startLine: newStart,
        endLine: newEnd,
      };
    }

    // Line was added/deleted, find nearest
    return this.findNearestLocation(location, mapping, direction);
  }

  private findNearestLocation(
    location: CodeLocation,
    mapping: Map<number, number>,
    direction: 'oldToNew' | 'newToOld'
  ): CodeLocation | null {
    // Find the nearest mapped lines
    let nearestBefore: number | undefined;
    let nearestAfter: number | undefined;
    let mappedBefore: number | undefined;
    let mappedAfter: number | undefined;

    for (const [oldLine, newLine] of mapping.entries()) {
      if (oldLine < location.startLine) {
        if (!nearestBefore || oldLine > nearestBefore) {
          nearestBefore = oldLine;
          mappedBefore = newLine;
        }
      } else if (oldLine > location.endLine) {
        if (!nearestAfter || oldLine < nearestAfter) {
          nearestAfter = oldLine;
          mappedAfter = newLine;
        }
      }
    }

    // If we have both before and after, interpolate
    if (mappedBefore && mappedAfter) {
      const deletedOrAdded = direction === 'oldToNew' ? this.deletedLines : this.addedLines;
      const rangeDeleted = this.countInRange(
        deletedOrAdded,
        nearestBefore!,
        nearestAfter!
      );

      // Adjust for deleted/added lines
      const startOffset = location.startLine - nearestBefore!;
      const endOffset = location.endLine - nearestBefore!;
      
      return {
        ...location,
        startLine: mappedBefore + startOffset,
        endLine: mappedBefore + endOffset,
      };
    }

    // Only have before or after
    if (mappedBefore) {
      const offset = location.startLine - nearestBefore!;
      return {
        ...location,
        startLine: mappedBefore + offset,
        endLine: mappedBefore + offset + (location.endLine - location.startLine),
      };
    }

    if (mappedAfter) {
      const offset = nearestAfter! - location.endLine;
      return {
        ...location,
        startLine: Math.max(1, mappedAfter - offset - (location.endLine - location.startLine)),
        endLine: Math.max(1, mappedAfter - offset),
      };
    }

    // No mapping found
    return null;
  }

  private countInRange(set: Set<number>, start: number, end: number): number {
    let count = 0;
    for (const line of set) {
      if (line > start && line < end) {
        count++;
      }
    }
    return count;
  }

  getLineMapping(line: number, direction: 'oldToNew' | 'newToOld'): number | null {
    const mapping = direction === 'oldToNew' ? this.oldToNew : this.newToOld;
    return mapping.get(line) || null;
  }

  isLineDeleted(line: number): boolean {
    return this.deletedLines.has(line);
  }

  isLineAdded(line: number): boolean {
    return this.addedLines.has(line);
  }

  getMappedRange(startLine: number, endLine: number, direction: 'oldToNew' | 'newToOld'): { start: number; end: number } | null {
    const location: CodeLocation = {
      file: '',
      startLine,
      endLine,
      type: 'block',
    };

    const mapped = this.mapLocation(location, direction);
    if (!mapped) return null;

    return {
      start: mapped.startLine,
      end: mapped.endLine,
    };
  }
}