import path from 'node:path';
import { getGitRoot, logSpawn } from './utils.ts';

export async function getInstructionsFromEditor(filename = 'repomix-instructions.md') {
  const gitRoot = await getGitRoot();
  const instructionsFile = path.join(gitRoot, filename);
  const editor = process.env.EDITOR || 'nano';
  let editorProcess = logSpawn([editor, instructionsFile], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  await editorProcess.exited;
  let editorInstructions = (await Bun.file(instructionsFile).text()).trim();

  return editorInstructions;
}

export async function extractFileReferencesFromInstructions(baseDir: string, instructions: string) {
  const fileReferences: string[] = [];
  const dirReferences: string[] = [];

  const gitRoot = await getGitRoot();

  // Regular expression to match potential file or directory paths
  // Matches patterns like src/file.ts, ./folder/, /path/to/something
  // Also matches paths wrapped in quotes, backticks, parentheses, or square brackets
  const pathRegex =
    /(?:"|'|`|\(|\{)(?:\.\/|\.\.\/|\/)?(?:[\w-[\]]+\/)*[\w-[\]]+\.?[\w-[\]]*(?:\/)?(?:"|'|`|\)|\})|(?:\.\/|\.\.\/|\/)?(?:[\w-[\]]+\/)*[\w-[\]]+\.?[\w-[\]]*(?:\/)?/g;

  const matches = instructions.match(pathRegex) || [];
  const results = await Promise.all(
    matches.map(async (match) => {
      if (!match.includes('.') && !match.includes('/')) {
        // Filter out things that are just words and may accidentally match paths,
        // like "services" or "apps".
        return null;
      }

      const normalizedPath = path.normalize(path.join(baseDir, match));
      try {
        const stats = await Bun.file(normalizedPath).stat();
        const isDir = stats.isDirectory();
        return { path: normalizedPath, isDir };
      } catch (e) {
        // Ignore errors (e.g., permission issues or invalid paths)
      }

      if (gitRoot !== baseDir) {
        const gitRootPath = path.normalize(path.join(gitRoot, match));
        try {
          const stats = await Bun.file(gitRootPath).stat();
          const isDir = stats.isDirectory();
          return { path: gitRootPath, isDir };
        } catch (e) {
          // Ignore errors (e.g., permission issues or invalid paths)
        }
      }
    })
  );

  for (const result of results) {
    if (result) {
      const { path: currentPath, isDir } = result;
      if (isDir && !dirReferences.includes(currentPath)) {
        dirReferences.push(currentPath);
      } else if (!isDir && !fileReferences.includes(currentPath)) {
        fileReferences.push(currentPath);
      }
    }
  }

  return { files: fileReferences, directories: dirReferences };
}
