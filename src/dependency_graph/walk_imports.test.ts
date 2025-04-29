import { expect, test } from 'bun:test';
import * as path from 'node:path';

import { packageUp } from 'package-up';
import { ImportWalker } from './walk_imports';
import { Extractor } from '../treesitter/extract.ts';
import { Resolver } from './resolve.ts';

test('walk imports from walk_imports.ts', async () => {
  const rootDir = path.dirname((await packageUp())!);
  const walker = new ImportWalker(new Extractor(), await Resolver.new(rootDir));

  const imports = await walker.getDefiningFiles(
    path.join(rootDir, 'src/dependency_graph/walk_imports.ts')
  );
  expect(Array.from(imports).sort()).toMatchSnapshot();
});

test('walk imports from apply-llm-edits.ts', async () => {
  const rootDir = path.dirname((await packageUp())!);
  const walker = new ImportWalker(new Extractor(), await Resolver.new(rootDir));

  const imports = await walker.getDefiningFiles(path.join(rootDir, 'src/apply-llm-edits/apply.ts'));
  const relativeImports = imports
    .values()
    .map((f) => path.relative(rootDir, f))
    .toArray()
    .sort();
  expect(relativeImports).toMatchSnapshot();
});
