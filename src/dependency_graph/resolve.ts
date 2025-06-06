import * as fs from 'fs/promises';
import * as path from 'path';
import * as YAML from 'js-yaml';
import {
  resolve as resolveExports,
  legacy as resolveLegacy,
  type Package as PackageJson,
} from 'resolve.exports';
import { packageUp } from 'package-up';
import { findUp } from 'find-up';
import { cachePromise, type FnCache } from '../common/process.ts';
import { importCandidates, jsExtensions } from './filenames.ts';

export interface Package {
  name: string;
  path: string;
  packageJson: PackageJson;
  type: 'builtin' | 'dependency' | 'workspace';
}

export class Resolver {
  cachedImportPath: FnCache<typeof this.internalResolveImportPaths> = new Map();
  cachedRelativeImport: FnCache<typeof this.internalResolveRelativeImport> = new Map();
  cachedPackageImport: FnCache<typeof this.internalResolvePackageImport> = new Map();
  packageFromDir: FnCache<() => Promise<Package>> = new Map();

  packages: Map<string, Package> = new Map();
  pnpmWorkspacePath: string | undefined;
  resolveNodeModules = false;

  constructor(packages: Map<string, Package>) {
    this.packages = packages;
  }

  static async new(baseDir: string = process.cwd()) {
    let workspace = await Resolver.resolvePnpmWorkspace(baseDir);
    const resolver = new Resolver(workspace?.packages ?? new Map());
    resolver.pnpmWorkspacePath = workspace?.path;
    return resolver;
  }

  /**
   * Resolves import paths for a TypeScript file
   * @param filePath Path to the TypeScript file
   * @param imports Array of import specifiers from the file
   * @returns Map of import specifiers to resolved file paths
   */
  async resolveImportPaths(
    filePath: string,
    imports: string[]
  ): Promise<{ importPath: string; resolved: string | null }[]> {
    let baseDir = path.dirname(filePath);
    return Promise.all(
      imports.map((importPath) =>
        cachePromise(this.cachedImportPath, `${baseDir}:${importPath}`, async () => {
          let result = await this.internalResolveImportPaths(baseDir, importPath);
          if (result.resolved) {
            let tryPaths = [result.resolved.replace('/dist/', '/src/')];

            if (path.extname(tryPaths[0]) === '.js') {
              tryPaths.push(tryPaths[0].slice(0, -3) + '.ts');
            }

            let exists = await Promise.all(
              tryPaths.map(async (tryPath) => {
                try {
                  let exists = await Bun.file(tryPath).exists();
                  return exists ? tryPath : undefined;
                } catch {
                  return undefined;
                }
              })
            );

            result.resolved = exists.find((e) => e != null) ?? result.resolved;
          }

          return result;
        })
      )
    );
  }

  private async internalResolveImportPaths(
    baseDir: string,
    importSpecifier: string
  ): Promise<{ importPath: string; resolved: string | null }> {
    // Skip built-in Node.js modules
    if (importSpecifier.startsWith('node:')) {
      return { importPath: importSpecifier, resolved: null };
    }

    if (importSpecifier.startsWith('$lib/')) {
      let packagePath = await this.resolvePackageJson(baseDir);
      importSpecifier = path.join(packagePath.path, 'src', 'lib', importSpecifier.slice(5));
    }

    // Handle relative imports
    if (importSpecifier.startsWith('.') || importSpecifier.startsWith('/')) {
      const resolvedPath = await this.resolveRelativeImport(baseDir, importSpecifier);
      return { importPath: importSpecifier, resolved: resolvedPath };
    }

    // Handle package imports
    const resolvedPath = await this.resolvePackageImport(baseDir, importSpecifier);
    return { importPath: importSpecifier, resolved: resolvedPath };
  }

  /**
   * Resolves relative imports
   */
  async resolveRelativeImport(baseDir: string, importSpecifier: string): Promise<string | null> {
    return cachePromise(this.cachedRelativeImport, importSpecifier, () =>
      this.internalResolveRelativeImport(baseDir, importSpecifier)
    );
  }

  private async internalResolveRelativeImport(
    baseDir: string,
    importSpecifier: string
  ): Promise<string | null> {
    let resolvedPath = path.resolve(baseDir, importSpecifier);

    // Check if it's a directory with an index file
    if (
      await Bun.file(resolvedPath)
        .stat()
        .then((stats) => stats.isDirectory())
        .catch(() => false)
    ) {
      for (const ext of jsExtensions) {
        const indexPath = path.join(resolvedPath, `index${ext}`);
        if (await Bun.file(indexPath).exists()) {
          return indexPath;
        }
      }
    }

    // Check with extensions
    const candidates = importCandidates(resolvedPath);
    let exists = await Promise.all(
      candidates.map((candidate) =>
        Bun.file(candidate)
          .exists()
          .then((e) => (e ? candidate : undefined))
          .catch(() => undefined)
      )
    );

    return exists.find((candidate) => candidate != null) ?? null;
  }

  /**
   * Resolves package imports including export maps and pnpm workspaces
   */
  async resolvePackageImport(baseDir: string, importSpecifier: string): Promise<string | null> {
    return cachePromise(this.cachedPackageImport, `${baseDir}:${importSpecifier}`, () =>
      this.internalResolvePackageImport(baseDir, importSpecifier)
    );
  }

  private async internalResolvePackageImport(
    baseDir: string,
    importSpecifier: string
  ): Promise<string | null> {
    const thisPkg = await this.resolvePackageJson(baseDir);

    // See if we know about this package.
    // The package path could be a single name or it could be something like
    // @repo/package-name.
    const slashComponents = importSpecifier.split('/');
    let pkg: Package | undefined;
    for (let i = 0; i < slashComponents.length; i++) {
      const potentialPackageName = slashComponents.slice(0, i + 1).join('/');
      pkg = this.packages.get(potentialPackageName);
      if (pkg) {
        break;
      }
    }

    let subpathIndex = -1;
    if (pkg) {
      // namespace/name/subpath
      subpathIndex = pkg.name.length;
    } else {
      // This isn't totally right since node_modules dependencies can have slashes
      // in their names too.
      subpathIndex = importSpecifier.indexOf('/');
    }

    let depName = subpathIndex > 0 ? importSpecifier.substring(0, subpathIndex) : importSpecifier;
    let depSubpath = subpathIndex > 0 ? importSpecifier.slice(subpathIndex + 1) : '';

    if (!pkg && this.resolveNodeModules) {
      const nodeModulesPath = path.join(thisPkg.path, 'node_modules', depName);
      const pkgJsonPath = path.join(nodeModulesPath, 'package.json');
      const pkgData = await Bun.file(pkgJsonPath).json();
      pkg = { name: depName, path: nodeModulesPath, packageJson: pkgData, type: 'builtin' };
    }

    if (!pkg) {
      return null;
    }

    // Check export maps using resolve.exports
    if (pkg.packageJson.exports) {
      try {
        const resolvedExport = resolveExports(pkg.packageJson, depSubpath || '.', {
          conditions: ['import', 'require', 'node', 'default'],
          unsafe: true, // Allow falling back to main/module fields
        });

        if (resolvedExport) {
          const exportPath = Array.isArray(resolvedExport) ? resolvedExport[0] : resolvedExport;
          return path.resolve(pkg.path, exportPath);
        }
      } catch (e) {
        // resolve.exports will throw on invalid paths, we can ignore it
      }
    } else if (depSubpath) {
      return path.join(pkg.path, depSubpath);
    }

    const subpath =
      resolveLegacy(pkg.packageJson, {
        browser: false,
      }) || '';
    return path.join(pkg.path, subpath);
  }

  /** Find the package.json for a directory */
  async resolvePackageJson(dir: string): Promise<Package> {
    return cachePromise(this.packageFromDir, dir, async () => {
      const packageJsonPath = await packageUp({ cwd: dir });
      if (!packageJsonPath) {
        throw new Error('No package.json found in project');
      }

      const packageJson = await Bun.file(packageJsonPath).json();
      return {
        name: packageJson.name,
        path: path.dirname(packageJsonPath),
        packageJson,
        type: 'workspace',
      } satisfies Package;
    });
  }

  /**
   * Resolves pnpm workspace packages
   */
  private static async resolvePnpmWorkspace(baseDir: string): Promise<{
    packages: Map<string, Package>;
    path: string;
  } | null> {
    const pnpmWorkspaceYamlPath = await findUp('pnpm-workspace.yaml', {
      cwd: baseDir,
    });

    if (!pnpmWorkspaceYamlPath) return null;

    const content = await Bun.file(pnpmWorkspaceYamlPath).text();
    const workspacePatterns: string[] = (YAML.load(content) as any)?.packages;
    if (workspacePatterns?.length === 0) return null;

    const packageMap = new Map<string, Package>();
    const workspaceRoot = path.dirname(pnpmWorkspaceYamlPath);
    for (const pattern of workspacePatterns) {
      const workspaceDir = path.join(workspaceRoot, pattern.replace('*', ''));
      const packages = await fs.readdir(workspaceDir).catch(() => []);
      for (const pkg of packages) {
        const pkgJsonPath = path.join(workspaceDir, pkg, 'package.json');
        try {
          const pkgData = await Bun.file(pkgJsonPath).json();

          packageMap.set(pkgData.name, {
            name: pkgData.name,
            path: path.join(workspaceDir, pkg),
            packageJson: pkgData,
            type: 'workspace',
          });
        } catch {
          continue;
        }
      }
    }

    return { packages: packageMap, path: pnpmWorkspaceYamlPath };
  }
}
