export type ReviewFileCategory = 'implementation' | 'tests' | 'documentation';

export const REVIEW_FILE_CATEGORY_ORDER: ReviewFileCategory[] = [
  'implementation',
  'documentation',
  'tests',
];

export const REVIEW_FILE_CATEGORY_LABELS: Record<ReviewFileCategory, string> = {
  implementation: 'Implementation',
  tests: 'Tests',
  documentation: 'Documentation',
};

/** Words in a directory name that mark its files as tests. */
const TEST_DIR_WORDS = new Set([
  'test',
  'tests',
  'testing',
  'spec',
  'specs',
  'e2e',
  'fixture',
  'fixtures',
  'mock',
  'mocks',
  'testdata',
]);

/** Words in a directory name that mark its files as documentation. */
const DOC_DIR_WORDS = new Set(['doc', 'docs', 'documentation']);

const TEST_FILE_PATTERNS = [
  // foo.test.ts, foo.spec.ts, foo.svelte.e2e.test.ts
  /\.(test|spec|e2e)\.[^/]+$/i,
  // foo_test.go, foo_spec.rb, foo-test.js
  /[._-](test|tests|spec)\.[^./]+$/i,
  // test_foo.py
  /^test_[^/]+\.py$/i,
  // FooTest.java, FooTests.cs
  /[a-z0-9]Tests?\.(java|kt|cs|swift|scala)$/,
];

const DOC_EXTENSIONS = /\.(md|mdx|markdown|rst|adoc|asciidoc|txt)$/i;
const DOC_FILE_NAMES = /^(readme|changelog|changes|contributing|license|authors|notice)(\..*)?$/i;

/** Split a directory name into lowercase words, e.g. `__tests__` or `api-docs`. */
function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function dirHasWord(dirs: string[], words: Set<string>): boolean {
  return dirs.some((dir) => nameWords(dir).some((word) => words.has(word)));
}

/**
 * Put a changed file into a review group from its file name and from the names
 * of the directories that hold it.
 */
export function categorizeReviewFile(path: string): ReviewFileCategory {
  const parts = path.split('/');
  const fileName = parts.at(-1) ?? path;
  const dirs = parts.slice(0, -1);

  if (TEST_FILE_PATTERNS.some((pattern) => pattern.test(fileName))) return 'tests';
  if (dirHasWord(dirs, TEST_DIR_WORDS)) return 'tests';
  if (dirHasWord(dirs, DOC_DIR_WORDS)) return 'documentation';
  if (DOC_EXTENSIONS.test(fileName) || DOC_FILE_NAMES.test(fileName)) return 'documentation';
  return 'implementation';
}

export interface FileTreeDir {
  kind: 'dir';
  /** Display name. Directories with only one child directory are joined, e.g. `src/lib`. */
  name: string;
  /** Full directory path, unique in its group. */
  path: string;
  children: FileTreeNode[];
}

export interface FileTreeFile {
  kind: 'file';
  name: string;
  path: string;
}

export type FileTreeNode = FileTreeDir | FileTreeFile;

export interface FileTreeGroup {
  category: ReviewFileCategory;
  label: string;
  nodes: FileTreeNode[];
  /** File paths in the order the tree shows them. */
  paths: string[];
}

function sortNodes(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.kind === 'dir') sortNodes(node.children);
  }
}

/** Join each directory that holds only one directory with that child. */
function compactNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.kind === 'file') return node;
    let dir = node;
    while (dir.children.length === 1 && dir.children[0].kind === 'dir') {
      const child = dir.children[0];
      dir = {
        kind: 'dir',
        name: `${dir.name}/${child.name}`,
        path: child.path,
        children: child.children,
      };
    }
    return { ...dir, children: compactNodes(dir.children) };
  });
}

function collectPaths(nodes: FileTreeNode[], out: string[]): string[] {
  for (const node of nodes) {
    if (node.kind === 'file') out.push(node.path);
    else collectPaths(node.children, out);
  }
  return out;
}

function buildTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const dirs = new Map<string, FileTreeDir>();
  for (const path of paths) {
    const parts = path.split('/');
    let siblings = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join('/');
      let dir = dirs.get(dirPath);
      if (!dir) {
        dir = { kind: 'dir', name: parts[i], path: dirPath, children: [] };
        dirs.set(dirPath, dir);
        siblings.push(dir);
      }
      siblings = dir.children;
    }
    siblings.push({ kind: 'file', name: parts.at(-1) ?? path, path });
  }
  sortNodes(root);
  return compactNodes(root);
}

/** Group changed files by category, and show each group as a directory tree. */
export function buildReviewFileTree(paths: string[]): FileTreeGroup[] {
  const byCategory = new Map<ReviewFileCategory, string[]>();
  for (const path of paths) {
    const category = categorizeReviewFile(path);
    const list = byCategory.get(category) ?? [];
    list.push(path);
    byCategory.set(category, list);
  }

  const groups: FileTreeGroup[] = [];
  for (const category of REVIEW_FILE_CATEGORY_ORDER) {
    const categoryPaths = byCategory.get(category);
    if (!categoryPaths?.length) continue;
    const nodes = buildTree(categoryPaths);
    groups.push({
      category,
      label: REVIEW_FILE_CATEGORY_LABELS[category],
      nodes,
      paths: collectPaths(nodes, []),
    });
  }
  return groups;
}
