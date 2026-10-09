/**
 * Compute whether a review-guide diff segment should expose the gutter
 * "add issue" button. Requires a filename — diff segments without one
 * (e.g. pre-diff context) can't anchor a new issue.
 */
export interface ReviewGuideDiffOverrideFlags {
  enableLineSelection: boolean;
  enableGutterUtility: boolean;
  exposeGutterClick: boolean;
}

export function computeReviewGuideDiffOverrideFlags(
  filename: string | null
): ReviewGuideDiffOverrideFlags {
  const canAddIssues = filename != null;
  return {
    enableLineSelection: true,
    enableGutterUtility: canAddIssues,
    exposeGutterClick: canAddIssues,
  };
}

/** The part of the review guide view that the URL query string records. */
export interface ReviewGuideLocation {
  tab: 'guide' | 'files';
  /** Section slug, only on the guide tab. */
  section: string | null;
  /** File path, only on the files tab. */
  file: string | null;
}

export function readReviewGuideLocation(search: string): ReviewGuideLocation {
  const params = new URLSearchParams(search);
  const tab = params.get('tab') === 'files' ? 'files' : 'guide';
  return {
    tab,
    section: tab === 'guide' ? params.get('section') || null : null,
    file: tab === 'files' ? params.get('file') || null : null,
  };
}

/**
 * Return `href` with the query parameters for `location`. Other query
 * parameters stay unchanged. The guide tab is the default, so it has no `tab`
 * parameter.
 */
export function writeReviewGuideLocation(href: string, location: ReviewGuideLocation): string {
  const url = new URL(href);
  const set = (key: string, value: string | null) => {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  };
  set('tab', location.tab === 'files' ? 'files' : null);
  set('section', location.tab === 'guide' ? location.section : null);
  set('file', location.tab === 'files' ? location.file : null);
  return url.href;
}
