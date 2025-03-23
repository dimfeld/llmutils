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
  expect(imports.sort()).toEqual([
    path.join(rootDir, 'src/dependency_graph/resolve.ts'),
    path.join(rootDir, 'src/treesitter/extract.ts'),
  ]);
});

test('walk imports from apply-llm-edits.ts', async () => {
  const rootDir = path.dirname((await packageUp())!);
  const walker = new ImportWalker(new Extractor(), await Resolver.new(rootDir));

  const imports = await walker.getDefiningFiles(path.join(rootDir, 'src/apply-llm-edits.ts'));
  expect(imports.sort()).toEqual([
    path.join(rootDir, 'src/diff-editor/parse.ts'),
    path.join(rootDir, 'src/logging.ts'),
    path.join(rootDir, 'src/whole-file/parse_raw_edits.ts'),
    path.join(rootDir, 'src/xml/parse_xml.ts'),
  ]);
});
