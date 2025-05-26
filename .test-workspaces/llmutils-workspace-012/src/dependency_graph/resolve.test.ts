import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Resolver } from './resolve';

async function setupMockStructure(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolver-test-'));

  // Create src directory
  await fs.mkdir(path.join(tempDir, 'src'));
  await Bun.write(path.join(tempDir, 'src', 'main.ts'), '// main.ts');
  await fs.mkdir(path.join(tempDir, 'src', 'utils'));
  await Bun.write(path.join(tempDir, 'src', 'utils', 'index.ts'), '// utils/index.ts');

  // Create node_modules
  await fs.mkdir(path.join(tempDir, 'node_modules'));
  await fs.mkdir(path.join(tempDir, 'node_modules', 'pkg1'));
  await Bun.write(
    path.join(tempDir, 'node_modules', 'pkg1', 'package.json'),
    JSON.stringify({ main: 'index.js' })
  );
  await Bun.write(path.join(tempDir, 'node_modules', 'pkg1', 'index.js'), '// pkg1/index.js');

  await fs.mkdir(path.join(tempDir, 'node_modules', 'pkg2'));
  await Bun.write(
    path.join(tempDir, 'node_modules', 'pkg2', 'package.json'),
    JSON.stringify({ main: 'lib/main.js' })
  );
  await fs.mkdir(path.join(tempDir, 'node_modules', 'pkg2', 'lib'));
  await Bun.write(
    path.join(tempDir, 'node_modules', 'pkg2', 'lib', 'main.js'),
    '// pkg2/lib/main.js'
  );

  // Create packages for workspace
  await fs.mkdir(path.join(tempDir, 'packages'));
  await fs.mkdir(path.join(tempDir, 'packages', 'workspace-pkg'));
  await Bun.write(
    path.join(tempDir, 'packages', 'workspace-pkg', 'package.json'),
    JSON.stringify({
      name: '@repo/workspace-pkg',
      main: 'index.ts',
      exports: {
        '.': './index.ts',
        './utils': './utils/index.ts',
      },
    })
  );
  await Bun.write(
    path.join(tempDir, 'packages', 'workspace-pkg', 'index.ts'),
    '// workspace-pkg/index.ts'
  );

  // Create pnpm-workspace.yaml instead of package.json with workspaces
  await Bun.write(path.join(tempDir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'");

  // Create root package.json (without workspaces)
  await Bun.write(
    path.join(tempDir, 'package.json'),
    JSON.stringify({
      name: 'root-pkg',
      dependencies: {
        '@repo/workspace-pkg': 'workspace:*',
      },
    })
  );

  return tempDir;
}

let tempDir: string;

beforeAll(async () => {
  tempDir = await setupMockStructure();
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('Resolver', () => {
  test('resolves relative import to file', async () => {
    const resolver = await Resolver.new(tempDir);
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['./main'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved[0]).toEqual({
      importPath: './main',
      resolved: path.join(tempDir, 'src', 'main.ts'),
    });
  });

  test('resolves relative import to directory with index', async () => {
    const resolver = await Resolver.new(tempDir);
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['./utils'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved[0]).toEqual({
      importPath: './utils',
      resolved: path.join(tempDir, 'src', 'utils', 'index.ts'),
    });
  });

  test('resolves package import from node_modules', async () => {
    const resolver = await Resolver.new(tempDir);
    resolver.resolveNodeModules = true;
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['pkg1'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved[0]).toEqual({
      importPath: 'pkg1',
      resolved: path.join(tempDir, 'node_modules', 'pkg1', 'index.js'),
    });
  });

  test('resolves package import with main field', async () => {
    const resolver = await Resolver.new(tempDir);
    resolver.resolveNodeModules = true;
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['pkg2'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved[0]).toEqual({
      importPath: 'pkg2',
      resolved: path.join(tempDir, 'node_modules', 'pkg2', 'lib', 'main.js'),
    });
  });

  test('resolves workspace package import', async () => {
    const resolver = await Resolver.new(tempDir);
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['@repo/workspace-pkg'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved[0]).toEqual({
      importPath: '@repo/workspace-pkg',
      resolved: path.join(tempDir, 'packages', 'workspace-pkg', 'index.ts'),
    });
  });

  test('resolves package import with export map', async () => {
    const resolver = await Resolver.new(tempDir);
    resolver.resolveNodeModules = true;
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['@repo/workspace-pkg/utils'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved[0]).toEqual({
      importPath: '@repo/workspace-pkg/utils',
      resolved: path.join(tempDir, 'packages', 'workspace-pkg', 'utils', 'index.ts'),
    });
  });

  test('skips built-in modules', async () => {
    const resolver = await Resolver.new(tempDir);
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['node:fs'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved[0]).toEqual({
      importPath: 'node:fs',
      resolved: null,
    });
  });

  test('handles non-existent relative import', async () => {
    const resolver = await Resolver.new(tempDir);
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['./non-existent'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved[0]).toEqual({
      importPath: './non-existent',
      resolved: null,
    });
  });

  test('handles non-existent package import', async () => {
    const resolver = await Resolver.new(tempDir);
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['non-existent-pkg'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved[0]).toEqual({
      importPath: 'non-existent-pkg',
      resolved: null,
    });
  });
});
