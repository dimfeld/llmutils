import { $ } from 'bun';
import path from 'node:path';
import os from 'node:os';
import { logSpawn } from './utils.ts';

const purposeString = (repoName: string) => `
<purpose>
This file contains a packed representation of the \`${repoName}\` repository's contents.
It is designed to be easily consumable by AI systems for analysis, code review,
or other automated processes. This is a subset of the files in the repository,
not the entire thing.
</purpose>
`;

export async function callRepomix(gitRoot: string, args: string[]) {
  let repoOrigin = await $`git config --get remote.origin.url`.cwd(gitRoot).nothrow().text();

  if (repoOrigin) {
    repoOrigin = repoOrigin.trim().replace(/\.git$/, '');
    repoOrigin = repoOrigin.split(':')[1];
  }

  let repoName = repoOrigin || path.basename(gitRoot);

  const tempFile = path.join(os.tmpdir(), `repomix-${Math.random().toString(36).slice(2)}.txt`);
  let proc = logSpawn(['repomix', ...args, '-o', tempFile], {
    cwd: gitRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`repomix exited with code ${exitCode}`);
    process.exit(exitCode);
  }

  let repomixOutput = await Bun.file(tempFile).text();
  await Bun.file(tempFile).unlink();

  // Drop the notes section
  repomixOutput = repomixOutput
    .replace(/<notes>.*<\/notes>/s, '')
    .replace(/<purpose>.*<\/purpose>/s, purposeString);

  const withoutFirstLine = repomixOutput.slice(repomixOutput.indexOf('\n') + 1);

  const output = `This file is a subset of the \`${repoName}\` repository's contents.
${withoutFirstLine}`;

  return output;
}

export async function getOutputPath() {
  const configPath = path.join(os.homedir(), '.config', 'repomix', 'repomix.config.json');
  let outputFile: string | undefined;
  if (await Bun.file(configPath).exists()) {
    try {
      const config = await Bun.file(configPath).json();
      outputFile = config.output?.filePath;
    } catch (error) {
      console.error(`Error reading config file: ${configPath}`);
    }
  }
  if (!outputFile) {
    outputFile = './repomix_output.txt';
  }
  return outputFile;
}
