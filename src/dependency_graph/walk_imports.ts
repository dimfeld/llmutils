import {
  extractExportedVariables,
  extractExportedFunctions,
  extractExportedClasses,
  extractImportsExportModules,
  extractExportedInterfaces,
  extractExportedTypeAliases,
  Extractor,
} from '../treesitter/extract.js';
import { Resolver, type Package } from './resolve.js';
import * as path from 'path';
import { error, debugLog } from '../logging.js';
import { grepFor } from '../common/file_finder.js';
import { importCandidates } from './filenames.js';

interface FileInfo {
  imports: { module: string; namedImports?: { name: string; alias?: string }[] }[];
  reexports: { module: string; namedExports?: { name: string; alias?: string }[] }[];
  exportedNames: Set<string>;
}

export class ImportWalker {
  private extractor: Extractor;
  resolver: Resolver;
  private fileInfoCache: Map<string, FileInfo> = new Map();

  constructor(extractor: Extractor, resolver: Resolver) {
    this.extractor = extractor;
    this.resolver = resolver;
  }

  private async getFileInfo(filePath: string): Promise<FileInfo | null> {
    if (this.fileInfoCache.has(filePath)) {
      return this.fileInfoCache.get(filePath)!;
    }

    try {
      const code = await Bun.file(filePath).text();
      const language = path.extname(filePath) === '.svelte' ? 'svelte' : 'typescript';
      const parser = await this.extractor.createParser(language);
      let tree = parser.parse(code);
      if (!tree) {
        return null;
      }

      if (language === 'svelte') {
        let svelteTree = await this.extractor.getSvelteScript(tree);
        tree.delete();
        if (!svelteTree) {
          return null;
        }
        tree = svelteTree;
      }

      try {
        const { imports, reexports } = extractImportsExportModules(tree);
        const exportedNames = new Set<string>();

        // TODO replace all these with a single treesitter query and/or combine with extractImportsExportModules
        const variables = extractExportedVariables(tree);
        for (const v of variables) {
          exportedNames.add(v.name);
        }

        const functions = extractExportedFunctions(tree);
        for (const f of functions) {
          exportedNames.add(f.name);
        }

        const classes = extractExportedClasses(tree);
        for (const c of classes) {
          exportedNames.add(c.name);
        }

        const interfaces = extractExportedInterfaces(tree);
        for (const i of interfaces) {
          exportedNames.add(i.name);
        }

        const typeAliases = extractExportedTypeAliases(tree);
        for (const t of typeAliases) {
          exportedNames.add(t.name);
        }

        const fileInfo: FileInfo = {
          imports,
          reexports,
          exportedNames,
        };

        this.fileInfoCache.set(filePath, fileInfo);
        return fileInfo;
      } finally {
        tree.delete();
      }
    } catch (e) {
      error(`Error parsing file ${filePath}:`, e);
      return null;
    }
  }

  private async findDefiningFile(
    variableName: string,
    modulePath: string,
    visited: Set<string> = new Set()
  ): Promise<string | null> {
    if (visited.has(modulePath)) {
      return null; // Cycle detected
    }
    visited.add(modulePath);

    const fileInfo = await this.getFileInfo(modulePath);
    if (!fileInfo) {
      return null;
    }

    if (fileInfo.exportedNames.has(variableName)) {
      return modulePath;
    }

    for (const reexport of fileInfo.reexports) {
      if (reexport.namedExports) {
        for (const exp of reexport.namedExports) {
          if (exp.alias === variableName || (!exp.alias && exp.name === variableName)) {
            const originalName = exp.name;
            const resolved = await this.resolver.resolveImportPaths(modulePath, [reexport.module]);
            if (resolved[0].resolved) {
              const definingFile = await this.findDefiningFile(
                originalName,
                resolved[0].resolved,
                visited
              );
              if (definingFile) {
                return definingFile;
              }
            }
          }
        }
      } else {
        // `export * from 'another'`
        const resolved = await this.resolver.resolveImportPaths(modulePath, [reexport.module]);
        if (resolved[0].resolved) {
          const definingFile = await this.findDefiningFile(
            variableName,
            resolved[0].resolved,
            visited
          );
          if (definingFile) {
            return definingFile;
          }
        }
      }
    }

    return null;
  }

  /** For each import in the file, resolve the path it actually references. */
  async resolveImports(filePath: string) {
    const fileInfo = await this.getFileInfo(filePath);
    if (!fileInfo) {
      return;
    }

    const resolved = await this.resolver.resolveImportPaths(
      filePath,
      fileInfo.imports.map((i) => i.module)
    );

    return {
      fileInfo,
      resolved,
    };
  }

  /** For each import in the file, find the file it is defined in, following reexports as needed */
  async getDefiningFiles(filePath: string): Promise<Set<string>> {
    const result = await this.resolveImports(filePath);
    const definingFiles = new Set<string>();

    if (!result?.resolved.length) {
      return definingFiles;
    }

    const { fileInfo, resolved: allResolved } = result;
    for (let i = 0; i < allResolved.length; i++) {
      let resolved = allResolved[i];
      if (!resolved.resolved) {
        continue;
      }
      let imp = fileInfo.imports[i];

      const modulePath = resolved.resolved;

      if (imp.namedImports) {
        for (const namedImport of imp.namedImports || []) {
          const variableName = namedImport.name;
          const definingFile = await this.findDefiningFile(variableName, modulePath);
          if (definingFile) {
            definingFiles.add(definingFile);
          }
        }
      } else {
        definingFiles.add(modulePath);
      }
    }

    return definingFiles;
  }

  /** Get the import tree of a file and all the files it imports. If processing multiple files at once,
   * you can define `seen` yourself and pass it in to avoid duplicate work. */
  async getImportTree(filePath: string, seen: Set<string> = new Set()): Promise<Set<string>> {
    if (seen.has(filePath)) {
      return seen;
    }

    let fileInfo = await this.getFileInfo(filePath);
    if (!fileInfo) {
      return seen;
    }

    seen.add(filePath);

    let resolved = await this.resolver.resolveImportPaths(filePath, [
      ...fileInfo.imports.map((imp) => imp.module),
      ...fileInfo.reexports.map((reexport) => reexport.module),
    ]);

    let modulePaths = resolved.map((r) => r.resolved).filter((r) => r != null);

    await Promise.all(modulePaths.map((modulePath) => this.getImportTree(modulePath, seen)));

    return seen;
  }

  /**
   * Heuristic check if two file paths could refer to the same module,
   * considering common src/dist patterns and extensions.
   */
  private _arePathsEquivalent(path1: string, path2: string): boolean {
    const p1_abs = path.resolve(path1);
    const p2_abs = path.resolve(path2);

    if (p1_abs === p2_abs) return true;

    const normalize = (p: string) => {
      let noExt = p.replace(/\.(ts|tsx|js|jsx|mjs|mts|svelte)$/, '');
      // Order matters: general /lib/ or /dist/ before specific /src/
      if (noExt.includes('/dist/')) noExt = noExt.replace('/dist/', '/src/');
      else if (noExt.includes('/lib/')) noExt = noExt.replace('/lib/', '/src/');
      // if it was already /src/, it remains /src/
      return noExt;
    };

    const norm_p1 = normalize(p1_abs);
    const norm_p2 = normalize(p2_abs);

    if (norm_p1 === norm_p2) return true;

    // Check if one is src and other is original (e.g. if original didn't have dist/lib)
    // This handles cases where one path is already 'src' and the other is its 'dist' equivalent
    // or vice-versa without explicit src/dist in the path string itself.
    if (norm_p1.replace('/src/', '/') === norm_p2.replace('/src/', '/')) return true;

    return false;
  }

  /**
   * Finds files in the codebase that import from the given targetFilePath.
   * @param targetFilePath The absolute path to the file for which to find importers.
   * @returns A Set of absolute file paths that import the targetFile.
   */
  async findImporters(targetFilePath: string): Promise<Set<string>> {
    const importers = new Set<string>();
    const normalizedTargetFilePath = path.resolve(targetFilePath);

    // 1. Find possible import specifiers
    const possibleSpecifiers = new Set<string>();

    const targetFileName = path.basename(normalizedTargetFilePath);

    for (const filename of importCandidates(targetFileName)) {
      possibleSpecifiers.add(filename);
    }
    possibleSpecifiers.add(targetFileName.replace(/\.(ts|tsx|js|jsx|mjs|mts)$/, '')); // e.g., "utils"

    let targetPackage: Package | undefined;
    try {
      targetPackage = await this.resolver.resolvePackageJson(
        path.dirname(normalizedTargetFilePath)
      );
      if (targetPackage.packageJson.exports) {
        const packageExports = targetPackage.packageJson.exports;
        const packagePath = targetPackage.path;

        for (const [key, exportValue] of Object.entries(packageExports)) {
          let potentialExportTargets: string[] = [];
          if (typeof exportValue === 'string') {
            potentialExportTargets.push(exportValue);
          } else if (typeof exportValue === 'object' && exportValue !== null) {
            // Handle conditional exports by checking all string values
            Object.values(exportValue).forEach((val) => {
              if (typeof val === 'string') potentialExportTargets.push(val);
              // Deeper nested objects in conditional exports are not handled here for simplicity
            });
          }

          for (const exportPath of potentialExportTargets) {
            const resolvedExportTargetAbs = path.resolve(packagePath, exportPath);
            if (this._arePathsEquivalent(resolvedExportTargetAbs, normalizedTargetFilePath)) {
              if (targetPackage.name) {
                const specifier =
                  key === '.'
                    ? targetPackage.name
                    : path.join(targetPackage.name, key.replace(/^\.\//, ''));
                possibleSpecifiers.add(specifier);
              } else if (key.startsWith('./') || key === '.') {
                // For unnamed packages or root project files, the key itself might be used.
                possibleSpecifiers.add(key);
              }
              // Found a match for this export key, can break from inner loop
              break;
            }
          }
        }
      }
    } catch (e: any) {
      debugLog(`Could not resolve package.json for ${normalizedTargetFilePath}: ${e.message}`);
    }

    // 2. Grep for potential importers
    const potentialFilesToScan = new Set<string>();
    const searchStrings = Array.from(possibleSpecifiers).filter((s) => s.length > 0);
    if (searchStrings.length === 0) return importers; // No specifiers to search for

    debugLog(`Searching for importers of ${targetFilePath} using specifiers:`, searchStrings);

    // Grep inside the file's package (if identified)
    if (targetPackage) {
      debugLog(`Grepping in target package: ${targetPackage.path}`);
      const results = await grepFor(targetPackage.path, searchStrings, undefined, false, false);
      for (const file of results) {
        potentialFilesToScan.add(file);
      }
    } else {
      // Fallback: Grep in the directory of the file if no package info
      const baseDir = path.dirname(normalizedTargetFilePath);
      debugLog(`Grepping in base directory (no package): ${baseDir}`);
      const results = await grepFor(baseDir, searchStrings, undefined, false, false);
      for (const file of results) {
        potentialFilesToScan.add(file);
      }
    }

    // If there is an export map path, grep in the rest of the codebase (other workspace packages)
    const exportMapSpecifiers = Array.from(possibleSpecifiers).filter(
      (s) => targetPackage?.name && s.split('/')[0] === targetPackage.name
    );

    // Handle wildcard (*) exports in package.json
    if (targetPackage?.packageJson.exports) {
      for (const key of Object.keys(targetPackage.packageJson.exports)) {
        if (key.includes('*')) {
          // Convert wildcard to a grep-compatible pattern (e.g., './*.ts' -> './[^/]+\.ts')
          const wildcardPattern = key.replace(/\*/g, '[^/]+');
          const specifierPrefix = targetPackage.name ? `${targetPackage.name}/` : '';
          const wildcardSpecifier = wildcardPattern
            .replace(/^\.\//, specifierPrefix)
            .replace(/\.[jt]sx?$/, ''); // Remove file extensions for import specifiers
          exportMapSpecifiers.push(wildcardSpecifier);
        }
      }
    }

    if (
      exportMapSpecifiers.length > 0 &&
      this.resolver.pnpmWorkspacePath &&
      this.resolver.packages.size > 0
    ) {
      debugLog(`Grepping in workspace for export map specifiers:`, exportMapSpecifiers);
      for (const pkg of this.resolver.packages.values()) {
        if (targetPackage && pkg.path === targetPackage.path) {
          continue; // Already searched this package
        }
        debugLog(`Grepping in workspace package: ${pkg.path}`);
        const results = await grepFor(pkg.path, exportMapSpecifiers, undefined, false, false);
        for (const file of results) {
          potentialFilesToScan.add(file);
        }
      }
    }

    debugLog(`Found ${potentialFilesToScan.size} potential files to scan.`);

    // 3. Filter and verify
    for (const potentialFile of potentialFilesToScan) {
      debugLog(`Checking potential file: ${potentialFile}`);
      const resolvedPotentialFile = path.resolve(potentialFile);
      if (resolvedPotentialFile === normalizedTargetFilePath) {
        continue; // Don't check the file itself
      }

      const analysis = await this.resolveImports(resolvedPotentialFile);
      if (analysis?.resolved) {
        for (const imp of analysis.resolved) {
          if (imp.resolved && path.resolve(imp.resolved) === normalizedTargetFilePath) {
            importers.add(resolvedPotentialFile);
            break; // Found an import, this file is an importer
          }
        }
      }

      // Check for reexports from this file
      const fileInfo = analysis?.fileInfo;
      if (fileInfo) {
        const resolvedReexports = await this.resolver.resolveImportPaths(
          potentialFile,
          fileInfo.reexports.map((re) => re.module)
        );
        if (
          resolvedReexports.some(
            (re) =>
              re.resolved === normalizedTargetFilePath ||
              (re.resolved && this._arePathsEquivalent(re.resolved, normalizedTargetFilePath))
          )
        ) {
          debugLog(
            `File ${resolvedPotentialFile} reexports ${targetFilePath}, adding as an importer.`
          );
          const reexportImporters = await this.findImporters(resolvedPotentialFile);
          for (const reexportImporter of reexportImporters) {
            importers.add(reexportImporter);
          }
        }
      }
    }
    debugLog(`Confirmed ${importers.size} importers for ${targetFilePath}.`);
    return importers;
  }
}
