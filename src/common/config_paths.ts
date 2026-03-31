import * as os from 'node:os';
import * as path from 'node:path';

export function getTimConfigRoot(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'tim');
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, 'tim');
  }

  return path.join(os.homedir(), '.config', 'tim');
}

export function getTimCacheDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'tim');
  }

  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim();
  if (xdgCacheHome) {
    return path.join(xdgCacheHome, 'tim');
  }

  return path.join(os.homedir(), '.cache', 'tim');
}

export function getLogDir(): string {
  return path.join(getTimCacheDir(), 'logs');
}
