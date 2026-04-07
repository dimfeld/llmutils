import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';

describe('pr fix command registration in tim.ts', () => {
  test('registers --executor option for tim pr fix', async () => {
    const sourceFile = path.join(import.meta.dirname, '..', 'tim.ts');
    const source = await fs.readFile(sourceFile, 'utf8');

    const prFixBlockStart = source.indexOf(".command('fix <planId>')");
    expect(prFixBlockStart).toBeGreaterThanOrEqual(0);

    const prFixBlock = source.slice(prFixBlockStart, prFixBlockStart + 700);
    expect(prFixBlock).toContain("'-x, --executor <name>'");
    expect(prFixBlock).not.toContain("'-x, --orchestrator <name>'");
  });
});
