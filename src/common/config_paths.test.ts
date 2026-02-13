import { afterEach, describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';

import { getTimConfigRoot } from './config_paths.js';

describe('getTimConfigRoot', () => {
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalAppData = process.env.APPDATA;

  afterEach(() => {
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }

    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
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
