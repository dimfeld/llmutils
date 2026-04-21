import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';

describe('show-config command registration in tim.ts', () => {
  test('registers the show-config subcommand', async () => {
    const sourceFile = path.join(import.meta.dirname, '..', 'tim.ts');
    const source = await fs.readFile(sourceFile, 'utf8');

    const blockStart = source.indexOf(".command('show-config')");
    expect(blockStart).toBeGreaterThanOrEqual(0);

    const block = source.slice(blockStart, blockStart + 300);
    expect(block).toContain('handleShowConfigCommand');
    expect(block).toContain('Print the effective configuration for the current directory as YAML');
  });
});
