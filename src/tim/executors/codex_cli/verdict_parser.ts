/** Parse the reviewer verdict from output text */
export function parseReviewerVerdict(output: string): 'ACCEPTABLE' | 'NEEDS_FIXES' | 'UNKNOWN' {
  // Look for a line like: "VERDICT: ACCEPTABLE" or "VERDICT: NEEDS_FIXES"
  const regex = /\bVERDICT.*\s+(ACCEPTABLE|NEEDS_FIXES)\b/i;
  const m = output.match(regex);
  if (!m) return 'UNKNOWN';
  const v = m[1].toUpperCase();
  if (v === 'ACCEPTABLE') return 'ACCEPTABLE';
  if (v === 'NEEDS_FIXES') return 'NEEDS_FIXES';
  return 'UNKNOWN';
}
