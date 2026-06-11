import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compares two strings in constant time to avoid leaking information through
 * timing side channels. Returns false immediately when lengths differ.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Validates that a request carries the expected bearer token in its
 * Authorization header. Used to gate uploads.
 */
export function hasValidBearerToken(request: Request, expectedToken: string): boolean {
  const header = request.headers.get('authorization');
  if (!header) {
    return false;
  }

  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return false;
  }

  return constantTimeEquals(token, expectedToken);
}

/**
 * Computes the salted hash (HMAC-SHA256) of a file path. The signing secret acts
 * as the salt, so the signature cannot be forged or recomputed without it. The
 * same path always yields the same signature for a given secret, which lets a
 * signed URL be reused for the lifetime of the file.
 *
 * @param relativePath - The canonical, normalized storage-relative path
 * @param secret - The signing secret (salt)
 * @returns A lowercase hex-encoded HMAC digest
 */
export function computePathSignature(relativePath: string, secret: string): string {
  return createHmac('sha256', secret).update(relativePath, 'utf8').digest('hex');
}

/**
 * Verifies that a provided signature matches the expected salted hash of the
 * given path. Comparison is constant time.
 */
export function isValidPathSignature(
  relativePath: string,
  secret: string,
  providedSignature: string | null | undefined
): boolean {
  if (!providedSignature) {
    return false;
  }

  const expected = computePathSignature(relativePath, secret);
  return constantTimeEquals(expected, providedSignature);
}
