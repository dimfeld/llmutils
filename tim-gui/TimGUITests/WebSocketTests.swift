import CryptoKit
import Foundation
import Network
import Testing

@testable import TimGUI

@Suite("WebSocket Integration")
struct WebSocketTests {
    /// Creates a raw TCP connection to the server and sends a WebSocket upgrade request.
    /// Returns the raw TCP NWConnection and the received upgrade response.
    private static func connectAndUpgrade(port: UInt16) async throws -> (NWConnection, String) {
        let connection = NWConnection(
            host: "127.0.0.1",
            port: NWEndpoint.Port(rawValue: port)!,
            using: .tcp
        )

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    continuation.resume()
                case .failed(let error):
                    continuation.resume(throwing: error)
                default:
                    break
                }
            }
            connection.start(queue: .global())
        }
        connection.stateUpdateHandler = nil

        // Send WebSocket upgrade request
        let key = "dGhlIHNhbXBsZSBub25jZQ=="  // standard test key
        let upgradeRequest = [
            "GET /tim-agent HTTP/1.1",
            "Host: 127.0.0.1:\(port)",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: \(key)",
            "Sec-WebSocket-Version: 13",
            "", "",
        ].joined(separator: "\r\n")

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(
                content: Data(upgradeRequest.utf8),
                completion: .contentProcessed { error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume()
                    }
                })
        }

        // Read the upgrade response
        let responseData: Data = try await withCheckedThrowingContinuation { continuation in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) {
                data, _, _, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: data ?? Data())
                }
            }
        }

        let response = String(decoding: responseData, as: UTF8.self)
        return (connection, response)
    }

    /// Sends a masked WebSocket text frame (client -> server frames must be masked per RFC 6455).
    private static func sendTextFrame(
        _ text: String, on connection: NWConnection
    ) async throws {
        let payload = Data(text.utf8)
        var frame = Data()

        // Byte 0: FIN=1, opcode=0x1 (text)
        frame.append(0x81)

        // Byte 1: MASK=1 + payload length
        let length = payload.count
        if length < 126 {
            frame.append(UInt8(length) | 0x80)
        } else if length < 65536 {
            frame.append(126 | 0x80)
            frame.append(UInt8((length >> 8) & 0xFF))
            frame.append(UInt8(length & 0xFF))
        } else {
            frame.append(127 | 0x80)
            for i in stride(from: 56, through: 0, by: -8) {
                frame.append(UInt8((length >> i) & 0xFF))
            }
        }

        // 4-byte masking key
        let maskKey: [UInt8] = [0x37, 0xFA, 0x21, 0x3D]
        frame.append(contentsOf: maskKey)

        // Masked payload
        for (i, byte) in payload.enumerated() {
            frame.append(byte ^ maskKey[i % 4])
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: frame, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }

    /// Sends a masked WebSocket close frame.
    private static func sendCloseFrame(on connection: NWConnection) async throws {
        var frame = Data()
        // FIN=1, opcode=0x8 (close)
        frame.append(0x88)
        // MASK=1, length=0
        frame.append(0x80)
        // Empty mask key
        frame.append(contentsOf: [UInt8](repeating: 0, count: 4))

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: frame, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }

    /// Sends a raw masked WebSocket frame with the given FIN bit, opcode, and payload.
    private static func sendRawFrame(
        fin: Bool, opcode: UInt8, payload: Data, on connection: NWConnection
    ) async throws {
        var frame = Data()

        // Byte 0: FIN bit + opcode
        frame.append((fin ? 0x80 : 0x00) | (opcode & 0x0F))

        // Byte 1: MASK=1 + payload length
        let length = payload.count
        if length < 126 {
            frame.append(UInt8(length) | 0x80)
        } else if length < 65536 {
            frame.append(126 | 0x80)
            frame.append(UInt8((length >> 8) & 0xFF))
            frame.append(UInt8(length & 0xFF))
        } else {
            frame.append(127 | 0x80)
            for i in stride(from: 56, through: 0, by: -8) {
                frame.append(UInt8((length >> i) & 0xFF))
            }
        }

        // 4-byte masking key
        let maskKey: [UInt8] = [0x37, 0xFA, 0x21, 0x3D]
        frame.append(contentsOf: maskKey)

        // Masked payload
        for (i, byte) in payload.enumerated() {
            frame.append(byte ^ maskKey[i % 4])
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: frame, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }

    /// Sends a raw masked WebSocket frame header that claims a large payload length,
    /// but without actually sending that much data. Used for oversize frame rejection tests.
    private static func sendOversizeFrameHeader(
        opcode: UInt8, claimedLength: UInt64, on connection: NWConnection
    ) async throws {
        var frame = Data()

        // Byte 0: FIN=1 + opcode
        frame.append(0x80 | (opcode & 0x0F))

        // Byte 1: MASK=1 + 127 (64-bit extended length)
        frame.append(127 | 0x80)

        // 8-byte extended length
        for i in stride(from: 56, through: 0, by: -8) {
            frame.append(UInt8((claimedLength >> i) & 0xFF))
        }

        // 4-byte masking key
        frame.append(contentsOf: [0x37, 0xFA, 0x21, 0x3D] as [UInt8])

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: frame, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }

    /// Parsed server WebSocket frame (server frames are NOT masked).
    private struct ServerFrame {
        let fin: Bool
        let opcode: UInt8
        let payload: Data
    }

    /// Reads and parses a single WebSocket frame sent by the server (unmasked).
    private static func readServerFrame(
        on connection: NWConnection, timeout: Duration = .seconds(2)
    ) async throws -> ServerFrame {
        try await withThrowingTaskGroup(of: ServerFrame.self) { group in
            group.addTask {
                // Read 2-byte header
                let header = try await readBytes(count: 2, on: connection)
                let byte0 = header[0]
                let byte1 = header[1]

                let fin = (byte0 & 0x80) != 0
                let opcode = byte0 & 0x0F
                var payloadLength = UInt64(byte1 & 0x7F)

                // Extended payload length
                if payloadLength == 126 {
                    let ext = try await readBytes(count: 2, on: connection)
                    payloadLength = UInt64(ext[0]) << 8 | UInt64(ext[1])
                } else if payloadLength == 127 {
                    let ext = try await readBytes(count: 8, on: connection)
                    payloadLength = 0
                    for i in 0..<8 {
                        payloadLength = (payloadLength << 8) | UInt64(ext[i])
                    }
                }

                // Server frames are NOT masked (mask bit should be 0)
                let payload =
                    payloadLength > 0
                    ? try await readBytes(count: Int(payloadLength), on: connection)
                    : Data()

                return ServerFrame(fin: fin, opcode: opcode, payload: payload)
            }

            group.addTask {
                try await Task.sleep(for: timeout)
                throw TimeoutError()
            }

            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }

    private struct TimeoutError: Error {}

    /// Reads exactly `count` bytes from the connection.
    private static func readBytes(count: Int, on connection: NWConnection) async throws -> Data {
        var buffer = Data()
        while buffer.count < count {
            let remaining = count - buffer.count
            let chunk: Data = try await withCheckedThrowingContinuation { continuation in
                connection.receive(minimumIncompleteLength: 1, maximumLength: remaining) {
                    data, _, _, error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(returning: data ?? Data())
                    }
                }
            }
            if chunk.isEmpty {
                throw WebSocketError.connectionClosed
            }
            buffer.append(chunk)
        }
        return buffer
    }

    // MARK: - Tests

    @Test("WebSocket upgrade returns 101 with correct accept key")
    func upgradeReturns101() async throws {
        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { _ in })
        try await server.start()
        defer { server.stop() }

        let (connection, response) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        #expect(response.contains("HTTP/1.1 101 Switching Protocols"))
        #expect(response.contains("Upgrade: websocket"))
        #expect(response.contains("Connection: Upgrade"))

        // Verify the accept key is correct per RFC 6455
        let key = "dGhlIHNhbXBsZSBub25jZQ=="
        let magic = "258EAFA5-E914-47DA-95CA-5AB5F7FC6835"
        let hash = Insecure.SHA1.hash(data: Data((key + magic).utf8))
        let expectedAccept = Data(hash).base64EncodedString()
        #expect(response.contains("Sec-WebSocket-Accept: \(expectedAccept)"))
    }

    @Test("WebSocket session_info dispatches sessionInfo event")
    func sessionInfoEvent() async throws {
        let received = LockIsolated<WebSocketEvent?>(nil)

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            received.withLock { $0 = event }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        let sessionInfoJson = """
            {"type":"session_info","command":"agent","planId":42,"planTitle":"Test Plan","workspacePath":"/tmp/ws"}
            """
        try await Self.sendTextFrame(sessionInfoJson, on: connection)

        // Wait for the message to be processed
        try await Task.sleep(for: .milliseconds(200))

        let event = received.withLock { $0 }
        guard case .sessionInfo(_, let info) = event else {
            Issue.record("Expected sessionInfo event, got \(String(describing: event))")
            return
        }
        #expect(info.command == "agent")
        #expect(info.planId == 42)
        #expect(info.planTitle == "Test Plan")
        #expect(info.workspacePath == "/tmp/ws")
    }

    @Test("WebSocket output message dispatches output event")
    func outputEvent() async throws {
        let received = LockIsolated<[WebSocketEvent]>([])

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            received.withLock { $0.append(event) }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send session_info first
        try await Self.sendTextFrame(
            """
            {"type":"session_info","command":"agent"}
            """, on: connection)

        // Then send an output message
        let outputJson = """
            {"type":"output","seq":1,"message":{"type":"log","args":["hello","world"]}}
            """
        try await Self.sendTextFrame(outputJson, on: connection)

        try await Task.sleep(for: .milliseconds(200))

        let events = received.withLock { $0 }
        #expect(events.count == 2)

        guard case .output(_, let seq, let tunnelMsg) = events[1] else {
            Issue.record("Expected output event, got \(events[1])")
            return
        }
        #expect(seq == 1)
        guard case .args(let type, let args) = tunnelMsg else {
            Issue.record("Expected args tunnel message")
            return
        }
        #expect(type == "log")
        #expect(args == ["hello", "world"])
    }

    @Test("WebSocket disconnect dispatches disconnected event")
    func disconnectEvent() async throws {
        let received = LockIsolated<[WebSocketEvent]>([])

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            received.withLock { $0.append(event) }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)

        // Send close frame
        try await Self.sendCloseFrame(on: connection)

        try await Task.sleep(for: .milliseconds(300))
        connection.cancel()

        let events = received.withLock { $0 }
        let hasDisconnect = events.contains { event in
            if case .disconnected = event { return true }
            return false
        }
        #expect(hasDisconnect, "Expected a disconnected event")
    }

    @Test("HTTP POST /messages still works alongside WebSocket")
    func httpStillWorks() async throws {
        let httpReceived = LockIsolated<MessagePayload?>(nil)

        let server = LocalHTTPServer(
            port: 0,
            handler: { @MainActor payload in
                httpReceived.withLock { $0 = payload }
            },
            wsHandler: { _ in }
        )
        try await server.start()
        defer { server.stop() }

        // First make a WebSocket connection to ensure both protocols coexist
        let (wsConnection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { wsConnection.cancel() }

        // Now make an HTTP POST request
        let url = URL(string: "http://127.0.0.1:\(server.boundPort)/messages")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("""
            {"message":"test notification","workspacePath":"/tmp/project"}
            """.utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        let httpResponse = try #require(response as? HTTPURLResponse)
        #expect(httpResponse.statusCode == 200)

        let body = try JSONSerialization.jsonObject(with: data) as? [String: String]
        #expect(body?["status"] == "ok")

        let payload = httpReceived.withLock { $0 }
        let p = try #require(payload)
        #expect(p.message == "test notification")
    }

    @Test("WebSocket replay_start and replay_end dispatch correct events")
    func replayEvents() async throws {
        let received = LockIsolated<[WebSocketEvent]>([])

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            received.withLock { $0.append(event) }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        try await Self.sendTextFrame(
            """
            {"type":"session_info","command":"agent"}
            """, on: connection)

        try await Self.sendTextFrame(
            """
            {"type":"replay_start"}
            """, on: connection)

        try await Self.sendTextFrame(
            """
            {"type":"output","seq":1,"message":{"type":"log","args":["replayed msg"]}}
            """, on: connection)

        try await Self.sendTextFrame(
            """
            {"type":"replay_end"}
            """, on: connection)

        try await Task.sleep(for: .milliseconds(300))

        let events = received.withLock { $0 }
        #expect(events.count == 4)

        guard case .sessionInfo = events[0] else {
            Issue.record("Expected sessionInfo, got \(events[0])")
            return
        }
        guard case .replayStart = events[1] else {
            Issue.record("Expected replayStart, got \(events[1])")
            return
        }
        guard case .output = events[2] else {
            Issue.record("Expected output, got \(events[2])")
            return
        }
        guard case .replayEnd = events[3] else {
            Issue.record("Expected replayEnd, got \(events[3])")
            return
        }
    }

    @Test("Multiple WebSocket connections get different connection IDs")
    func multipleConnections() async throws {
        let connectionIds = LockIsolated<Set<UUID>>([])

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            switch event {
            case .sessionInfo(let id, _):
                connectionIds.withLock { $0.insert(id) }
            default:
                break
            }
        })
        try await server.start()
        defer { server.stop() }

        // Connect two WebSocket clients
        let (conn1, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { conn1.cancel() }
        let (conn2, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { conn2.cancel() }

        // Send session_info on each
        try await Self.sendTextFrame(
            """
            {"type":"session_info","command":"agent"}
            """, on: conn1)
        try await Self.sendTextFrame(
            """
            {"type":"session_info","command":"review"}
            """, on: conn2)

        try await Task.sleep(for: .milliseconds(300))

        let ids = connectionIds.withLock { $0 }
        #expect(ids.count == 2, "Expected 2 distinct connection IDs, got \(ids.count)")
    }

    @Test("WebSocket handles structured output message")
    func structuredOutputEvent() async throws {
        let received = LockIsolated<[WebSocketEvent]>([])

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            received.withLock { $0.append(event) }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        try await Self.sendTextFrame(
            """
            {"type":"session_info","command":"agent"}
            """, on: connection)

        try await Self.sendTextFrame(
            """
            {"type":"output","seq":1,"message":{"type":"structured","message":{"type":"agent_session_start","executor":"claude","mode":"agent","timestamp":"2026-02-10T08:00:00Z"}}}
            """, on: connection)

        try await Task.sleep(for: .milliseconds(200))

        let events = received.withLock { $0 }
        #expect(events.count == 2)

        guard case .output(_, let seq, let tunnelMsg) = events[1] else {
            Issue.record("Expected output event")
            return
        }
        #expect(seq == 1)
        guard case .structured(let structured) = tunnelMsg else {
            Issue.record("Expected structured tunnel message")
            return
        }
        guard case .agentSessionStart(let p) = structured else {
            Issue.record("Expected agentSessionStart, got \(structured)")
            return
        }
        #expect(p.executor == "claude")
        #expect(p.mode == "agent")
    }

    // MARK: - Fragmented Message Tests

    @Test("Fragmented text message is reassembled correctly")
    func fragmentedTextReassembly() async throws {
        let received = LockIsolated<[WebSocketEvent]>([])

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            received.withLock { $0.append(event) }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send session_info first so we can verify the fragmented message arrives
        try await Self.sendTextFrame(
            """
            {"type":"session_info","command":"agent"}
            """, on: connection)

        try await Task.sleep(for: .milliseconds(100))

        // Send a JSON message fragmented across 3 frames:
        // Frame 1: FIN=0, opcode=text (0x1) — start of fragment
        // Frame 2: FIN=0, opcode=continuation (0x0)
        // Frame 3: FIN=1, opcode=continuation (0x0) — end of fragment
        let fullMessage = """
            {"type":"output","seq":1,"message":{"type":"log","args":["fragmented","message"]}}
            """
        let messageBytes = Data(fullMessage.utf8)
        let chunkSize = messageBytes.count / 3
        let chunk1 = messageBytes[0..<chunkSize]
        let chunk2 = messageBytes[chunkSize..<(chunkSize * 2)]
        let chunk3 = messageBytes[(chunkSize * 2)...]

        // First fragment: FIN=0, opcode=text
        try await Self.sendRawFrame(
            fin: false, opcode: 0x1, payload: Data(chunk1), on: connection)
        // Continuation: FIN=0, opcode=continuation
        try await Self.sendRawFrame(
            fin: false, opcode: 0x0, payload: Data(chunk2), on: connection)
        // Final continuation: FIN=1, opcode=continuation
        try await Self.sendRawFrame(
            fin: true, opcode: 0x0, payload: Data(chunk3), on: connection)

        try await Task.sleep(for: .milliseconds(300))

        let events = received.withLock { $0 }
        // Should have sessionInfo + the reassembled output message
        #expect(events.count == 2, "Expected 2 events (sessionInfo + output), got \(events.count)")

        guard case .output(_, let seq, let tunnelMsg) = events[1] else {
            Issue.record("Expected output event, got \(events[1])")
            return
        }
        #expect(seq == 1)
        guard case .args(let type, let args) = tunnelMsg else {
            Issue.record("Expected args tunnel message")
            return
        }
        #expect(type == "log")
        #expect(args == ["fragmented", "message"])
    }

    // MARK: - Ping/Pong Tests

    @Test("Server responds to ping with pong containing same payload")
    func pingPong() async throws {
        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { _ in })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send a ping frame (opcode 0x9) with a payload
        let pingPayload = Data("ping-test".utf8)
        try await Self.sendRawFrame(
            fin: true, opcode: 0x9, payload: pingPayload, on: connection)

        // Read the pong response
        let pongFrame = try await Self.readServerFrame(on: connection)

        #expect(pongFrame.fin == true, "Pong frame should have FIN=1")
        #expect(pongFrame.opcode == 0xA, "Expected pong opcode (0xA), got 0x\(String(pongFrame.opcode, radix: 16))")
        #expect(pongFrame.payload == pingPayload, "Pong payload should match ping payload")
    }

    @Test("Server responds to ping with empty payload")
    func pingPongEmptyPayload() async throws {
        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { _ in })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send a ping frame with no payload
        try await Self.sendRawFrame(
            fin: true, opcode: 0x9, payload: Data(), on: connection)

        // Read the pong response
        let pongFrame = try await Self.readServerFrame(on: connection)

        #expect(pongFrame.opcode == 0xA, "Expected pong opcode")
        #expect(pongFrame.payload.isEmpty, "Pong payload should be empty for empty ping")
    }

    // MARK: - Close Handshake Tests

    @Test("Server echoes close frame back before disconnecting")
    func closeHandshake() async throws {
        let disconnected = LockIsolated(false)

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            if case .disconnected = event {
                disconnected.withLock { $0 = true }
            }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send a close frame with status code 1000 (normal closure)
        var closePayload = Data()
        closePayload.append(UInt8((1000 >> 8) & 0xFF))
        closePayload.append(UInt8(1000 & 0xFF))
        try await Self.sendRawFrame(
            fin: true, opcode: 0x8, payload: closePayload, on: connection)

        // Read the close frame response from server
        let closeFrame = try await Self.readServerFrame(on: connection)

        #expect(closeFrame.opcode == 0x8, "Expected close opcode (0x8), got 0x\(String(closeFrame.opcode, radix: 16))")
        // Server should echo back the close payload (status code)
        #expect(closeFrame.payload.count >= 2, "Close frame should contain status code")
        if closeFrame.payload.count >= 2 {
            let statusCode = UInt16(closeFrame.payload[0]) << 8 | UInt16(closeFrame.payload[1])
            #expect(statusCode == 1000, "Expected close status 1000, got \(statusCode)")
        }

        // Verify disconnect event fires
        try await Task.sleep(for: .milliseconds(300))
        let didDisconnect = disconnected.withLock { $0 }
        #expect(didDisconnect, "Expected disconnect event after close handshake")
    }

    // MARK: - Oversize Frame Tests

    @Test("Oversize fragmented message is rejected with 1009 close and disconnect")
    func oversizeFragmentRejection() async throws {
        let disconnected = LockIsolated(false)

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            if case .disconnected = event {
                disconnected.withLock { $0 = true }
            }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send fragments that together exceed 16MB limit
        // First fragment: 8MB
        let chunk = Data(repeating: 0x41, count: 8 * 1024 * 1024)
        try await Self.sendRawFrame(
            fin: false, opcode: 0x1, payload: chunk, on: connection)

        // Second fragment: another 9MB, pushing total over 16MB
        let chunk2 = Data(repeating: 0x42, count: 9 * 1024 * 1024)
        try await Self.sendRawFrame(
            fin: false, opcode: 0x0, payload: chunk2, on: connection)

        // The server should send a 1009 close frame and disconnect
        do {
            let closeFrame = try await Self.readServerFrame(on: connection, timeout: .seconds(5))
            #expect(closeFrame.opcode == 0x8, "Expected close opcode for oversize fragment rejection")
            if closeFrame.payload.count >= 2 {
                let statusCode =
                    UInt16(closeFrame.payload[0]) << 8 | UInt16(closeFrame.payload[1])
                #expect(statusCode == 1009, "Expected close status 1009 (message too big), got \(statusCode)")
            }
        } catch {
            // Connection may have been cancelled before we could read the close frame.
        }

        try await Task.sleep(for: .milliseconds(500))
        let didDisconnect = disconnected.withLock { $0 }
        #expect(didDisconnect, "Expected disconnect event after oversize fragment rejection")
    }

    // MARK: - Leftover Buffer Tests

    @Test("WebSocket upgrade with immediate frame in same TCP segment")
    func upgradeWithImmediateFrame() async throws {
        let received = LockIsolated<[WebSocketEvent]>([])

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            received.withLock { $0.append(event) }
        })
        try await server.start()
        defer { server.stop() }

        // Connect raw TCP
        let connection = NWConnection(
            host: "127.0.0.1",
            port: NWEndpoint.Port(rawValue: server.boundPort)!,
            using: .tcp
        )
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: continuation.resume()
                case .failed(let error): continuation.resume(throwing: error)
                default: break
                }
            }
            connection.start(queue: .global())
        }
        connection.stateUpdateHandler = nil
        defer { connection.cancel() }

        // Build the upgrade request + a masked text frame as one combined buffer
        let key = "dGhlIHNhbXBsZSBub25jZQ=="
        let upgradeRequest = [
            "GET /tim-agent HTTP/1.1",
            "Host: 127.0.0.1:\(server.boundPort)",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: \(key)",
            "Sec-WebSocket-Version: 13",
            "", "",
        ].joined(separator: "\r\n")

        // Build a masked text frame with a session_info message
        let sessionInfoJson = """
            {"type":"session_info","command":"agent","planId":99,"planTitle":"Leftover Test"}
            """
        let payload = Data(sessionInfoJson.utf8)
        var frame = Data()
        frame.append(0x81)  // FIN=1, opcode=text
        frame.append(UInt8(payload.count) | 0x80)  // MASK=1 + length
        let maskKey: [UInt8] = [0x37, 0xFA, 0x21, 0x3D]
        frame.append(contentsOf: maskKey)
        for (i, byte) in payload.enumerated() {
            frame.append(byte ^ maskKey[i % 4])
        }

        // Send upgrade request + frame in one TCP write
        var combined = Data(upgradeRequest.utf8)
        combined.append(frame)

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: combined, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            })
        }

        // Wait for processing
        try await Task.sleep(for: .milliseconds(500))

        // Verify the session_info was received despite being in the same TCP segment
        let events = received.withLock { $0 }
        guard case .sessionInfo(_, let info) = events.first else {
            Issue.record("Expected sessionInfo event from immediate frame, got \(events)")
            return
        }
        #expect(info.planId == 99)
        #expect(info.planTitle == "Leftover Test")
    }

    // MARK: - Malformed Frame Rejection Tests

    /// Sends a raw UNMASKED WebSocket frame (violates RFC 6455 for client frames).
    private static func sendUnmaskedFrame(
        fin: Bool, opcode: UInt8, payload: Data, on connection: NWConnection
    ) async throws {
        var frame = Data()

        // Byte 0: FIN bit + opcode
        frame.append((fin ? 0x80 : 0x00) | (opcode & 0x0F))

        // Byte 1: MASK=0 + payload length (no mask bit set)
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

        // No masking key, payload sent directly
        frame.append(payload)

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: frame, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }

    @Test("Unmasked client frame is rejected with close 1002")
    func unmaskedFrameRejection() async throws {
        let disconnected = LockIsolated(false)

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            if case .disconnected = event {
                disconnected.withLock { $0 = true }
            }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send an unmasked text frame (RFC 6455 requires client frames to be masked)
        let payload = Data("hello".utf8)
        try await Self.sendUnmaskedFrame(
            fin: true, opcode: 0x1, payload: payload, on: connection)

        // Server must send close 1002 before disconnecting
        let closeFrame = try await Self.readServerFrame(on: connection, timeout: .seconds(2))
        #expect(closeFrame.opcode == 0x8, "Expected close opcode for unmasked frame rejection")
        #expect(closeFrame.payload.count >= 2, "Close frame must contain status code")
        if closeFrame.payload.count >= 2 {
            let statusCode = UInt16(closeFrame.payload[0]) << 8 | UInt16(closeFrame.payload[1])
            #expect(statusCode == 1002, "Expected close status 1002 (protocol error), got \(statusCode)")
        }

        try await Task.sleep(for: .milliseconds(500))
        let didDisconnect = disconnected.withLock { $0 }
        #expect(didDisconnect, "Expected disconnect event after unmasked frame rejection")
    }

    @Test("Continuation frame without prior fragment is rejected with close 1002")
    func continuationWithoutFragmentRejection() async throws {
        let disconnected = LockIsolated(false)

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            if case .disconnected = event {
                disconnected.withLock { $0 = true }
            }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send a continuation frame (opcode 0x0) without any preceding fragmented message
        try await Self.sendRawFrame(
            fin: true, opcode: 0x0, payload: Data("stray continuation".utf8), on: connection)

        // Server must send close 1002 before disconnecting
        let closeFrame = try await Self.readServerFrame(on: connection, timeout: .seconds(2))
        #expect(closeFrame.opcode == 0x8, "Expected close opcode for stray continuation rejection")
        #expect(closeFrame.payload.count >= 2, "Close frame must contain status code")
        if closeFrame.payload.count >= 2 {
            let statusCode = UInt16(closeFrame.payload[0]) << 8 | UInt16(closeFrame.payload[1])
            #expect(statusCode == 1002, "Expected close status 1002 (protocol error), got \(statusCode)")
        }

        try await Task.sleep(for: .milliseconds(500))
        let didDisconnect = disconnected.withLock { $0 }
        #expect(didDisconnect, "Expected disconnect event after stray continuation rejection")
    }

    @Test("New data frame while fragmentation is active is rejected with close 1002")
    func newFrameDuringFragmentationRejection() async throws {
        let disconnected = LockIsolated(false)

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            if case .disconnected = event {
                disconnected.withLock { $0 = true }
            }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Start a fragmented message: FIN=0, opcode=text
        try await Self.sendRawFrame(
            fin: false, opcode: 0x1, payload: Data("part1".utf8), on: connection)

        // Instead of sending a continuation, send a new text frame (violates fragmentation protocol)
        try await Self.sendRawFrame(
            fin: true, opcode: 0x1, payload: Data("new message".utf8), on: connection)

        // Server must send close 1002 before disconnecting
        let closeFrame = try await Self.readServerFrame(on: connection, timeout: .seconds(2))
        #expect(closeFrame.opcode == 0x8, "Expected close opcode for interleaved data frame rejection")
        #expect(closeFrame.payload.count >= 2, "Close frame must contain status code")
        if closeFrame.payload.count >= 2 {
            let statusCode = UInt16(closeFrame.payload[0]) << 8 | UInt16(closeFrame.payload[1])
            #expect(statusCode == 1002, "Expected close status 1002 (protocol error), got \(statusCode)")
        }

        try await Task.sleep(for: .milliseconds(500))
        let didDisconnect = disconnected.withLock { $0 }
        #expect(didDisconnect, "Expected disconnect event after interleaved data frame rejection")
    }

    // MARK: - RFC 6455 Compliance Tests

    @Test("Unknown opcode is rejected with close 1002")
    func unknownOpcodeRejection() async throws {
        let disconnected = LockIsolated(false)

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            if case .disconnected = event {
                disconnected.withLock { $0 = true }
            }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send a frame with unknown opcode 0x3 (reserved)
        try await Self.sendRawFrame(
            fin: true, opcode: 0x3, payload: Data("test".utf8), on: connection)

        let closeFrame = try await Self.readServerFrame(on: connection, timeout: .seconds(2))
        #expect(closeFrame.opcode == 0x8, "Expected close opcode for unknown opcode rejection")
        #expect(closeFrame.payload.count >= 2, "Close frame must contain status code")
        if closeFrame.payload.count >= 2 {
            let statusCode = UInt16(closeFrame.payload[0]) << 8 | UInt16(closeFrame.payload[1])
            #expect(statusCode == 1002, "Expected close status 1002 (protocol error), got \(statusCode)")
        }

        try await Task.sleep(for: .milliseconds(500))
        let didDisconnect = disconnected.withLock { $0 }
        #expect(didDisconnect, "Expected disconnect event after unknown opcode rejection")
    }

    @Test("Binary frame is rejected with close 1003")
    func binaryFrameRejection() async throws {
        let disconnected = LockIsolated(false)

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            if case .disconnected = event {
                disconnected.withLock { $0 = true }
            }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send a binary frame (opcode 0x2)
        try await Self.sendRawFrame(
            fin: true, opcode: 0x2, payload: Data([0x00, 0x01, 0x02]), on: connection)

        let closeFrame = try await Self.readServerFrame(on: connection, timeout: .seconds(2))
        #expect(closeFrame.opcode == 0x8, "Expected close opcode for binary frame rejection")
        #expect(closeFrame.payload.count >= 2, "Close frame must contain status code")
        if closeFrame.payload.count >= 2 {
            let statusCode = UInt16(closeFrame.payload[0]) << 8 | UInt16(closeFrame.payload[1])
            #expect(statusCode == 1003, "Expected close status 1003 (unsupported data), got \(statusCode)")
        }

        try await Task.sleep(for: .milliseconds(500))
        let didDisconnect = disconnected.withLock { $0 }
        #expect(didDisconnect, "Expected disconnect event after binary frame rejection")
    }

    @Test("Ping with FIN=0 is rejected with close 1002")
    func fragmentedPingRejection() async throws {
        let disconnected = LockIsolated(false)

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            if case .disconnected = event {
                disconnected.withLock { $0 = true }
            }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send a ping frame with FIN=0 (control frames must not be fragmented)
        try await Self.sendRawFrame(
            fin: false, opcode: 0x9, payload: Data("ping".utf8), on: connection)

        let closeFrame = try await Self.readServerFrame(on: connection, timeout: .seconds(2))
        #expect(closeFrame.opcode == 0x8, "Expected close opcode for fragmented ping rejection")
        #expect(closeFrame.payload.count >= 2, "Close frame must contain status code")
        if closeFrame.payload.count >= 2 {
            let statusCode = UInt16(closeFrame.payload[0]) << 8 | UInt16(closeFrame.payload[1])
            #expect(statusCode == 1002, "Expected close status 1002 (protocol error), got \(statusCode)")
        }

        try await Task.sleep(for: .milliseconds(500))
        let didDisconnect = disconnected.withLock { $0 }
        #expect(didDisconnect, "Expected disconnect event after fragmented ping rejection")
    }

    @Test("Close with FIN=0 is rejected with close 1002")
    func fragmentedCloseRejection() async throws {
        let disconnected = LockIsolated(false)

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            if case .disconnected = event {
                disconnected.withLock { $0 = true }
            }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send a close frame with FIN=0 (control frames must not be fragmented)
        var closePayload = Data()
        closePayload.append(UInt8((1000 >> 8) & 0xFF))
        closePayload.append(UInt8(1000 & 0xFF))
        try await Self.sendRawFrame(
            fin: false, opcode: 0x8, payload: closePayload, on: connection)

        let closeFrame = try await Self.readServerFrame(on: connection, timeout: .seconds(2))
        #expect(closeFrame.opcode == 0x8, "Expected close opcode for fragmented close rejection")
        #expect(closeFrame.payload.count >= 2, "Close frame must contain status code")
        if closeFrame.payload.count >= 2 {
            let statusCode = UInt16(closeFrame.payload[0]) << 8 | UInt16(closeFrame.payload[1])
            #expect(statusCode == 1002, "Expected close status 1002 (protocol error), got \(statusCode)")
        }

        try await Task.sleep(for: .milliseconds(500))
        let didDisconnect = disconnected.withLock { $0 }
        #expect(didDisconnect, "Expected disconnect event after fragmented close rejection")
    }

    @Test("Ping with payload > 125 bytes is rejected with close 1002")
    func oversizePingRejection() async throws {
        let disconnected = LockIsolated(false)

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            if case .disconnected = event {
                disconnected.withLock { $0 = true }
            }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send a ping frame with 126-byte payload (exceeds 125-byte control frame limit)
        let oversizePayload = Data(repeating: 0x41, count: 126)
        try await Self.sendRawFrame(
            fin: true, opcode: 0x9, payload: oversizePayload, on: connection)

        let closeFrame = try await Self.readServerFrame(on: connection, timeout: .seconds(2))
        #expect(closeFrame.opcode == 0x8, "Expected close opcode for oversize ping rejection")
        #expect(closeFrame.payload.count >= 2, "Close frame must contain status code")
        if closeFrame.payload.count >= 2 {
            let statusCode = UInt16(closeFrame.payload[0]) << 8 | UInt16(closeFrame.payload[1])
            #expect(statusCode == 1002, "Expected close status 1002 (protocol error), got \(statusCode)")
        }

        try await Task.sleep(for: .milliseconds(500))
        let didDisconnect = disconnected.withLock { $0 }
        #expect(didDisconnect, "Expected disconnect event after oversize ping rejection")
    }

    /// Sends a raw masked WebSocket frame with a custom first byte (for setting RSV bits).
    private static func sendRawFrameWithByte0(
        byte0: UInt8, payload: Data, on connection: NWConnection
    ) async throws {
        var frame = Data()
        frame.append(byte0)

        let length = payload.count
        if length < 126 {
            frame.append(UInt8(length) | 0x80)
        } else if length < 65536 {
            frame.append(126 | 0x80)
            frame.append(UInt8((length >> 8) & 0xFF))
            frame.append(UInt8(length & 0xFF))
        } else {
            frame.append(127 | 0x80)
            for i in stride(from: 56, through: 0, by: -8) {
                frame.append(UInt8((length >> i) & 0xFF))
            }
        }

        let maskKey: [UInt8] = [0x37, 0xFA, 0x21, 0x3D]
        frame.append(contentsOf: maskKey)

        for (i, byte) in payload.enumerated() {
            frame.append(byte ^ maskKey[i % 4])
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: frame, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }

    @Test("Frame with RSV1 bit set is rejected with close 1002")
    func rsvBitRejection() async throws {
        let disconnected = LockIsolated(false)

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            if case .disconnected = event {
                disconnected.withLock { $0 = true }
            }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send a text frame with RSV1 bit set: FIN=1, RSV1=1, opcode=0x1 → byte0 = 0xC1
        try await Self.sendRawFrameWithByte0(
            byte0: 0xC1, payload: Data("hello".utf8), on: connection)

        let closeFrame = try await Self.readServerFrame(on: connection, timeout: .seconds(2))
        #expect(closeFrame.opcode == 0x8, "Expected close opcode for RSV bit rejection")
        #expect(closeFrame.payload.count >= 2, "Close frame must contain status code")
        if closeFrame.payload.count >= 2 {
            let statusCode = UInt16(closeFrame.payload[0]) << 8 | UInt16(closeFrame.payload[1])
            #expect(statusCode == 1002, "Expected close status 1002 (protocol error), got \(statusCode)")
        }

        try await Task.sleep(for: .milliseconds(500))
        let didDisconnect = disconnected.withLock { $0 }
        #expect(didDisconnect, "Expected disconnect event after RSV bit rejection")
    }

    @Test("Invalid UTF-8 text frame is rejected with close 1007")
    func invalidUtf8Rejection() async throws {
        let disconnected = LockIsolated(false)

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            if case .disconnected = event {
                disconnected.withLock { $0 = true }
            }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send a text frame with invalid UTF-8 bytes (0xFF 0xFE are never valid in UTF-8)
        let invalidUtf8 = Data([0xFF, 0xFE, 0x80, 0x81])
        try await Self.sendRawFrame(
            fin: true, opcode: 0x1, payload: invalidUtf8, on: connection)

        let closeFrame = try await Self.readServerFrame(on: connection, timeout: .seconds(2))
        #expect(closeFrame.opcode == 0x8, "Expected close opcode for invalid UTF-8 rejection")
        #expect(closeFrame.payload.count >= 2, "Close frame must contain status code")
        if closeFrame.payload.count >= 2 {
            let statusCode = UInt16(closeFrame.payload[0]) << 8 | UInt16(closeFrame.payload[1])
            #expect(statusCode == 1007, "Expected close status 1007 (invalid payload data), got \(statusCode)")
        }

        try await Task.sleep(for: .milliseconds(500))
        let didDisconnect = disconnected.withLock { $0 }
        #expect(didDisconnect, "Expected disconnect event after invalid UTF-8 rejection")
    }

    @Test("Invalid UTF-8 in fragmented message is rejected with close 1007")
    func invalidUtf8FragmentedRejection() async throws {
        let disconnected = LockIsolated(false)

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            if case .disconnected = event {
                disconnected.withLock { $0 = true }
            }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send a fragmented text message where the reassembled payload is invalid UTF-8
        // First fragment: valid UTF-8 start
        try await Self.sendRawFrame(
            fin: false, opcode: 0x1, payload: Data("hello".utf8), on: connection)
        // Final fragment: invalid UTF-8 bytes
        try await Self.sendRawFrame(
            fin: true, opcode: 0x0, payload: Data([0xFF, 0xFE]), on: connection)

        let closeFrame = try await Self.readServerFrame(on: connection, timeout: .seconds(2))
        #expect(closeFrame.opcode == 0x8, "Expected close opcode for invalid UTF-8 in fragments")
        #expect(closeFrame.payload.count >= 2, "Close frame must contain status code")
        if closeFrame.payload.count >= 2 {
            let statusCode = UInt16(closeFrame.payload[0]) << 8 | UInt16(closeFrame.payload[1])
            #expect(statusCode == 1007, "Expected close status 1007 (invalid payload data), got \(statusCode)")
        }

        try await Task.sleep(for: .milliseconds(500))
        let didDisconnect = disconnected.withLock { $0 }
        #expect(didDisconnect, "Expected disconnect event after invalid UTF-8 fragment rejection")
    }

    @Test("Oversize frame is rejected with 1009 close and disconnect")
    func oversizeFrameRejection() async throws {
        let disconnected = LockIsolated(false)

        let server = LocalHTTPServer(port: 0, handler: { _ in }, wsHandler: { @MainActor event in
            if case .disconnected = event {
                disconnected.withLock { $0 = true }
            }
        })
        try await server.start()
        defer { server.stop() }

        let (connection, _) = try await Self.connectAndUpgrade(port: server.boundPort)
        defer { connection.cancel() }

        // Send a frame header claiming 17MB payload (exceeds 16MB limit)
        let oversizeLength: UInt64 = 17 * 1024 * 1024
        try await Self.sendOversizeFrameHeader(
            opcode: 0x1, claimedLength: oversizeLength, on: connection)

        // The server should send a 1009 close frame and disconnect
        // Try to read the close frame; the connection may also just drop
        do {
            let closeFrame = try await Self.readServerFrame(on: connection, timeout: .seconds(2))
            #expect(closeFrame.opcode == 0x8, "Expected close opcode for oversize rejection")
            if closeFrame.payload.count >= 2 {
                let statusCode =
                    UInt16(closeFrame.payload[0]) << 8 | UInt16(closeFrame.payload[1])
                #expect(statusCode == 1009, "Expected close status 1009 (message too big), got \(statusCode)")
            }
        } catch {
            // Connection may have been cancelled before we could read the close frame.
            // That's acceptable — the important thing is the disconnect event fires.
        }

        // Verify disconnect event fires
        try await Task.sleep(for: .milliseconds(500))
        let didDisconnect = disconnected.withLock { $0 }
        #expect(didDisconnect, "Expected disconnect event after oversize frame rejection")
    }
}

/// Extension to WebSocketEvent for Sendable conformance to allow usage in LockIsolated.
extension WebSocketEvent: @retroactive Equatable {
    public static func == (lhs: WebSocketEvent, rhs: WebSocketEvent) -> Bool {
        switch (lhs, rhs) {
        case (.disconnected(let a), .disconnected(let b)):
            return a == b
        case (.sessionInfo(let a, _), .sessionInfo(let b, _)):
            return a == b
        case (.replayStart(let a), .replayStart(let b)):
            return a == b
        case (.replayEnd(let a), .replayEnd(let b)):
            return a == b
        default:
            return false
        }
    }
}
