import net from 'node:net';

import { debugLog } from '../../logging.js';
import { MailboxJsonlDecoder } from './mailbox_framing.js';
import { isRecord, sanitizeErrorMessage } from './mailbox_helpers.js';
import {
  MailboxProtocolError,
  buildMailboxFailureAcknowledgement,
  encodeMailboxFrame,
  parseMailboxFrame,
  parseMailboxMessageRequest,
  type MailboxAcknowledgement,
  type MailboxMessageRequest,
} from './mailbox_protocol.js';

export interface MailboxConnectionHandlers {
  readonly onRequest: (
    request: MailboxMessageRequest,
    isPeerEnded: () => boolean
  ) => Promise<MailboxAcknowledgement | undefined>;
  readonly onInactive: () => void;
  readonly onClosed: () => void;
}

function recoverRequestId(line: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(value) || typeof value.requestId !== 'string') {
    return undefined;
  }

  try {
    return buildMailboxFailureAcknowledgement(
      value.requestId,
      'invalid_message',
      'Mailbox request failed validation'
    ).requestId;
  } catch {
    return undefined;
  }
}

/** Owns one receiver-side socket, its JSONL framing, FIN state, and reply. */
export class MailboxConnection {
  private readonly socket: net.Socket;
  private readonly handlers: MailboxConnectionHandlers;
  private readonly decoder = new MailboxJsonlDecoder({ maxFrames: 1 });
  private frameReceived = false;
  private peerEnded = false;
  private responseSent = false;

  public constructor(socket: net.Socket, handlers: MailboxConnectionHandlers) {
    this.socket = socket;
    this.handlers = handlers;
  }

  public start(): void {
    this.socket.setNoDelay(true);
    this.socket.on('data', (chunk: Buffer) => {
      this.handleData(chunk);
    });
    this.socket.on('end', () => {
      this.handleEnd();
    });
    this.socket.on('error', (error: Error) => {
      debugLog('[agent mailbox] client socket error:', error);
    });
    this.socket.on('close', () => {
      this.handlers.onClosed();
    });
  }

  private handleData(chunk: Buffer): void {
    if (this.peerEnded) {
      this.socket.destroy();
      return;
    }
    if (this.responseSent || this.frameReceived) {
      // The first complete frame owns the connection. Ignore later chunks so
      // they cannot cancel an acknowledgement for an accepted request.
      return;
    }

    let lines: string[];
    try {
      lines = this.decoder.push(chunk);
    } catch (error) {
      this.frameReceived = true;
      void this.sendProtocolFailure(error);
      return;
    }
    if (lines.length === 0) {
      return;
    }

    this.frameReceived = true;
    // Bun can defer the peer FIN event until the data handler returns. The
    // next turn lets handleEnd win before delivery when the peer half-closes.
    setImmediate(() => {
      void this.processLine(lines[0] as string);
    });
  }

  private handleEnd(): void {
    this.peerEnded = true;
    this.handlers.onInactive();
    if (this.frameReceived || this.responseSent) {
      if (!this.responseSent && !this.socket.destroyed) {
        this.socket.destroy();
      }
      return;
    }

    let error: unknown;
    try {
      this.decoder.finish();
      error = new MailboxProtocolError(
        'incomplete_frame',
        'Mailbox connection closed without one complete request frame'
      );
    } catch (finishError) {
      error = finishError;
    }
    this.frameReceived = true;
    void this.sendProtocolFailure(error);
  }

  private async processLine(line: string): Promise<void> {
    let request: MailboxMessageRequest;
    try {
      const frame = parseMailboxFrame(line);
      request = parseMailboxMessageRequest(frame);
    } catch (error) {
      await this.sendProtocolFailure(error, recoverRequestId(line));
      return;
    }

    if (this.peerEnded) {
      return;
    }

    let acknowledgement: MailboxAcknowledgement | undefined;
    try {
      acknowledgement = await this.handlers.onRequest(request, () => this.peerEnded);
    } catch (error) {
      acknowledgement = buildMailboxFailureAcknowledgement(
        request.requestId,
        'connection_failed',
        `Mailbox delivery failed: ${sanitizeErrorMessage(error, 'delivery callback failed')}`
      );
    }
    if (acknowledgement !== undefined) {
      await this.sendAcknowledgement(acknowledgement);
    } else if (!this.peerEnded && !this.socket.destroyed) {
      this.socket.destroy();
    }
  }

  private async sendProtocolFailure(error: unknown, requestId?: string): Promise<void> {
    if (this.peerEnded) {
      this.socket.destroy();
      return;
    }
    if (requestId === undefined) {
      this.socket.end();
      return;
    }

    const code = error instanceof MailboxProtocolError ? error.code : 'invalid_message';
    const acknowledgement = buildMailboxFailureAcknowledgement(
      requestId,
      code,
      sanitizeErrorMessage(error, 'Mailbox request failed')
    );
    await this.sendAcknowledgement(acknowledgement);
  }

  private async sendAcknowledgement(acknowledgement: MailboxAcknowledgement): Promise<void> {
    if (this.peerEnded || this.responseSent) {
      if (this.peerEnded && !this.responseSent && !this.socket.destroyed) {
        this.socket.destroy();
      }
      return;
    }
    this.responseSent = true;
    let encoded: string;
    try {
      encoded = encodeMailboxFrame(acknowledgement);
    } catch (error) {
      debugLog('[agent mailbox] failed to encode acknowledgement:', error);
      this.socket.destroy();
      return;
    }
    if (this.socket.destroyed) {
      this.handlers.onInactive();
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.handlers.onInactive();
        resolve();
      };
      this.socket.once('error', (error: Error) => {
        debugLog('[agent mailbox] acknowledgement write failed:', error);
        if (!this.socket.destroyed) {
          this.socket.destroy();
        }
        finish();
      });
      this.socket.end(encoded, finish);
    });
  }
}
