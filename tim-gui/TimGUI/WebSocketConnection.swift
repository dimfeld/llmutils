import CryptoKit
import Foundation
import Network

/// WebSocket opcodes per RFC 6455
private enum WSOpcode: UInt8 {
    case continuation = 0x0
    case text = 0x1
    case binary = 0x2
    case close = 0x8
    case ping = 0x9
    case pong = 0xA
}

/// Manages a single WebSocket connection after the HTTP upgrade handshake.
final class WebSocketConnection: @unchecked Sendable {
    private static let maxFrameSize: UInt64 = 16 * 1024 * 1024  // 16 MB max

    let id: UUID
    private let connection: NWConnection
    private let onMessage: @Sendable (String) -> Void
    private let onDisconnect: @Sendable () -> Void
    private let closeLock = NSLock()
    private var _isClosed = false

    /// Buffer for fragmented messages (continuation frames).
    private var fragmentBuffer = Data()
    private var fragmentOpcode: WSOpcode?

    /// Leftover bytes from the HTTP request read buffer, consumed before issuing new receive calls.
    private var readBuffer: Data

    /// Atomically transitions isClosed from false to true. Returns true if this call performed the transition.
    private nonisolated func markClosed() -> Bool {
        closeLock.lock()
        defer { closeLock.unlock() }
        if _isClosed { return false }
        _isClosed = true
        return true
    }

    init(
        id: UUID,
        connection: NWConnection,
        initialBuffer: Data = Data(),
        onMessage: @escaping @Sendable (String) -> Void,
        onDisconnect: @escaping @Sendable () -> Void
    ) {
        self.id = id
        self.connection = connection
        self.readBuffer = initialBuffer
        self.onMessage = onMessage
        self.onDisconnect = onDisconnect
    }

    // MARK: - Upgrade Handshake

    /// Performs the WebSocket upgrade handshake by sending the 101 response.
    func performUpgrade(key: String) async throws {
        let acceptKey = computeAcceptKey(key)
        let response = [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Accept: \(acceptKey)",
            "", "",
        ].joined(separator: "\r\n")

        try await send(data: Data(response.utf8))
    }

    private func computeAcceptKey(_ key: String) -> String {
        let magic = "258EAFA5-E914-47DA-95CA-5AB5F7FC6835"
        let combined = key + magic
        let hash = Insecure.SHA1.hash(data: Data(combined.utf8))
        return Data(hash).base64EncodedString()
    }

    // MARK: - Frame Reading

    /// Starts the read loop for incoming WebSocket frames.
    func startReading() {
        Task {
            do {
                try await readLoop()
            } catch {
                // Connection dropped or error
            }
            if markClosed() {
                connection.cancel()
                onDisconnect()
            }
        }
    }

    private nonisolated var isClosedSafe: Bool {
        closeLock.lock()
        defer { closeLock.unlock() }
        return _isClosed
    }

    private func readLoop() async throws {
        while !isClosedSafe {
            // Read the 2-byte header
            let headerBytes = try await readExact(count: 2)
            let byte0 = headerBytes[0]
            let byte1 = headerBytes[1]

            let fin = (byte0 & 0x80) != 0
            let opcodeRaw = byte0 & 0x0F
            let masked = (byte1 & 0x80) != 0
            var payloadLength = UInt64(byte1 & 0x7F)

            // Extended payload length
            if payloadLength == 126 {
                let extBytes = try await readExact(count: 2)
                payloadLength = UInt64(extBytes[0]) << 8 | UInt64(extBytes[1])
            } else if payloadLength == 127 {
                let extBytes = try await readExact(count: 8)
                payloadLength = 0
                for i in 0..<8 {
                    payloadLength = (payloadLength << 8) | UInt64(extBytes[i])
                }
            }

            // Validate payload length before allocating memory
            guard payloadLength <= WebSocketConnection.maxFrameSize else {
                try? await sendCloseFrame(code: 1009)
                close()
                return
            }

            // Read mask key (clients always send masked frames)
            var maskKey = Data()
            if masked {
                maskKey = try await readExact(count: 4)
            }

            // Read payload
            var payload = payloadLength > 0
                ? try await readExact(count: Int(payloadLength))
                : Data()

            // Unmask payload
            if masked && !payload.isEmpty {
                for i in 0..<payload.count {
                    payload[i] ^= maskKey[i % 4]
                }
            }

            guard let opcode = WSOpcode(rawValue: opcodeRaw) else {
                // Unknown opcode, skip
                continue
            }

            switch opcode {
            case .text, .binary:
                if fin {
                    // Complete single-frame message
                    if let text = String(data: payload, encoding: .utf8) {
                        onMessage(text)
                    }
                } else {
                    // Start of fragmented message
                    fragmentOpcode = opcode
                    fragmentBuffer = payload
                }

            case .continuation:
                fragmentBuffer.append(payload)
                if fin {
                    // End of fragmented message
                    if let text = String(data: fragmentBuffer, encoding: .utf8) {
                        onMessage(text)
                    }
                    fragmentBuffer = Data()
                    fragmentOpcode = nil
                }

            case .close:
                // Send close frame back
                try? await sendFrame(opcode: .close, payload: payload)
                if markClosed() {
                    connection.cancel()
                    onDisconnect()
                }
                return

            case .ping:
                // Respond with pong
                try? await sendFrame(opcode: .pong, payload: payload)

            case .pong:
                // Ignore
                break
            }
        }
    }

    // MARK: - Frame Writing

    /// Sends a text frame to the client.
    func sendText(_ text: String) async throws {
        try await sendFrame(opcode: .text, payload: Data(text.utf8))
    }

    /// Sends a close frame and cancels the connection.
    func close() {
        if markClosed() {
            Task {
                try? await sendFrame(opcode: .close, payload: Data())
                connection.cancel()
                onDisconnect()
            }
        }
    }

    private func sendCloseFrame(code: UInt16) async throws {
        var payload = Data()
        payload.append(UInt8((code >> 8) & 0xFF))
        payload.append(UInt8(code & 0xFF))
        try await sendFrame(opcode: .close, payload: payload)
    }

    private func sendFrame(opcode: WSOpcode, payload: Data) async throws {
        var frame = Data()

        // Byte 0: FIN=1 + opcode
        frame.append(0x80 | opcode.rawValue)

        // Byte 1: MASK=0 + payload length (server doesn't mask)
        let length = payload.count
        if length < 126 {
            frame.append(UInt8(length))
        } else if length < 65536 {
            frame.append(126)
            frame.append(UInt8((length >> 8) & 0xFF))
            frame.append(UInt8(length & 0xFF))
        } else {
            frame.append(127)
            for i in stride(from: 56, through: 0, by: -8) {
                frame.append(UInt8((length >> i) & 0xFF))
            }
        }

        frame.append(payload)
        try await send(data: frame)
    }

    // MARK: - Low-level IO

    private func readExact(count: Int) async throws -> Data {
        var buffer = Data()
        // Consume from leftover HTTP read buffer first
        if !readBuffer.isEmpty {
            let toConsume = min(readBuffer.count, count)
            buffer.append(readBuffer.prefix(toConsume))
            readBuffer.removeFirst(toConsume)
        }
        while buffer.count < count {
            let remaining = count - buffer.count
            let chunk = try await receiveChunk(maxLength: remaining)
            if chunk.isEmpty {
                throw WebSocketError.connectionClosed
            }
            buffer.append(chunk)
        }
        return buffer
    }

    private func receiveChunk(maxLength: Int) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            connection.receive(minimumIncompleteLength: 1, maximumLength: maxLength) {
                data, _, _, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: data ?? Data())
            }
        }
    }

    private func send(data: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }
}

enum WebSocketError: Error {
    case connectionClosed
}
