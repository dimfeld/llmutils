import { mock } from 'bun:test';
import yaml from 'yaml';
import { clearPlanCache } from './rmplan/plans.js';
import { clearConfigCache } from './rmplan/configLoader.js';
import { clearAllGitCaches } from './common/git.js';

/**
 * Converts a plan object to a string with YAML frontmatter format.
 * This is useful for writing plan files in tests since rmplan now requires
 * files to have frontmatter delimiters.
 */
export function stringifyPlanWithFrontmatter(plan: Record<string, unknown>): string {
  const { details, ...planWithoutDetails } = plan;
  const yamlContent = yaml.stringify(planWithoutDetails);
  let content = `---\n${yamlContent}---\n`;
  if (details) {
    content += `\n${details}\n`;
  }
  return content;
}

/**
 * Clears all rmplan-related caches. Call this in beforeEach and afterEach
 * to ensure tests don't pollute each other's state.
 */
export function clearAllRmplanCaches(): void {
  clearPlanCache();
  clearConfigCache();
  clearAllGitCaches();
}

export type MockResult = {
  clear: () => void;
};

/**
 * Due to an issue with Bun (https://github.com/oven-sh/bun/issues/7823), we need to manually restore mocked modules
 * after we're done. We do this by setting the mocked value to the original module.
 *
 * When setting up a test that will mock a module, the block should add this:
 * const moduleMocker = new ModuleMocker(import.meta)
 *
 * afterEach(() => {
 *   moduleMocker.clear()
 * })
 *
 * When a test mocks a module, it should do it this way:
 *
 * await moduleMocker.mock('@/services/token.ts', () => ({
 *   getBucketToken: mock(() => {
 *     throw new Error('Unexpected error')
 *   })
 * }))
 *
 */
export class ModuleMocker {
  private mocks: MockResult[] = [];
  private importMeta: ImportMeta;

  mocked = new Set<string>();

  constructor(importMeta: ImportMeta) {
    this.importMeta = importMeta;
  }

  async mock(modulePath: string, renderMocks: () => Record<string, any>) {
    // Resolve the module path relative to the calling file
    const resolvedPath = Bun.resolveSync(modulePath, this.importMeta.dirname);

    let original: Record<string, any>;
    try {
      // Try to import the module using the resolved path
      original = {
        ...(await import(resolvedPath)),
      };
    } catch (e) {
      // If import fails, the module might not exist yet or we're dealing with
      // a path that needs special handling. In this case, we'll just use an empty object
      original = {};
    }

    let mocks = renderMocks();
    let result = {
      ...original,
      ...mocks,
    };
    void mock.module(resolvedPath, () => result);

    if (!this.mocked.has(resolvedPath)) {
      this.mocks.push({
        clear: () => {
          void mock.module(resolvedPath, () => original);
        },
      });
    }

    this.mocked.add(resolvedPath);
  }

  clear() {
    this.mocks.forEach((mockResult) => mockResult.clear());
    this.mocks = [];
    this.mocked.clear();
  }
}
