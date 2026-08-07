export function extractRemoteErrorMessage(err: unknown): string {
  const body =
    err && typeof err === 'object' && 'body' in err ? (err as { body: unknown }).body : err;
  if (body && typeof body === 'object') {
    const b = body as { message?: unknown };
    if (typeof b.message === 'string') return b.message;
  }
  if (typeof body === 'string') return body;
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
