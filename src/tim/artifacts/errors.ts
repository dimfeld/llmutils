import { MAX_ARTIFACT_BYTES } from './constants.js';

export class ArtifactTooLargeError extends Error {
  constructor(size: number, maxBytes: number = MAX_ARTIFACT_BYTES) {
    super(`Artifact file is too large: ${size} bytes exceeds ${maxBytes} bytes`);
    this.name = 'ArtifactTooLargeError';
    this.size = size;
    this.maxBytes = maxBytes;
  }

  size: number;
  maxBytes: number;
}
