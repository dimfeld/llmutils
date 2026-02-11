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
