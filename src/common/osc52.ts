/**
 * Implementation of OSC52 clipboard operations for terminal use
 */

/**
 * Copies text to the clipboard using OSC52 escape sequence
 *
 * This sends a special escape sequence to the terminal which instructs it
 * to set its clipboard to the provided text.
 *
 * @param text The text to copy to the clipboard
 */
export async function osc52Copy(text: string): Promise<void> {
  // Encode the text as base64
  const base64EncodedText = Buffer.from(text).toString('base64');

  // Construct the OSC52 escape sequence
  // \x1b is the escape character, 52 is the OSC code for clipboard operations,
  // 'c' specifies the clipboard selection, and \x07 is the sequence terminator
  const osc52Sequence = `\x1b]52;c;${base64EncodedText}\x07`;

  // Write the sequence to stdout
  process.stdout.write(osc52Sequence);

  // Return a resolved promise
  return Promise.resolve();
}
