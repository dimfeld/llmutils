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
    JSON.stringify({ name: 'workspace-pkg', main: 'index.ts' })
  );
  await Bun.write(
    path.join(tempDir, 'packages', 'workspace-pkg', 'index.ts'),
    '// workspace-pkg/index.ts'
  );

  // Create pnpm-workspace.yaml instead of package.json with workspaces
  await Bun.write(path.join(tempDir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'");

  // Create root package.json (without workspaces)
  await Bun.write(path.join(tempDir, 'package.json'), JSON.stringify({}));

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
    const resolver = new Resolver();
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['./main'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved.get('./main')).toBe(path.join(tempDir, 'src', 'main.ts'));
  });

  test('resolves relative import to directory with index', async () => {
    const resolver = new Resolver();
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['./utils'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved.get('./utils')).toBe(path.join(tempDir, 'src', 'utils', 'index.ts'));
  });

  test('resolves package import from node_modules', async () => {
    const resolver = new Resolver();
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['pkg1'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved.get('pkg1')).toBe(path.join(tempDir, 'node_modules', 'pkg1', 'index.js'));
  });

  test('resolves package import with main field', async () => {
    const resolver = new Resolver();
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['pkg2'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved.get('pkg2')).toBe(path.join(tempDir, 'node_modules', 'pkg2', 'lib', 'main.js'));
  });

  test('resolves workspace package import', async () => {
    const resolver = new Resolver();
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['workspace-pkg'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved.get('workspace-pkg')).toBe(
      path.join(tempDir, 'packages', 'workspace-pkg', 'index.ts')
    );
  });

  test('skips built-in modules', async () => {
    const resolver = new Resolver();
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['node:fs'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved.get('node:fs')).toBe('[built-in]');
  });

  test('handles non-existent relative import', async () => {
    const resolver = new Resolver();
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['./non-existent'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved.get('./non-existent')).toMatch(/^Error: /);
  });

  test('handles non-existent package import', async () => {
    const resolver = new Resolver();
    const filePath = path.join(tempDir, 'src', 'main.ts');
    const imports = ['non-existent-pkg'];
    const resolved = await resolver.resolveImportPaths(filePath, imports);
    expect(resolved.get('non-existent-pkg')).toMatch(/^Error: /);
  });
});
