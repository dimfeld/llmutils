// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    interface Error {
      message: string;
      kind?:
        | 'validation_failed'
        | 'not_found'
        | 'project_mismatch'
        | 'invalid_reference'
        | 'cycle_detected'
        | 'sync_conflict'
        | 'persistence_failed'
        | 'persistence-failed';
      field?: string;
      githubReviewId?: number;
      githubReviewUrl?: string | null;
    }
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}
