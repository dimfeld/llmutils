import Foundation
import Testing

@testable import TimGUI

@Suite("LocalHTTPServer")
struct LocalHTTPServerTests {
    @Test("Server starts and stops without error")
    func startStop() async throws {
        let server = LocalHTTPServer(port: 0) { _ in }
        try await server.start()
        server.stop()
    }

    @Test("Server accepts POST /messages and delivers payload")
    func postMessage() async throws {
        let received = LockIsolated<MessagePayload?>(nil)

        let server = LocalHTTPServer(port: 0) { @MainActor payload in
            received.withLock { $0 = payload }
        }
        try await server.start()

        let url = URL(string: "http://127.0.0.1:\(server.boundPort)/messages")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("""
            {"message":"hi","workspacePath":"/tmp"}
            """.utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        let httpResponse = try #require(response as? HTTPURLResponse)
        #expect(httpResponse.statusCode == 200)

        let body = try JSONSerialization.jsonObject(with: data) as? [String: String]
        #expect(body?["status"] == "ok")

        let payload = received.withLock { $0 }
        let p = try #require(payload)
        #expect(p.message == "hi")
        #expect(p.workspacePath == "/tmp")

        server.stop()
    }

    @Test("Server returns 404 for unknown paths")
    func unknownPath() async throws {
        let server = LocalHTTPServer(port: 0) { _ in }
        try await server.start()

        let url = URL(string: "http://127.0.0.1:\(server.boundPort)/unknown")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"

        let (_, response) = try await URLSession.shared.data(for: request)
        let httpResponse = try #require(response as? HTTPURLResponse)
        #expect(httpResponse.statusCode == 404)

        server.stop()
    }

    @Test("Server returns 400 for POST /messages with invalid JSON")
    func invalidJSON() async throws {
        let server = LocalHTTPServer(port: 0) { _ in }
        try await server.start()

        let url = URL(string: "http://127.0.0.1:\(server.boundPort)/messages")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("not json".utf8)

        let (_, response) = try await URLSession.shared.data(for: request)
        let httpResponse = try #require(response as? HTTPURLResponse)
        #expect(httpResponse.statusCode == 400)

        server.stop()
    }
}

/// Thread-safe wrapper for a value, useful in concurrent test scenarios.
final class LockIsolated<Value>: @unchecked Sendable {
    private var _value: Value
    private let lock = NSLock()

    init(_ value: Value) {
        self._value = value
    }

    func withLock<T>(_ operation: (inout Value) -> T) -> T {
        self.lock.lock()
        defer { self.lock.unlock() }
        return operation(&self._value)
    }
}
