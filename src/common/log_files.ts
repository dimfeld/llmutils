import fs from 'node:fs';
import path from 'node:path';

import { getLogDir } from './config_paths.js';

export interface LogFileInfo {
  fd: number;
  path: string;
}

export function formatLogFileName(planId: number, command: string, timestamp = new Date()): string {
  const isoTimestamp = timestamp.toISOString().replace(/[:.]/g, '-');
  return `${planId}-${isoTimestamp}-${command}.log`;
}

export function createLogFile(command: string, planId: number): LogFileInfo {
  const logDir = getLogDir();
  fs.mkdirSync(logDir, { recursive: true });

  const filename = formatLogFileName(planId, command);
  const logPath = path.join(logDir, filename);

  return { fd: fs.openSync(logPath, 'a'), path: logPath };
}
