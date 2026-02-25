import { expect, test, describe, afterAll, beforeAll } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'fs/promises';
import * as os from 'os';

import { packageUp } from 'package-up';
import { ImportWalker } from './walk_imports';
import { Extractor } from '../treesitter/extract.ts';
import { Resolver } from './resolve.ts';

describe('getDefiningFiles', () => {
  test('walk imports from walk_imports.ts', async () => {
    const rootDir = path.dirname((await packageUp())!);
    const walker = new ImportWalker(new Extractor(), await Resolver.new(rootDir));

    const imports = await walker.getDefiningFiles(
      path.join(rootDir, 'src/dependency_graph/walk_imports.ts')
    );
    const relativeImports = imports
      .values()
      .map((f) => path.relative(rootDir, f))
      .toArray()
      .sort();
    expect(relativeImports).toMatchSnapshot();
  });

  test('walk imports from apply-llm-edits.ts', async () => {
    const rootDir = path.dirname((await packageUp())!);
    const walker = new ImportWalker(new Extractor(), await Resolver.new(rootDir));

    const imports = await walker.getDefiningFiles(
      path.join(rootDir, 'src/apply-llm-edits/apply.ts')
    );
    const relativeImports = imports
      .values()
      .map((f) => path.relative(rootDir, f))
      .toArray()
      .sort();
    expect(relativeImports).toMatchSnapshot();
  });
});

describe('findImporters', () => {
  let tempImporterTestDir: string;

  async function setupImporterTestStructure(): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'importer-test-'));

    // pkg-a
    await fs.mkdir(path.join(tempDir, 'pkg-a'));
    await Bun.write(
      path.join(tempDir, 'pkg-a', 'package.json'),
      JSON.stringify({ name: 'pkg-a', version: '1.0.0' })
    );
    await Bun.write(
      path.join(tempDir, 'pkg-a', 'importer.ts'),
      `
    import { util } from './utils'; // Relative import
    import { feature } from 'pkg-b/feature'; // Package import via export map
    import { helper } from 'pkg-b/utils/helper'; // Wildcard export
    import { anotherUtil } from "./anotherDir/anotherUtil";

    console.log(util(), feature(), helper(), anotherUtil());
  `
    );
    await Bun.write(path.join(tempDir, 'pkg-a', 'utils.ts'), `export const util = () => 'util';`);
    await fs.mkdir(path.join(tempDir, 'pkg-a', 'anotherDir'));
    await Bun.write(
      path.join(tempDir, 'pkg-a', 'anotherDir', 'anotherUtil.ts'),
      `export const anotherUtil = () => 'another util';`
    );

    // pkg-b
    await fs.mkdir(path.join(tempDir, 'pkg-b'));
    await Bun.write(
      path.join(tempDir, 'pkg-b', 'package.json'),
      JSON.stringify({
        name: 'pkg-b',
        version: '1.0.0',
        exports: {
          '.': './main.ts', // Export for pkg-b itself
          './feature': './src/feature.ts', // Export for pkg-b/feature
          './utils/*': './src/utils/*.ts', // Wildcard export
        },
      })
    );
    await fs.mkdir(path.join(tempDir, 'pkg-b', 'src', 'utils'), {
      recursive: true,
    });
    await Bun.write(
      path.join(tempDir, 'pkg-b', 'src', 'utils', 'helper.ts'),
      `export const helper = () => 'helper';`
    );
    await Bun.write(
      path.join(tempDir, 'pkg-b', 'main.ts'),
      `export const mainFunc = () => 'main from b';`
    );
    await Bun.write(
      path.join(tempDir, 'pkg-b', 'src', 'feature.ts'),
      `export const feature = () => 'feature';`
    );
    // A file in pkg-b that imports its own feature.ts
    await Bun.write(
      path.join(tempDir, 'pkg-b', 'internal-consumer.ts'),
      `
    import { feature } from './src/feature'; // Direct relative import
    console.log(feature());
  `
    );

    // pkg-c (imports from pkg-b root)
    await fs.mkdir(path.join(tempDir, 'pkg-c'));
    await Bun.write(
      path.join(tempDir, 'pkg-c', 'package.json'),
      JSON.stringify({ name: 'pkg-c', version: '1.0.0' })
    );
    await Bun.write(
      path.join(tempDir, 'pkg-c', 'consumer.ts'),
      `
    import { mainFunc } from 'pkg-b';
    console.log(mainFunc());
  `
    );

    // pnpm-workspace.yaml
    await Bun.write(path.join(tempDir, 'pnpm-workspace.yaml'), "packages:\n  - '*'");

    return tempDir;
  }

  beforeAll(async () => {
    tempImporterTestDir = await setupImporterTestStructure();
  });

  afterAll(async () => {
    if (tempImporterTestDir) {
      await fs.rm(tempImporterTestDir, { recursive: true, force: true });
    }
  });

  test('findImporters for a local file (pkg-a/utils.ts)', async () => {
    const walker = new ImportWalker(new Extractor(), await Resolver.new(tempImporterTestDir));
    const targetFile = path.join(tempImporterTestDir, 'pkg-a', 'utils.ts');
    const importers = await walker.findImporters(targetFile);

    const relativeImporters = Array.from(importers)
      .map((f) => path.relative(tempImporterTestDir, f))
      .sort();
    expect(relativeImporters).toEqual([path.join('pkg-a', 'importer.ts')]);
  });

  test('findImporters for a local file in a subdirectory (pkg-a/anotherDir/anotherUtil.ts)', async () => {
    const walker = new ImportWalker(new Extractor(), await Resolver.new(tempImporterTestDir));
    const targetFile = path.join(tempImporterTestDir, 'pkg-a', 'anotherDir', 'anotherUtil.ts');
    const importers = await walker.findImporters(targetFile);

    const relativeImporters = Array.from(importers)
      .map((f) => path.relative(tempImporterTestDir, f))
      .sort();
    expect(relativeImporters).toEqual([path.join('pkg-a', 'importer.ts')]);
  });

  test('findImporters for an exported file in another package (pkg-b/src/feature.ts)', async () => {
    const walker = new ImportWalker(new Extractor(), await Resolver.new(tempImporterTestDir));
    // Target is the actual source file path
    const targetFile = path.join(tempImporterTestDir, 'pkg-b', 'src', 'feature.ts');
    const importers = await walker.findImporters(targetFile);

    const relativeImporters = Array.from(importers)
      .map((f) => path.relative(tempImporterTestDir, f))
      .sort();
    expect(relativeImporters).toEqual(
      [
        path.join('pkg-a', 'importer.ts'), // Imports 'pkg-b/feature'
        path.join('pkg-b', 'internal-consumer.ts'), // Imports './src/feature'
      ].sort()
    );
  });

  test('findImporters for a wildcard exported file (pkg-b/src/utils/helper.ts)', async () => {
    const walker = new ImportWalker(new Extractor(), await Resolver.new(tempImporterTestDir));
    const targetFile = path.join(tempImporterTestDir, 'pkg-b', 'src', 'utils', 'helper.ts');
    const importers = await walker.findImporters(targetFile);

    const relativeImporters = Array.from(importers)
      .map((f) => path.relative(tempImporterTestDir, f))
      .sort();
    expect(relativeImporters).toEqual([path.join('pkg-a', 'importer.ts')].sort());
  });

  test('findImporters for a package root export (pkg-b/main.ts)', async () => {
    const walker = new ImportWalker(new Extractor(), await Resolver.new(tempImporterTestDir));
    const targetFile = path.join(tempImporterTestDir, 'pkg-b', 'main.ts');
    const importers = await walker.findImporters(targetFile);

    const relativeImporters = Array.from(importers)
      .map((f) => path.relative(tempImporterTestDir, f))
      .sort();
    expect(relativeImporters).toEqual(
      [
        path.join('pkg-c', 'consumer.ts'), // Imports 'pkg-b'
      ].sort()
    );
  });

  test('findImporters for a reexported file (pkg-b/src/utils/helper.ts reexported)', async () => {
    // Create a reexport file in pkg-b
    await Bun.write(
      path.join(tempImporterTestDir, 'pkg-b', 'src', 'utils', 'reexport.ts'),
      `export { helper } from './helper';`
    );
    // Create a file in pkg-c that imports the reexport
    await Bun.write(
      path.join(tempImporterTestDir, 'pkg-c', 'reexport-consumer.ts'),
      `
    import { helper } from 'pkg-b/utils/reexport';
    console.log(helper());
  `
    );

    const walker = new ImportWalker(new Extractor(), await Resolver.new(tempImporterTestDir));
    const targetFile = path.join(tempImporterTestDir, 'pkg-b', 'src', 'utils', 'helper.ts');
    const importers = await walker.findImporters(targetFile);

    const relativeImporters = Array.from(importers)
      .map((f) => path.relative(tempImporterTestDir, f))
      .sort();
    expect(relativeImporters).toEqual(
      [
        path.join('pkg-a', 'importer.ts'), // Direct import
        path.join('pkg-c', 'reexport-consumer.ts'), // Via reexport
      ].sort()
    );
  });

  test('findImporters for a file with no importers', async () => {
    const lonelyFilePath = path.join(tempImporterTestDir, 'pkg-a', 'lonely.ts');
    await Bun.write(lonelyFilePath, 'export const lonely = true;');

    const walker = new ImportWalker(new Extractor(), await Resolver.new(tempImporterTestDir));
    const importers = await walker.findImporters(lonelyFilePath);

    expect(Array.from(importers)).toEqual([]);
  });
});
