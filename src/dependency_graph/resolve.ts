import * as fs from 'fs/promises';
import * as path from 'path';
import { resolve as resolveExports } from 'resolve.exports';
import { packageUp } from 'package-up';

type MaybeAwaited<T extends Promise<any>> = Awaited<T> | T;

async function cachePromise<T extends Promise<any>>(
  cache: Map<string, MaybeAwaited<T>>,
  key: string,
  fn: () => T
): Promise<T> {
  if (cache.has(key)) {
    return cache.get(key)!;
  }

  let p = cache.get(key);
  if (p) return p;
  let result = await fn();
  cache.set(key, result);
  return result;
}

type FnCache<T extends (...args: any[]) => any> = Map<string, MaybeAwaited<ReturnType<T>>>;

export class Resolver {
  cachedImportPath: FnCache<typeof this.internalResolveImportPaths> = new Map();
  cachedRelativeImport: FnCache<typeof this.internalResolveRelativeImport> = new Map();
  cachedPackageImport: FnCache<typeof this.internalResolvePackageImport> = new Map();
  cachedPnpmWorkspace: FnCache<typeof this.internalResolvePnpmWorkspace> = new Map();

  /**
   * Resolves import paths for a TypeScript file
   * @param filePath Path to the TypeScript file
   * @param imports Array of import specifiers from the file
   * @returns Map of import specifiers to resolved file paths
   */
  async resolveImportPaths(filePath: string, imports: string[]): Promise<Map<string, string>> {
    return cachePromise(this.cachedImportPath, filePath, () =>
      this.internalResolveImportPaths(filePath, imports)
    );
  }

  private async internalResolveImportPaths(
    filePath: string,
    imports: string[]
  ): Promise<Map<string, string>> {
    if (this.cachedImportPath.has(filePath)) {
      return this.cachedImportPath.get(filePath)!;
    }

    const resolvedPaths = new Map<string, string>();
    const baseDir = path.dirname(filePath);

    for (const importSpecifier of imports) {
      try {
        // Skip built-in Node.js modules
        if (importSpecifier.startsWith('node:')) {
          resolvedPaths.set(importSpecifier, '[built-in]');
          continue;
        }

        // Handle relative imports
        if (importSpecifier.startsWith('.') || importSpecifier.startsWith('/')) {
          const resolvedPath = await this.resolveRelativeImport(baseDir, importSpecifier);
          resolvedPaths.set(importSpecifier, resolvedPath);
          continue;
        }

        // Handle package imports
        const resolvedPath = await this.resolvePackageImport(baseDir, importSpecifier);
        resolvedPaths.set(importSpecifier, resolvedPath);
      } catch (error) {
        resolvedPaths.set(importSpecifier, `Error: ${(error as Error).message}`);
      }
    }

    this.cachedImportPath.set(filePath, resolvedPaths);
    return resolvedPaths;
  }

  /**
   * Resolves relative imports
   */
  async resolveRelativeImport(baseDir: string, importSpecifier: string): Promise<string> {
    return cachePromise(this.cachedRelativeImport, importSpecifier, () =>
      this.internalResolveRelativeImport(baseDir, importSpecifier)
    );
  }

  private async internalResolveRelativeImport(
    baseDir: string,
    importSpecifier: string
  ): Promise<string> {
    let resolvedPath = path.resolve(baseDir, importSpecifier);
    const extensions = ['.ts', '.tsx', '.js', '.jsx'];

    // Check if it's a directory with an index file
    if (
      await Bun.file(resolvedPath)
        .stat()
        .then((stats) => stats.isDirectory())
        .catch(() => false)
    ) {
      for (const ext of extensions) {
        const indexPath = path.join(resolvedPath, `index${ext}`);
        if (await Bun.file(indexPath).exists()) {
          return indexPath;
        }
      }
    }

    // Check with extensions
    for (const ext of extensions) {
      const pathWithExt = resolvedPath + ext;
      if (await Bun.file(pathWithExt).exists()) {
        return pathWithExt;
      }
    }

    throw new Error(`Cannot resolve relative import: ${importSpecifier}`);
  }

  /**
   * Resolves package imports including export maps and pnpm workspaces
   */
  async resolvePackageImport(baseDir: string, importSpecifier: string): Promise<string> {
    return cachePromise(this.cachedPackageImport, importSpecifier, () =>
      this.internalResolvePackageImport(baseDir, importSpecifier)
    );
  }

  private async internalResolvePackageImport(
    baseDir: string,
    importSpecifier: string
  ): Promise<string> {
    const packageJsonPath = await packageUp({ cwd: baseDir });
    if (!packageJsonPath) {
      throw new Error('No package.json found in project');
    }

    const packageJsonDir = path.dirname(packageJsonPath);
    const packageData = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

    // Check export maps using resolve.exports
    if (packageData.exports) {
      const resolvedExport = resolveExports(packageData, importSpecifier, {
        conditions: ['import', 'require', 'node', 'default'],
        unsafe: true, // Allow falling back to main/module fields
      });

      if (resolvedExport) {
        const exportPath = Array.isArray(resolvedExport) ? resolvedExport[0] : resolvedExport;
        return path.resolve(packageJsonDir, exportPath);
      }
    }

    // Check pnpm workspace
    const workspacePath = await this.resolvePnpmWorkspace(
      packageJsonDir,
      packageData,
      importSpecifier
    );
    if (workspacePath) return workspacePath;

    // Fallback to node_modules
    const nodeModulesPath = path.join(packageJsonDir, 'node_modules', importSpecifier);
    const pkgJsonPath = path.join(nodeModulesPath, 'package.json');

    try {
      const pkgData = await Bun.file(pkgJsonPath).json();
      const resolvedExport = resolveExports(pkgData, '.', {
        conditions: ['import', 'require', 'node', 'default'],
        unsafe: true,
      });
      const mainFile = resolvedExport || pkgData.module || pkgData.main || 'index.js';
      return path.join(nodeModulesPath, Array.isArray(mainFile) ? mainFile[0] : mainFile);
    } catch {
      throw new Error(`Cannot resolve package: ${importSpecifier}`);
    }
  }

  /**
   * Resolves pnpm workspace packages
   */
  async resolvePnpmWorkspace(
    baseDir: string,
    packageData: any,
    importSpecifier: string
  ): Promise<string | null> {
    return cachePromise(this.cachedPnpmWorkspace, importSpecifier, () =>
      this.internalResolvePnpmWorkspace(baseDir, packageData, importSpecifier)
    );
  }

  private async internalResolvePnpmWorkspace(
    baseDir: string,
    packageData: any,
    importSpecifier: string
  ): Promise<string | null> {
    if (!packageData.workspaces) return null;

    const workspacePatterns = packageData.workspaces;
    for (const pattern of workspacePatterns) {
      const workspaceDir = path.join(baseDir, pattern.replace('/*', ''));
      const packages = await fs.readdir(workspaceDir).catch(() => []);

      for (const pkg of packages) {
        const pkgJsonPath = path.join(workspaceDir, pkg, 'package.json');
        try {
          const pkgData = await Bun.file(pkgJsonPath).json();
          if (pkgData.name === importSpecifier) {
            const resolvedExport = resolveExports(pkgData, '.', {
              conditions: ['import', 'require', 'node', 'default'],
              unsafe: true,
            });
            const mainFile = resolvedExport || pkgData.module || pkgData.main || 'index.js';
            return path.join(workspaceDir, pkg, Array.isArray(mainFile) ? mainFile[0] : mainFile);
          }
        } catch {
          continue;
        }
      }
    }
    return null;
  }
}
