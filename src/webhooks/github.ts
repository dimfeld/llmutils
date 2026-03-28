import { createHmac, timingSafeEqual } from 'node:crypto';

export function computeGitHubSignature(payload: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(payload).digest('hex');
  return `sha256=${digest}`;
}

export function isValidGitHubSignature(
  payload: string,
  secret: string,
  providedSignature: string | null
): boolean {
  if (!providedSignature) {
    return false;
  }

  const expectedSignature = computeGitHubSignature(payload, secret);
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const providedBuffer = Buffer.from(providedSignature, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}
