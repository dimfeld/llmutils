import { $ } from 'bun';
import path from 'node:path';
import os from 'node:os';
import { logSpawn } from './utils.ts';
import { error } from '../logging.ts';
import type { GlobalValues } from './config.ts';

function purposeString(repoName: string, instructions: string) {
  if (instructions) {
    return `This file contains a packed representation of the \`${repoName}\` repository's contents.
This is a relevant subset of the files in the repository, for the following task:

${instructions}`;
  } else {
    return `This file contains a packed representation of the \`${repoName}\` repository's contents.
This is a relevant subset of the files in the repository, not the entire thing.`;
  }
}

export async function callRepomix(
  gitRoot: string,
  instructions: string,
  args: string[],
  globalValues: GlobalValues = {}
) {
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
    error(`repomix exited with code ${exitCode}`);
    process.exit(exitCode);
  }

  let repomixOutput = await Bun.file(tempFile).text();
  await Bun.file(tempFile).unlink();

  // Drop the notes section
  repomixOutput = repomixOutput
    .replace(/^<notes>.*?^<\/notes>/ms, '')
    .replace(/^<purpose>.*?^<\/purpose>/ms, '');

  const withoutFirstLine = repomixOutput.slice(repomixOutput.indexOf('\n') + 1);

  const output = `<purpose>
  ${purposeString(repoName, globalValues['omit-top-instructions'] ? '' : instructions)}
</purpose>

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
    } catch (e) {
      error(`Error reading config file: ${configPath}`);
    }
  }
  if (!outputFile) {
    outputFile = './repomix-output.txt';
  }
  return outputFile;
}

export function getCommandFilePath(outputFilePath: string) {
  const outputFileParsed = path.parse(outputFilePath);
  const commandFilePath = path.join(outputFileParsed.dir, outputFileParsed.name + '.command.xml');

  return commandFilePath;
}
