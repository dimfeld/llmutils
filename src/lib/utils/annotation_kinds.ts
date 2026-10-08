import type { ReviewAnnotationKind } from '$tim/db/review.js';

export interface AnnotationKindStyle {
  label: string;
  /** Short description shown as a tooltip. */
  description: string;
  /** Accent color for the icon and border. */
  color: string;
}

export const ANNOTATION_KIND_ORDER: ReviewAnnotationKind[] = [
  'behavior-change',
  'verify',
  'question',
  'why',
  'note',
];

export const ANNOTATION_KIND_STYLES: Record<ReviewAnnotationKind, AnnotationKindStyle> = {
  why: {
    label: 'Why',
    description: 'The reason for a choice that is not obvious from the code',
    color: '#0d9488',
  },
  'behavior-change': {
    label: 'Behavior change',
    description: 'Existing callers or users see different behavior here',
    color: '#c2410c',
  },
  verify: {
    label: 'Verify',
    description: 'Something the reviewer should confirm',
    color: '#7c3aed',
  },
  question: {
    label: 'Question',
    description: 'An open question for the author',
    color: '#2563eb',
  },
  note: {
    label: 'Note',
    description: 'Other helpful context',
    color: '#64748b',
  },
};

/** Annotation kind of a note issue; notes from older guides have no kind. */
export function noteKind(kind: ReviewAnnotationKind | null | undefined): ReviewAnnotationKind {
  return kind ?? 'note';
}
