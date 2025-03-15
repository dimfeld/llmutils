import { test } from 'bun:test';
import { parseFile } from './extract.ts';
import * as path from 'node:path';

test('extract', async () => {
  const data = await Bun.file(path.join(__dirname, 'fixtures', 'extractTest.ts.txt')).text();
  const result = await parseFile('extractTest.ts', data);
  console.dir(result, { depth: null });
});
