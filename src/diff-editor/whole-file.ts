interface Edit {
  path: string;
  fnameSource?: string;
  newLines?: string[];
}

interface IO {
  readText(path: string): string | null;
  writeText(path: string, content: string): void;
}

// Base Coder class (simplified)
abstract class Coder {
  protected root: string;
  protected fence: [string, string];
  protected io: IO;

  constructor(root: string, io: IO) {
    this.root = root;
    this.fence = ['```', '```'];
    this.io = io;
  }

  protected absRootPath(path: string): string {
    return `${this.root}/${path}`;
  }

  abstract getEdits(content: string): Edit[];
  abstract applyEdits(edits: Edit[]): void;
}

// WholeFileCoder
class WholeFileCoder extends Coder {
  private getInchatRelativeFiles(): string[] {
    // Placeholder - implement based on your needs
    return [];
  }

  getEdits(content: string, mode: 'update' | 'diff' = 'update'): Edit[] {
    const chatFiles = this.getInchatRelativeFiles();
    const lines = content.split('\n');
    const edits: Edit[] = [];

    let output: string[] = [];
    let sawFname: string | null = null;
    let fname: string | null = null;
    let fnameSource: string | undefined;
    let newLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith(this.fence[0]) || line.startsWith(this.fence[1])) {
        if (fname !== null) {
          // Ending a block
          sawFname = null;

          const fullPath = this.absRootPath(fname);
          if (mode === 'diff') {
            output = output.concat(this.doLiveDiff(fullPath, newLines, true));
          } else {
            edits.push({ path: fname, fnameSource, newLines });
          }

          fname = null;
          fnameSource = undefined;
          newLines = [];
          continue;
        }

        // Starting a new block
        if (i > 0) {
          fnameSource = 'block';
          fname = lines[i - 1]
            .trim()
            .replace(/^\*+|\*+$/g, '') // Remove ** markers
            .replace(/:$/, '') // Remove trailing colon
            .replace(/`/g, '') // Remove backticks
            .replace(/^#/, '') // Remove leading #
            .trim();

          if (fname.length > 250) {
            fname = '';
          }

          if (fname && !chatFiles.includes(fname) && chatFiles.includes(fname.split('/').pop()!)) {
            fname = fname.split('/').pop()!;
          }
        }

        if (!fname) {
          if (sawFname) {
            fname = sawFname;
            fnameSource = 'saw';
          } else if (chatFiles.length === 1) {
            fname = chatFiles[0];
            fnameSource = 'chat';
          } else {
            throw new Error(`No filename provided before ${this.fence[0]} in file listing`);
          }
        }
      } else if (fname !== null) {
        newLines.push(line);
      } else {
        const words = line.trim().split(/\s+/);
        for (const word of words) {
          const cleanWord = word.replace(/[.:,!]$/, '');
          const quotedFile = `\`${cleanWord}\``;
          const match = chatFiles.find((f) => f === cleanWord || quotedFile === f);
          if (match) sawFname = match;
        }
        output.push(line);
      }
    }

    if (mode === 'diff') {
      if (fname !== null) {
        const fullPath = this.absRootPath(fname);
        output = output.concat(this.doLiveDiff(fullPath, newLines, false));
      }
      return [{ path: '', newLines: [output.join('\n')] }];
    }

    if (fname) {
      edits.push({ path: fname, fnameSource, newLines });
    }

    // Process edits by source priority
    const seen = new Set<string>();
    const refinedEdits: Edit[] = [];
    const sources = ['block', 'saw', 'chat'];

    for (const source of sources) {
      for (const edit of edits) {
        if (edit.fnameSource !== source || seen.has(edit.path)) continue;
        seen.add(edit.path);
        refinedEdits.push(edit);
      }
    }

    return refinedEdits;
  }

  applyEdits(edits: Edit[]): void {
    for (const edit of edits) {
      const fullPath = this.absRootPath(edit.path);
      const content = (edit.newLines || []).join('');
      this.io.writeText(fullPath, content);
    }
  }

  private doLiveDiff(fullPath: string, newLines: string[], final: boolean): string[] {
    const content = this.io.readText(fullPath);
    if (content !== null) {
      const origLines = content.split('\n');
      // Note: This needs a diff library equivalent to Python's diffs
      // For now, returning simple diff placeholder
      return [
        '```diff',
        ...newLines.map((line) => `+${line}`),
        ...origLines.map((line) => `-${line}`),
        '```',
      ];
    }
    return ['```', ...newLines, '```'];
  }
}

class SearchTextNotUniqueError extends Error {}
