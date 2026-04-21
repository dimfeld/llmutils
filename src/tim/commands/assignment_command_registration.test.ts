import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';

describe('assignment command registration in tim.ts', () => {
  test('registers claim and release under assignments and removes cleanup', async () => {
    const sourceFile = path.join(import.meta.dirname, '..', 'tim.ts');
    const source = await fs.readFile(sourceFile, 'utf8');

    expect(source).not.toContain(".command('cleanup [files...]')");
    expect(source).not.toContain("program\n  .command('claim <plan>')");
    expect(source).not.toContain("program\n  .command('release <plan>')");
    expect(source).toContain('const assignmentsCommand = program');
    expect(source).toContain("assignmentsCommand\n  .command('claim <plan>')");
    expect(source).toContain("assignmentsCommand\n  .command('release <plan>')");
  });
});
