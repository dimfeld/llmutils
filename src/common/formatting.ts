export function singleLineWithPrefix(prefix: string, text: string, padding = 0) {
  // Combine prefix and text, and truncate to process.stdout width. If the text is too long, add "...".
  const output = `${prefix}${text.replaceAll(/[\r\n ]+/g, ' ')}`;

  const width = process.stdout.columns - padding;
  if (output.length > width) {
    return output.slice(0, width - 1) + '…';
  }
  return output;
}

export function formatByteSize(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${bytes} ${units[unitIndex]}`;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

export function limitLines(text: string, maxLines: number) {
  const lines = text.split('\n');
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join('\n') + '\n…';
  }
  return text;
}
