import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';

type ManifestIcon = {
  src: string;
  sizes: string;
  type?: string;
};

type WebManifest = {
  name?: string;
  short_name?: string;
  start_url?: string;
  display?: string;
  icons?: ManifestIcon[];
};

const repoRoot = process.cwd();
const staticDir = path.join(repoRoot, 'static');
const manifestPath = path.join(staticDir, 'manifest.webmanifest');

async function readManifest(): Promise<WebManifest> {
  const manifestJson = await fs.readFile(manifestPath, 'utf8');
  return JSON.parse(manifestJson) as WebManifest;
}

async function expectFileToExist(filePath: string): Promise<void> {
  const stats = await fs.stat(filePath);
  expect(stats.isFile()).toBe(true);
}

describe('static/manifest.webmanifest', () => {
  test('includes the required installability fields with base-path-safe values', async () => {
    expect.hasAssertions();
    const manifest = await readManifest();

    expect(manifest).toMatchObject({
      name: expect.any(String),
      short_name: expect.any(String),
      start_url: '.',
      display: 'standalone',
      icons: expect.any(Array),
    });
    expect(manifest.name).not.toHaveLength(0);
    expect(manifest.short_name).not.toHaveLength(0);
    expect(manifest.icons).not.toHaveLength(0);
  });

  test('declares 192x192 and 512x512 icons and each referenced icon exists', async () => {
    expect.hasAssertions();
    const manifest = await readManifest();
    const icons = manifest.icons ?? [];

    expect(icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: '192x192' }),
        expect.objectContaining({ sizes: '512x512' }),
      ])
    );

    for (const icon of icons) {
      expect(icon.src).toEqual(expect.any(String));
      // Icon URLs must be relative (no leading slash) for base-path compatibility
      expect(icon.src).not.toMatch(/^\//);
      const iconPath = path.join(staticDir, icon.src);
      await expectFileToExist(iconPath);
    }
  });

  test('ships the standalone favicon asset', async () => {
    expect.hasAssertions();
    await expectFileToExist(path.join(staticDir, 'favicon.png'));
  });
});

describe('src/app.html PWA tags', () => {
  test('includes manifest link and PWA meta tags', async () => {
    expect.hasAssertions();
    const appHtml = await fs.readFile(path.join(repoRoot, 'src', 'app.html'), 'utf8');

    expect(appHtml).toContain('rel="manifest"');
    expect(appHtml).toContain('manifest.webmanifest');
    expect(appHtml).toContain('name="theme-color"');
    expect(appHtml).toContain('name="apple-mobile-web-app-capable"');
    expect(appHtml).toContain('rel="apple-touch-icon"');
  });
});
