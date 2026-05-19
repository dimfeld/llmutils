/**
 * Clipboard operations wrapper module
 *
 * This module provides a unified interface for clipboard operations,
 * using OSC52 in SSH sessions and falling back to clipboardy otherwise.
 */

import { isSshSession } from './ssh_detection.js';
import { osc52Copy, osc52Read } from './osc52.js';
import clipboard from 'clipboardy';
import { debugLog } from '../logging.js';

/**
 * Writes text to the clipboard
 *
 * In SSH sessions, this will attempt to use OSC52 and fall back to clipboardy if that fails.
 * In non-SSH sessions, this will use clipboardy directly.
 *
 * @param text The text to write to the clipboard
 */
export async function write(text: string): Promise<void> {
  if (isSshSession()) {
    try {
      await osc52Copy(text);
    } catch (error) {
      debugLog('OSC52 copy failed, falling back to clipboardy:', error);
      await clipboard.write(text);
    }
  } else {
    await clipboard.write(text);
  }
}

/**
 * Reads text from the clipboard
 *
 * In SSH sessions, this will attempt to use OSC52 first and fall back to clipboardy if that fails.
 * In non-SSH sessions, this will use clipboardy directly.
 *
 * @returns The text from the clipboard
 */
export async function read(): Promise<string> {
  if (isSshSession()) {
    try {
      const oscText = await osc52Read();
      if (oscText !== null) {
        debugLog('Successfully read from clipboard using OSC52.');
        return oscText;
      } else {
        debugLog('OSC52 read failed or timed out, falling back to clipboardy.read().');
        return await clipboard.read();
      }
    } catch (error) {
      debugLog('Error during OSC52 read, falling back to clipboardy.read():', error);
      return await clipboard.read();
    }
  } else {
    return await clipboard.read();
  }
}
