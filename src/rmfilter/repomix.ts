import path from 'node:path';
import os from 'node:os';
import { logSpawn } from './utils.ts';

export async function callRepomix(gitRoot: string, args: string[]) {
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

  const repomixOutput = await Bun.file(tempFile).text();
  await Bun.file(tempFile).unlink();
  return repomixOutput;
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
