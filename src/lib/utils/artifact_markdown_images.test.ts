import { describe, expect, test } from 'vitest';

import {
  createArtifactImageUrlResolver,
  type MarkdownImageArtifact,
} from './artifact_markdown_images.js';

const artifacts: MarkdownImageArtifact[] = [
  {
    filename: 'images/chart.png',
    url: '/api/artifacts/chart?view=1',
    viewKind: 'image',
  },
  {
    filename: 'screenshots/result space.png',
    url: '/api/artifacts/result-space?view=1',
    viewKind: 'image',
  },
  {
    filename: 'left/logo.png',
    url: '/api/artifacts/left-logo?view=1',
    viewKind: 'image',
  },
  {
    filename: 'right/logo.png',
    url: '/api/artifacts/right-logo?view=1',
    viewKind: 'image',
  },
  {
    filename: 'notes/chart.md',
    url: '/api/artifacts/chart-md?view=1',
    viewKind: 'markdown',
  },
];

describe('createArtifactImageUrlResolver', () => {
  test('resolves exact artifact filenames to artifact API view URLs', () => {
    const resolve = createArtifactImageUrlResolver(artifacts);
    expect(resolve('images/chart.png')).toBe('/api/artifacts/chart?view=1');
  });

  test('resolves unique basename references', () => {
    const resolve = createArtifactImageUrlResolver(artifacts);
    expect(resolve('chart.png')).toBe('/api/artifacts/chart?view=1');
  });

  test('does not resolve ambiguous basename references', () => {
    const resolve = createArtifactImageUrlResolver(artifacts);
    expect(resolve('logo.png')).toBe('logo.png');
    expect(resolve('right/logo.png')).toBe('/api/artifacts/right-logo?view=1');
  });

  test('decodes markdown URL paths and preserves fragments on matched images', () => {
    const resolve = createArtifactImageUrlResolver(artifacts);
    expect(resolve('result%20space.png#preview')).toBe(
      '/api/artifacts/result-space?view=1#preview'
    );
  });

  test('leaves external, protocol-relative, anchor, and unmatched URLs unchanged', () => {
    const resolve = createArtifactImageUrlResolver(artifacts);
    expect(resolve('https://example.com/chart.png')).toBe('https://example.com/chart.png');
    expect(resolve('//example.com/chart.png')).toBe('//example.com/chart.png');
    expect(resolve('#chart')).toBe('#chart');
    expect(resolve('missing.png')).toBe('missing.png');
  });

  test('ignores non-image artifacts', () => {
    const resolve = createArtifactImageUrlResolver(artifacts);
    expect(resolve('chart.md')).toBe('chart.md');
  });
});
