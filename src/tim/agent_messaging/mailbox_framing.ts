import { Buffer } from 'node:buffer';
import { MAX_MAILBOX_FRAME_BYTES, MailboxProtocolError } from './mailbox_protocol.js';

export interface MailboxJsonlDecoderOptions {
  /** Maximum encoded frame size, including the newline delimiter. */
  maxFrameBytes?: number;
  /** Maximum complete frames accepted by this connection. */
  maxFrames?: number;
  /** Empty lines are rejected by default instead of silently ignored. */
  rejectEmptyLines?: boolean;
}

/**
 * Decodes bounded UTF-8 JSONL frames without converting partial chunks to
 * strings. A newline is found in bytes first, then the complete line is
 * decoded with fatal UTF-8 validation.
 */
export class MailboxJsonlDecoder {
  private readonly maxFrameBytes: number;
  private readonly maxFrames: number;
  private readonly rejectEmptyLines: boolean;
  private pending: Buffer = Buffer.alloc(0);
  private frameCount: number = 0;
  private closed: boolean = false;

  public constructor(options: MailboxJsonlDecoderOptions = {}) {
    const maxFrameBytes = options.maxFrameBytes ?? MAX_MAILBOX_FRAME_BYTES;
    const maxFrames = options.maxFrames ?? 1;

    if (
      !Number.isSafeInteger(maxFrameBytes) ||
      maxFrameBytes <= 1 ||
      maxFrameBytes > MAX_MAILBOX_FRAME_BYTES
    ) {
      throw new RangeError(
        `maxFrameBytes must be a safe integer from 2 through ${MAX_MAILBOX_FRAME_BYTES}`
      );
    }
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1) {
      throw new RangeError('maxFrames must be a positive safe integer');
    }
    if (options.rejectEmptyLines !== undefined && typeof options.rejectEmptyLines !== 'boolean') {
      throw new TypeError('rejectEmptyLines must be a boolean');
    }

    this.maxFrameBytes = maxFrameBytes;
    this.maxFrames = maxFrames;
    this.rejectEmptyLines = options.rejectEmptyLines ?? true;
  }

  /** Number of bytes retained for the current incomplete frame. */
  public get pendingBytes(): number {
    return this.pending.byteLength;
  }

  /** Number of complete frames emitted by this decoder. */
  public get decodedFrameCount(): number {
    return this.frameCount;
  }

  /**
   * Adds one byte chunk and returns complete UTF-8 lines without delimiters.
   * The decoder enters a failed/closed state if a protocol bound is violated.
   */
  public push(chunk: Uint8Array): string[] {
    this.ensureOpen();

    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('Mailbox JSONL decoder input must be a Uint8Array');
    }

    const lines: string[] = [];
    let segmentStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) {
        continue;
      }

      const segmentLength = index - segmentStart;
      const encodedFrameBytes = this.pending.byteLength + segmentLength + 1;
      if (encodedFrameBytes > this.maxFrameBytes) {
        throw this.fail(
          new MailboxProtocolError(
            'frame_too_large',
            `Mailbox frame must be at most ${this.maxFrameBytes} bytes`
          )
        );
      }

      const lineBytes = this.takeLineBytes(chunk.subarray(segmentStart, index));
      segmentStart = index + 1;

      if (lineBytes.byteLength === 0 && this.rejectEmptyLines) {
        throw this.fail(new MailboxProtocolError('invalid_message', 'Empty mailbox frame'));
      }

      if (this.frameCount >= this.maxFrames) {
        throw this.fail(
          new MailboxProtocolError(
            'unexpected_frame',
            'Mailbox connections accept only the configured number of frames'
          )
        );
      }

      let line: string;
      try {
        line = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes);
      } catch {
        throw this.fail(
          new MailboxProtocolError('invalid_utf8', 'Mailbox frame is not valid UTF-8')
        );
      }

      lines.push(line);
      this.frameCount += 1;
    }

    if (segmentStart < chunk.byteLength) {
      if (this.frameCount >= this.maxFrames) {
        throw this.fail(
          new MailboxProtocolError(
            'unexpected_frame',
            'Mailbox connections accept only the configured number of frames'
          )
        );
      }

      const remainder = chunk.subarray(segmentStart);
      // A partial frame must still have room for its required newline
      // delimiter. Reject it before retaining bytes that can never form a
      // frame within the configured bound.
      if (this.pending.byteLength + remainder.byteLength + 1 > this.maxFrameBytes) {
        throw this.fail(
          new MailboxProtocolError(
            'frame_too_large',
            `Mailbox frame must be at most ${this.maxFrameBytes} bytes`
          )
        );
      }
      this.pending = this.takeLineBytes(remainder);
    }

    return lines;
  }

  /**
   * Marks the connection closed. A non-empty remainder is an incomplete
   * frame, even when its bytes are otherwise valid UTF-8.
   */
  public finish(): void {
    this.ensureOpen();
    this.closed = true;

    if (this.pending.byteLength === 0) {
      return;
    }

    try {
      new TextDecoder('utf-8', { fatal: true }).decode(this.pending);
    } catch {
      this.pending = Buffer.alloc(0);
      throw new MailboxProtocolError('invalid_utf8', 'Mailbox frame is not valid UTF-8');
    }

    this.pending = Buffer.alloc(0);
    throw new MailboxProtocolError(
      'incomplete_frame',
      'Mailbox connection closed before the JSONL frame was complete'
    );
  }

  private takeLineBytes(bytes: Uint8Array): Buffer {
    if (bytes.byteLength === 0 && this.pending.byteLength === 0) {
      return Buffer.alloc(0);
    }

    if (this.pending.byteLength === 0) {
      return Buffer.from(bytes);
    }

    if (bytes.byteLength === 0) {
      const line = this.pending;
      this.pending = Buffer.alloc(0);
      return line;
    }

    const line = Buffer.concat([this.pending, Buffer.from(bytes)]);
    this.pending = Buffer.alloc(0);
    return line;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new MailboxProtocolError('runtime_closed', 'Mailbox frame decoder is closed');
    }
  }

  private fail(error: MailboxProtocolError): MailboxProtocolError {
    this.closed = true;
    this.pending = Buffer.alloc(0);
    return error;
  }
}
