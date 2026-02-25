import * as path from 'path';

export const jsExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'];
/** A nonexhaustive list of non-code extensions */
export const nonCodeExtensions = ['.css', '.json', '.png', '.jpg', '.svg', '.yml', '.yaml', '.md'];

export function isCodeFile(filename: string): boolean {
  return !nonCodeExtensions.includes(path.extname(filename));
}

export function importCandidates(filename: string): string[] {
  const existingExt = path.extname(filename);
  let candidates: string[];
  if (!existingExt) {
    candidates = jsExtensions.map((ext) => filename + ext);
  } else if (existingExt === '.js') {
    candidates = [filename, filename.replace('.js', '.ts')];
  } else if (existingExt === '.ts') {
    candidates = [filename, filename.replace('.ts', '.js')];
  } else if (existingExt === '.mjs') {
    candidates = [filename, filename.replace('.mjs', '.mts')];
  } else if (existingExt === '.mts') {
    candidates = [filename, filename.replace('.mts', '.mjs')];
  } else {
    candidates = [filename];
  }

  return candidates;
}
