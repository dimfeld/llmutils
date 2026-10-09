import { describe, expect, it } from 'vitest';

import { buildReviewFileTree, categorizeReviewFile } from './review_file_tree.js';

describe('categorizeReviewFile', () => {
  it('finds tests from the file name', () => {
    expect(categorizeReviewFile('src/lib/foo.test.ts')).toBe('tests');
    expect(categorizeReviewFile('src/lib/Foo.svelte.e2e.test.ts')).toBe('tests');
    expect(categorizeReviewFile('src/lib/foo.spec.js')).toBe('tests');
    expect(categorizeReviewFile('pkg/server/handler_test.go')).toBe('tests');
    expect(categorizeReviewFile('app/test_models.py')).toBe('tests');
    expect(categorizeReviewFile('src/main/java/FooTest.java')).toBe('tests');
  });

  it('finds tests from directory names', () => {
    expect(categorizeReviewFile('tests/helpers.ts')).toBe('tests');
    expect(categorizeReviewFile('src/__tests__/a.ts')).toBe('tests');
    expect(categorizeReviewFile('src/testing/setup.ts')).toBe('tests');
    expect(categorizeReviewFile('src/test-utils/render.ts')).toBe('tests');
    expect(categorizeReviewFile('e2e/login.ts')).toBe('tests');
    expect(categorizeReviewFile('tests/README.md')).toBe('tests');
  });

  it('does not treat words that only contain "test" as tests', () => {
    expect(categorizeReviewFile('src/latest/index.ts')).toBe('implementation');
    expect(categorizeReviewFile('src/contest.ts')).toBe('implementation');
    expect(categorizeReviewFile('src/attestation.ts')).toBe('implementation');
  });

  it('finds documentation from directory names and file types', () => {
    expect(categorizeReviewFile('docs/testing.md')).toBe('documentation');
    expect(categorizeReviewFile('docs/diagram.svg')).toBe('documentation');
    expect(categorizeReviewFile('packages/api-docs/index.html')).toBe('documentation');
    expect(categorizeReviewFile('README.md')).toBe('documentation');
    expect(categorizeReviewFile('CHANGELOG')).toBe('documentation');
    expect(categorizeReviewFile('src/notes.mdx')).toBe('documentation');
  });

  it('puts other files in implementation', () => {
    expect(categorizeReviewFile('src/lib/foo.ts')).toBe('implementation');
    expect(categorizeReviewFile('package.json')).toBe('implementation');
  });
});

describe('buildReviewFileTree', () => {
  const tree = buildReviewFileTree([
    'src/lib/utils/b.ts',
    'src/lib/utils/a.ts',
    'src/lib/components/View.svelte',
    'src/lib/utils/a.test.ts',
    'README.md',
    'docs/web.md',
    'package.json',
  ]);

  it('groups files in the order implementation, documentation, tests', () => {
    expect(tree.map((group) => [group.category, group.label])).toEqual([
      ['implementation', 'Implementation'],
      ['documentation', 'Documentation'],
      ['tests', 'Tests'],
    ]);
  });

  it('joins single-child directories and sorts directories before files', () => {
    const [implementation] = tree;
    expect(implementation.nodes.map((node) => [node.kind, node.name])).toEqual([
      ['dir', 'src/lib'],
      ['file', 'package.json'],
    ]);
    const srcLib = implementation.nodes[0];
    expect(srcLib.kind === 'dir' && srcLib.path).toBe('src/lib');
    expect(srcLib.kind === 'dir' && srcLib.children.map((node) => node.name)).toEqual([
      'components',
      'utils',
    ]);
  });

  it('lists file paths in tree order', () => {
    expect(tree[0].paths).toEqual([
      'src/lib/components/View.svelte',
      'src/lib/utils/a.ts',
      'src/lib/utils/b.ts',
      'package.json',
    ]);
    expect(tree[1].paths).toEqual(['docs/web.md', 'README.md']);
    expect(tree[2].paths).toEqual(['src/lib/utils/a.test.ts']);
  });

  it('keeps a test file under its full directory name', () => {
    const tests = tree[2];
    expect(tests.nodes).toEqual([
      {
        kind: 'dir',
        name: 'src/lib/utils',
        path: 'src/lib/utils',
        children: [{ kind: 'file', name: 'a.test.ts', path: 'src/lib/utils/a.test.ts' }],
      },
    ]);
  });

  it('leaves out empty groups', () => {
    expect(buildReviewFileTree(['a.ts']).map((group) => group.category)).toEqual([
      'implementation',
    ]);
    expect(buildReviewFileTree([])).toEqual([]);
  });
});
