import type { SerializableValue } from 'fastmcp';
import type { RmplanConfig } from '../configSchema.js';

export type ToolLogger = {
  debug: (message: string, data?: SerializableValue) => void;
  error: (message: string, data?: SerializableValue) => void;
  info: (message: string, data?: SerializableValue) => void;
  warn: (message: string, data?: SerializableValue) => void;
};

export interface ToolContext {
  config: RmplanConfig;
  configPath?: string;
  gitRoot: string;
  log?: ToolLogger;
}

export interface ToolResult<T = unknown> {
  text: string;
  data?: T;
  message?: string;
}
