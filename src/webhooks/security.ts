import { timingSafeEqual } from 'node:crypto';

export function isSecureTransport(request: Request): boolean {
  const url = new URL(request.url);
  if (url.protocol === 'https:') {
    return true;
  }

  const forwardedProto = request.headers.get('x-forwarded-proto')?.toLowerCase();
  if (forwardedProto === 'https') {
    return true;
  }

  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
}

export function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

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
