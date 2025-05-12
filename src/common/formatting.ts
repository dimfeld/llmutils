export function singleLineWithPrefix(prefix: string, text: string, padding = 0) {
  // Combine prefix and text, and truncate to process.stdout width. If the text is too long, add "...".
  const output = `${prefix}${text}`;

  const width = process.stdout.columns - padding;
  if (output.length > width) {
    return output.slice(0, width - 1) + '…';
  }
  return output;
}
