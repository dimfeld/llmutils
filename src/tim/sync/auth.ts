import { createHash, timingSafeEqual } from 'node:crypto';
import type { SyncAllowedNodeConfig } from '../configSchema.js';

export type NodeTokenVerificationResult =
  | { ok: true; label?: string }
  | {
      ok: false;
      reason: 'unknown_node' | 'missing_token' | 'missing_token_env' | 'token_mismatch';
    };

const DUMMY_TOKEN_HASH = '0'.repeat(64);

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').toLowerCase();
}

function safeHexCompare(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex.toLowerCase(), 'hex');
  const right = Buffer.from(rightHex.toLowerCase(), 'hex');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function verifyNodeToken({
  nodeId,
  presentedToken,
  allowedNodes,
}: {
  nodeId: string;
  presentedToken: string | null | undefined;
  allowedNodes: SyncAllowedNodeConfig[];
}): NodeTokenVerificationResult {
  if (!presentedToken) {
    return { ok: false, reason: 'missing_token' };
  }

  const presentedHash = hashToken(presentedToken);
  const allowedNode = allowedNodes.find((node) => node.nodeId === nodeId);
  if (!allowedNode) {
    safeHexCompare(presentedHash, DUMMY_TOKEN_HASH);
    return { ok: false, reason: 'unknown_node' };
  }

  let expectedHash = allowedNode.tokenHash?.toLowerCase();
  if (!expectedHash && allowedNode.tokenEnv) {
    const envToken = process.env[allowedNode.tokenEnv];
    if (!envToken) {
      safeHexCompare(presentedHash, DUMMY_TOKEN_HASH);
      return { ok: false, reason: 'missing_token_env' };
    }
    expectedHash = hashToken(envToken);
  }

  if (!expectedHash || !safeHexCompare(presentedHash, expectedHash)) {
    return { ok: false, reason: 'token_mismatch' };
  }

  return allowedNode.label ? { ok: true, label: allowedNode.label } : { ok: true };
}
