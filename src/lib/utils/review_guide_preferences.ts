export const REVIEW_GUIDE_VIRTUALIZATION_STORAGE_KEY = 'tim.reviewGuide.virtualizeDiffs';

export function readReviewGuideVirtualizationPreference(storage: Storage): boolean {
  return storage.getItem(REVIEW_GUIDE_VIRTUALIZATION_STORAGE_KEY) !== 'false';
}

export function writeReviewGuideVirtualizationPreference(storage: Storage, enabled: boolean): void {
  storage.setItem(REVIEW_GUIDE_VIRTUALIZATION_STORAGE_KEY, String(enabled));
}
