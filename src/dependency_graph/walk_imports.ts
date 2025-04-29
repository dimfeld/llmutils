import { file } from 'bun';
import {
  extractExportedVariables,
  extractExportedFunctions,
  extractExportedClasses,
  extractImportsExportModules,
  extractExportedInterfaces,
  extractExportedTypeAliases,
  Extractor,
} from '../treesitter/extract.js';
import { Resolver } from './resolve.js';
import * as path from 'path';
import { error } from '../logging.js';

interface FileInfo {
  imports: { module: string; namedImports?: { name: string; alias?: string }[] }[];
  reexports: { module: string; namedExports?: { name: string; alias?: string }[] }[];
  exportedNames: Set<string>;
}

export class ImportWalker {
  private extractor: Extractor;
  private resolver: Resolver;
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

  async getDefiningFiles(filePath: string): Promise<Set<string>> {
    const fileInfo = await this.getFileInfo(filePath);
    if (!fileInfo) {
      return new Set();
    }

    const definingFiles = new Set<string>();

    const allResolved = await this.resolver.resolveImportPaths(
      filePath,
      fileInfo.imports.map((i) => i.module)
    );
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
}
