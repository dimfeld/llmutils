import type { LoggerAdapter } from '../../logging/adapter.js';
import { db, taskLogs } from '../db/index.js';
import stripAnsi from 'strip-ansi';

type LogLevel = 'log' | 'error' | 'warn' | 'debug';

interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
}

/**
 * A LoggerAdapter that captures all log output to a database.
 * This adapter buffers log entries and can save them to the task_logs table.
 */
export class DatabaseLoggerAdapter implements LoggerAdapter {
  private logEntries: LogEntry[] = [];
  private fullContentBuffer: string[] = [];

  constructor(private debug: boolean = false) {}

  /**
   * Logs a message at the default log level
   */
  log(...args: any[]): void {
    this.addEntry('log', args);
  }

  /**
   * Logs an error message
   */
  error(...args: any[]): void {
    this.addEntry('error', args);
  }

  /**
   * Logs a warning message
   */
  warn(...args: any[]): void {
    this.addEntry('warn', args);
  }

  /**
   * Writes directly to stdout (also captured)
   */
  writeStdout(data: string): void {
    this.fullContentBuffer.push(data);
  }

  /**
   * Writes directly to stderr (also captured)
   */
  writeStderr(data: string): void {
    this.fullContentBuffer.push(`[STDERR] ${data}`);
  }

  /**
   * Logs a debug message (only shown in debug mode)
   */
  debugLog(...args: any[]): void {
    if (this.debug) {
      this.addEntry('debug', args);
    }
  }

  /**
   * Adds a log entry to the buffer
   */
  private addEntry(level: LogLevel, args: any[]): void {
    const message = args
      .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)))
      .join(' ');

    // Limit message length to prevent database issues
    const truncatedMessage = message.length > 1000 ? message.slice(0, 997) + '...' : message;

    this.logEntries.push({
      timestamp: new Date(),
      level,
      message: truncatedMessage,
    });

    // Also add to full content buffer for complete output capture
    const formattedMessage = `[${level.toUpperCase()}] ${message}`;
    this.fullContentBuffer.push(formattedMessage);
  }

  /**
   * Gets the full buffered output as a single string
   */
  getFullOutput(): string {
    return this.fullContentBuffer.join('\n');
  }

  /**
   * Saves all buffered log entries to the database
   */
  async save(taskId: string, status: string = 'success'): Promise<void> {
    if (this.logEntries.length === 0 && this.fullContentBuffer.length === 0) {
      return;
    }

    try {
      // Save individual log entries
      for (const entry of this.logEntries) {
        await db.insert(taskLogs).values({
          taskId,
          logLevel: entry.level,
          message: stripAnsi(entry.message),
          timestamp: entry.timestamp,
        });
      }

      // Use the raw output buffer if available, otherwise use structured logs
      let fullContent: string;
      if (this.fullContentBuffer.length > 0) {
        fullContent = this.fullContentBuffer.join('');
      } else {
        // Fallback to structured logs
        fullContent = this.logEntries
          .map(
            (entry) =>
              `[${entry.timestamp.toISOString()}] [${entry.level.toUpperCase()}] ${entry.message}`
          )
          .join('\n');
      }

      // Also save complete output as a single entry
      await db.insert(taskLogs).values({
        taskId,
        logLevel: 'info',
        message: `Agent execution ${status}`,
        fullContent: stripAnsi(fullContent),
      });
    } catch (error) {
      console.error('Failed to save logs to database:', error);
      // Don't throw - logging failures shouldn't break the main process
    }
  }

  /**
   * Clears the buffer
   */
  clear(): void {
    this.logEntries = [];
    this.fullContentBuffer = [];
  }

  /**
   * Gets the current buffer size
   */
  getBufferSize(): number {
    return this.logEntries.length;
  }
}
