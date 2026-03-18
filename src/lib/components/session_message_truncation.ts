export const TRUNCATE_LINE_LIMIT = 10;
export const TEXT_TRUNCATE_CHAR_LIMIT = 4000;
export const KV_VALUE_TRUNCATE_CHARS = 500;

export interface TextTruncationState {
  isTruncatable: boolean;
  displayText: string;
  hiddenLineCount: number;
  hiddenCharCount: number;
  truncationMode: 'none' | 'lines' | 'chars';
}

export function getTextTruncationState(
  text: string,
  expanded: boolean,
  {
    lineLimit = TRUNCATE_LINE_LIMIT,
    charLimit = TEXT_TRUNCATE_CHAR_LIMIT,
  }: { lineLimit?: number; charLimit?: number } = {}
): TextTruncationState {
  const lines = text.split('\n');
  const hiddenLineCount = Math.max(0, lines.length - lineLimit);
  const hiddenCharCount = Math.max(0, text.length - charLimit);
  const exceedsLineLimit = hiddenLineCount > 0;
  const exceedsCharLimit = hiddenCharCount > 0;

  if (!exceedsLineLimit && !exceedsCharLimit) {
    return {
      isTruncatable: false,
      displayText: text,
      hiddenLineCount,
      hiddenCharCount,
      truncationMode: 'none',
    };
  }

  if (expanded) {
    return {
      isTruncatable: true,
      displayText: text,
      hiddenLineCount,
      hiddenCharCount,
      truncationMode: exceedsLineLimit ? 'lines' : 'chars',
    };
  }

  if (exceedsLineLimit) {
    const truncatedByLines = lines.slice(0, lineLimit).join('\n');
    const displayText =
      truncatedByLines.length > charLimit
        ? `${truncatedByLines.slice(0, charLimit)}...`
        : truncatedByLines;

    return {
      isTruncatable: true,
      displayText,
      hiddenLineCount,
      hiddenCharCount: Math.max(0, text.length - displayText.length),
      truncationMode: 'lines',
    };
  }

  return {
    isTruncatable: true,
    displayText: `${text.slice(0, charLimit)}...`,
    hiddenLineCount,
    hiddenCharCount,
    truncationMode: 'chars',
  };
}
