import { test } from 'bun:test';
import { Extractor } from './extract.ts';
import * as path from 'node:path';

test('typescript', async () => {
  const data = await Bun.file(path.join(__dirname, 'fixtures', 'extractTest.ts.txt')).text();
  const extractor = new Extractor();
  const result = await extractor.parseFile('extractTest.ts', data);
  // console.dir(result, { depth: null });
});

test.skip('svelte', async () => {
  const data = await Bun.file(path.join(__dirname, 'fixtures', 'extractTest.svelte.txt')).text();
  const extractor = new Extractor();
  const result = await extractor.parseFile('extractTest.svelte', data);
  // console.dir(result, { depth: null });
});
