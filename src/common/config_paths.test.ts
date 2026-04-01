import { afterEach, describe, expect, test, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

import { getTimCacheDir, getTimConfigRoot } from './config_paths.js';

describe('getTimConfigRoot', () => {
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
  const originalAppData = process.env.APPDATA;
  const originalLocalAppData = process.env.LOCALAPPDATA;

  afterEach(() => {
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }

    if (originalXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    }

    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }

    if (originalLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = originalLocalAppData;
    }
  });

  test('uses XDG_CONFIG_HOME when set on non-Windows', () => {
    if (process.platform === 'win32') {
      return;
    }

    process.env.XDG_CONFIG_HOME = '/tmp/tim-config-path-test';
    delete process.env.APPDATA;

    expect(getTimConfigRoot()).toBe('/tmp/tim-config-path-test/tim');
  });

  test('falls back to homedir config path on non-Windows without XDG_CONFIG_HOME', () => {
    if (process.platform === 'win32') {
      return;
    }

    delete process.env.XDG_CONFIG_HOME;
    delete process.env.APPDATA;

    expect(getTimConfigRoot()).toBe(path.join(os.homedir(), '.config', 'tim'));
  });

  test('uses APPDATA path on Windows', () => {
    if (process.platform !== 'win32') {
      return;
    }

    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming';
    process.env.XDG_CONFIG_HOME = '/tmp/should-be-ignored';

    expect(getTimConfigRoot()).toBe(path.join('C:\\Users\\tester\\AppData\\Roaming', 'tim'));
  });
});

describe('getTimCacheDir', () => {
  const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
  const originalLocalAppData = process.env.LOCALAPPDATA;

  afterEach(() => {
    if (originalXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    }

    if (originalLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = originalLocalAppData;
    }
  });

  test('uses XDG_CACHE_HOME when set on non-Windows', () => {
    if (process.platform === 'win32') {
      return;
    }

    process.env.XDG_CACHE_HOME = '/tmp/tim-cache-path-test';
    delete process.env.LOCALAPPDATA;

    expect(getTimCacheDir()).toBe('/tmp/tim-cache-path-test/tim');
  });

  test('falls back to homedir cache path on non-Windows without XDG_CACHE_HOME', () => {
    if (process.platform === 'win32') {
      return;
    }

    delete process.env.XDG_CACHE_HOME;
    delete process.env.LOCALAPPDATA;

    expect(getTimCacheDir()).toBe(path.join(os.homedir(), '.cache', 'tim'));
  });

  test('ignores blank XDG_CACHE_HOME values on non-Windows', () => {
    if (process.platform === 'win32') {
      return;
    }

    process.env.XDG_CACHE_HOME = '   ';
    delete process.env.LOCALAPPDATA;

    expect(getTimCacheDir()).toBe(path.join(os.homedir(), '.cache', 'tim'));
  });

  test('uses LOCALAPPDATA path on Windows', () => {
    if (process.platform !== 'win32') {
      return;
    }

    process.env.LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local';
    process.env.XDG_CACHE_HOME = '/tmp/should-be-ignored';

    expect(getTimCacheDir()).toBe(path.join('C:\\Users\\tester\\AppData\\Local', 'tim'));
  });
});
