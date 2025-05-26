import type { LoggerAdapter } from '../adapter.js';
import type { InferInsertModel } from 'drizzle-orm';
import { taskLogs as taskLogsTable } from '../../bot/db/schema.js';
import util from 'node:util';

type TaskLogInsert = InferInsertModel<typeof taskLogsTable>;
type DrizzleDb = any;

/**
 * A LoggerAdapter that writes log entries directly to the task_logs SQLite table.
 * This adapter associates all log entries with a specific taskId.
 */
export class DatabaseLoggerAdapter implements LoggerAdapter {
  constructor(
    private taskId: string,
    private db: DrizzleDb
  ) {}

  /**
   * Logs a message at the default log level
   */
  log(...args: any[]): void {
    this.writeLog('info', args);
  }

  /**
   * Logs an error message
   */
  error(...args: any[]): void {
    this.writeLog('error', args);
  }

  /**
   * Logs a warning message
   */
  warn(...args: any[]): void {
    this.writeLog('warn', args);
  }

  /**
   * Logs a debug message
   */
  debugLog(...args: any[]): void {
    this.writeLog('debug', args);
  }

  /**
   * Writes directly to stdout (also captured)
   */
  writeStdout(data: string): void {
    this.writeLog('info', [`STDOUT: ${data}`]);
  }

  /**
   * Writes directly to stderr (also captured)
   */
  writeStderr(data: string): void {
    this.writeLog('info', [`STDERR: ${data}`]);
  }

  /**
   * Helper method to write a log entry to the database
   */
  private writeLog(logLevel: string, args: any[]): void {
    // Format the message by concatenating all arguments
    const message = args
      .map((arg) => {
        if (typeof arg === 'object') {
          return util.inspect(arg, { depth: null, colors: false });
        }
        return String(arg);
      })
      .join(' ');

    // Prepare the log entry
    const logEntry: TaskLogInsert = {
      taskId: this.taskId,
      logLevel,
      message,
      fullContent: null,
      // timestamp will be set by DB default
    };

    // Insert into the database (fire and forget)
    this.db
      .insert(taskLogsTable)
      .values(logEntry)
      .catch((error: any) => {
        // Fall back to console logging if DB insertion fails
        console.error('[DatabaseLoggerAdapter] Failed to write log to database:', error);
        console.log(`[${logLevel.toUpperCase()}] ${message}`);
      });
  }
}
