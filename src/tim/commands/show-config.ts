import yaml from 'yaml';
import { writeStdout } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

export async function handleShowConfigCommand(_options: any, command: any): Promise<void> {
  const globalOpts = command.parent?.opts?.() ?? {};
  const config = await loadEffectiveConfig(globalOpts.config, {
    cwd: process.cwd(),
    quiet: true,
  });
  const output = yaml.stringify(config, {
    lineWidth: 0,
  });
  writeStdout(ensureTrailingNewline(output));
}
