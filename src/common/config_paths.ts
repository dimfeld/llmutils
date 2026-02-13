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
