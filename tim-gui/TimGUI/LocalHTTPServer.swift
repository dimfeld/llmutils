import Foundation
import Network
import os.log

struct TerminalPayload: Codable {
    let type: String
    let paneId: String

    enum CodingKeys: String, CodingKey {
        case type
        case paneId = "pane_id"
    }
}

struct MessagePayload: Codable {
    let message: String
    let workspacePath: String
    let terminal: TerminalPayload?
}

// MARK: - WebSocket Event

enum WebSocketEvent: Sendable {
    case sessionInfo(UUID, SessionInfoPayload)
    case output(UUID, Int, TunnelMessage)
    case replayStart(UUID)
    case replayEnd(UUID)
    case disconnected(UUID)
}

// MARK: - LocalHTTPServer

final class LocalHTTPServer: @unchecked Sendable {
    private let port: NWEndpoint.Port
    private let handler: @MainActor (MessagePayload) -> Void
    private let wsHandler: @MainActor (WebSocketEvent) -> Void
    private var listener: NWListener?
    private var wsConnections: [UUID: WebSocketConnection] = [:]
    private let connectionsLock = NSLock()

    /// The port the server is actually listening on. Only valid after `start()` returns.
    var boundPort: UInt16 {
        self.listener?.port?.rawValue ?? 0
    }

    init(
        port: UInt16,
        handler: @escaping @MainActor (MessagePayload) -> Void,
        wsHandler: @escaping @MainActor (WebSocketEvent) -> Void)
    {
        self.port = NWEndpoint.Port(rawValue: port) ?? 8123
        self.handler = handler
        self.wsHandler = wsHandler
    }

    func start() async throws {
        guard self.listener == nil else { return }
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        parameters.allowLocalEndpointReuse = true
        let newListener = try NWListener(using: parameters, on: port)
        newListener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection: connection)
        }

        let resumeGuard = StartupResumeGuard()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            newListener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if resumeGuard.tryResume() {
                        continuation.resume()
                    }
                case let .failed(error):
                    if resumeGuard.tryResume() {
                        continuation.resume(throwing: error)
                    }
                default:
                    break
                }
            }
            newListener.start(queue: .global())
        }

        // Replace the startup handler with one that monitors for post-startup failures.
        newListener.stateUpdateHandler = { state in
            switch state {
            case let .failed(error):
                Self.logger.error("NWListener failed after startup: \(error)")
            case .cancelled:
                Self.logger.info("NWListener cancelled")
            default:
                break
            }
        }
        self.listener = newListener
    }

    func stop() {
        self.listener?.cancel()
        self.listener = nil
        self.connectionsLock.lock()
        let connections = self.wsConnections
        self.wsConnections.removeAll()
        self.connectionsLock.unlock()
        for (_, conn) in connections {
            conn.close()
        }
    }

    private func handle(connection: NWConnection) {
        connection.start(queue: .global())
        Task {
            await self.handleRequest(on: connection)
        }
    }

    private func handleRequest(on connection: NWConnection) async {
        do {
            let request = try await readRequest(from: connection)

            // Check for WebSocket upgrade
            if request.method == "GET", request.path == "/tim-agent",
               request.isWebSocketUpgrade, let wsKey = request.webSocketKey
            {
                await self.handleWebSocketUpgrade(
                    connection: connection,
                    key: wsKey,
                    leftoverData: request.leftoverData ?? Data())
                return
            }

            // Existing HTTP handling
            guard request.method == "POST", request.path == "/messages" else {
                try await self.sendResponse(connection, status: 404, jsonBody: ["error": "Not found"])
                connection.cancel()
                return
            }

            guard let body = request.body else {
                try await self.sendResponse(
                    connection, status: 400, jsonBody: ["error": "Missing body"])
                connection.cancel()
                return
            }

            let payload = try JSONDecoder().decode(MessagePayload.self, from: body)
            await self.handler(payload)
            try await self.sendResponse(connection, status: 200, jsonBody: ["status": "ok"])
        } catch {
            try? await self.sendResponse(
                connection, status: 400, jsonBody: ["error": "Bad request"])
        }
        connection.cancel()
    }

    // MARK: - WebSocket Upgrade

    private func handleWebSocketUpgrade(connection: NWConnection, key: String, leftoverData: Data) async {
        let connectionId = UUID()
        let wsHandler = self.wsHandler

        let wsConnection = WebSocketConnection(
            id: connectionId,
            connection: connection,
            initialBuffer: leftoverData,
            onMessage: { [weak self] text in
                await self?.handleWebSocketMessage(connectionId: connectionId, text: text)
            },
            onDisconnect: { [weak self] in
                self?.handleWebSocketDisconnect(connectionId: connectionId)
                await MainActor.run {
                    wsHandler(.disconnected(connectionId))
                }
            })

        self.addConnection(connectionId, wsConnection)

        do {
            try await wsConnection.performUpgrade(key: key)
            wsConnection.startReading()
        } catch {
            self.handleWebSocketDisconnect(connectionId: connectionId)
            await MainActor.run {
                wsHandler(.disconnected(connectionId))
            }
        }
    }

    private nonisolated func addConnection(_ id: UUID, _ connection: WebSocketConnection) {
        self.connectionsLock.lock()
        self.wsConnections[id] = connection
        self.connectionsLock.unlock()
    }

    private static let logger = Logger(subsystem: "com.timgui", category: "WebSocket")

    private func handleWebSocketMessage(connectionId: UUID, text: String) async {
        let wsHandler = self.wsHandler
        guard let data = text.data(using: .utf8) else { return }

        do {
            let message = try JSONDecoder().decode(HeadlessMessage.self, from: data)
            await MainActor.run {
                switch message {
                case let .sessionInfo(info):
                    wsHandler(.sessionInfo(connectionId, info))
                case let .output(seq, tunnelMessage):
                    wsHandler(.output(connectionId, seq, tunnelMessage))
                case .replayStart:
                    wsHandler(.replayStart(connectionId))
                case .replayEnd:
                    wsHandler(.replayEnd(connectionId))
                case let .unknown(type):
                    Self.logger.warning("Received unknown HeadlessMessage type: \(type)")
                }
            }
        } catch {
            Self.logger.error("Failed to decode WebSocket message: \(error)")
        }
    }

    enum SendMessageError: Error, LocalizedError {
        case connectionNotFound

        var errorDescription: String? {
            switch self {
            case .connectionNotFound:
                "WebSocket connection not found"
            }
        }
    }

    func sendMessage(to connectionId: UUID, text: String) async throws {
        guard let connection = self.getConnection(connectionId) else {
            throw SendMessageError.connectionNotFound
        }
        try await connection.sendText(text)
    }

    private nonisolated func getConnection(_ connectionId: UUID) -> WebSocketConnection? {
        self.connectionsLock.lock()
        let connection = self.wsConnections[connectionId]
        self.connectionsLock.unlock()
        return connection
    }

    private func handleWebSocketDisconnect(connectionId: UUID) {
        self.connectionsLock.lock()
        self.wsConnections.removeValue(forKey: connectionId)
        self.connectionsLock.unlock()
    }

    // MARK: - HTTP Request Parsing

    private func readRequest(from connection: NWConnection) async throws -> HTTPRequest {
        var buffer = Data()
        var headersEnd: Range<Data.Index>?
        var contentLength = 0
        var headerLines: [String] = []
        var headers: [String: String] = [:]

        while true {
            let chunk = try await receiveChunk(from: connection)
            if chunk.isEmpty { break }
            buffer.append(chunk)

            if headersEnd == nil, let range = buffer.range(of: Data("\r\n\r\n".utf8)) {
                headersEnd = range
                let headersData = buffer[..<range.lowerBound]
                let headerText = String(decoding: headersData, as: UTF8.self)
                headerLines = headerText.components(separatedBy: "\r\n")
                for line in headerLines.dropFirst() {
                    let parts = line.split(
                        separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
                    guard parts.count == 2 else { continue }
                    let name = parts[0].trimmingCharacters(in: .whitespaces)
                    let value = parts[1].trimmingCharacters(in: .whitespaces)
                    headers[name.lowercased()] = value
                    if name.caseInsensitiveCompare("Content-Length") == .orderedSame {
                        contentLength = Int(value) ?? 0
                    }
                }
            }

            if let headersEnd {
                let bodyStart = headersEnd.upperBound
                if contentLength == 0 {
                    break
                }
                if buffer.count >= bodyStart + contentLength {
                    break
                }
            }
        }

        guard let headersEnd else {
            throw HTTPError.invalidRequest
        }

        guard let requestLine = headerLines.first else {
            throw HTTPError.invalidRequest
        }
        let requestParts = requestLine.split(separator: " ")
        guard requestParts.count >= 2 else {
            throw HTTPError.invalidRequest
        }

        let method = String(requestParts[0])
        let path = String(requestParts[1])
        let bodyStart = headersEnd.upperBound
        let body: Data? =
            if contentLength > 0, buffer.count >= bodyStart + contentLength {
                buffer.subdata(in: bodyStart..<(bodyStart + contentLength))
            } else {
                nil
            }

        // Capture leftover bytes after headers for WebSocket upgrades
        let leftover: Data?
        if contentLength == 0 {
            let afterHeaders = headersEnd.upperBound
            if afterHeaders < buffer.count {
                leftover = Data(buffer[afterHeaders...])
            } else {
                leftover = nil
            }
        } else {
            leftover = nil
        }

        return HTTPRequest(method: method, path: path, body: body, headers: headers, leftoverData: leftover)
    }

    private func receiveChunk(from connection: NWConnection) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
                data, _, _, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: data ?? Data())
            }
        }
    }

    private func sendResponse(
        _ connection: NWConnection,
        status: Int,
        jsonBody: [String: String]) async throws
    {
        let bodyData = try JSONSerialization.data(withJSONObject: jsonBody, options: [])
        let statusLine = "HTTP/1.1 \(status) \(statusText(for: status))"
        let headers = [
            "Content-Type: application/json",
            "Content-Length: \(bodyData.count)",
            "Connection: close",
        ]
        let responseHead = ([statusLine] + headers + ["", ""]).joined(separator: "\r\n")
        var responseData = Data(responseHead.utf8)
        responseData.append(bodyData)

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: responseData, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }

    private func statusText(for status: Int) -> String {
        switch status {
        case 200: "OK"
        case 400: "Bad Request"
        case 404: "Not Found"
        default: "OK"
        }
    }
}

// MARK: - HTTPRequest

struct HTTPRequest {
    let method: String
    let path: String
    let body: Data?
    let headers: [String: String]
    let leftoverData: Data?

    init(method: String, path: String, body: Data?, headers: [String: String] = [:], leftoverData: Data? = nil) {
        self.method = method
        self.path = path
        self.body = body
        self.headers = headers
        self.leftoverData = leftoverData
    }

    var isWebSocketUpgrade: Bool {
        self.headers["upgrade"]?.caseInsensitiveCompare("websocket") == .orderedSame
    }

    var webSocketKey: String? {
        self.headers["sec-websocket-key"]
    }
}

enum HTTPError: Error {
    case invalidRequest
}

/// Thread-safe guard ensuring a continuation is resumed at most once during server startup.
private final class StartupResumeGuard: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false

    /// Returns true if this call is the first to claim the resume. Subsequent calls return false.
    func tryResume() -> Bool {
        self.lock.lock()
        let alreadyResumed = self.resumed
        self.resumed = true
        self.lock.unlock()
        return !alreadyResumed
    }
}
