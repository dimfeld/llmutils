import Foundation
import Network

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

struct MessageItem: Identifiable {
    let id = UUID()
    let message: String
    let workspacePath: String
    let terminal: TerminalPayload?
    let receivedAt: Date
    var isRead: Bool = false
}

final class LocalHTTPServer: @unchecked Sendable {
    private let port: NWEndpoint.Port
    private let handler: @MainActor (MessagePayload) -> Void
    private var listener: NWListener?

    init(port: UInt16, handler: @escaping @MainActor (MessagePayload) -> Void) {
        self.port = NWEndpoint.Port(rawValue: port) ?? 8123
        self.handler = handler
    }

    func start() async throws {
        guard listener == nil else { return }
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters, on: port)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection: connection)
        }
        listener.start(queue: .global())
        self.listener = listener
    }

    func stop() {
        self.listener?.cancel()
        self.listener = nil
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
            guard request.method == "POST", request.path == "/messages" else {
                try await self.sendResponse(connection, status: 404, jsonBody: ["error": "Not found"])
                connection.cancel()
                return
            }

            guard let body = request.body else {
                try await self.sendResponse(connection, status: 400, jsonBody: ["error": "Missing body"])
                connection.cancel()
                return
            }

            let payload = try JSONDecoder().decode(MessagePayload.self, from: body)
            await self.handler(payload)
            try await self.sendResponse(connection, status: 200, jsonBody: ["status": "ok"])
        } catch {
            try? await self.sendResponse(connection, status: 400, jsonBody: ["error": "Bad request"])
        }
        connection.cancel()
    }

    private func readRequest(from connection: NWConnection) async throws -> HTTPRequest {
        var buffer = Data()
        var headersEnd: Range<Data.Index>?
        var contentLength = 0

        while true {
            let chunk = try await receiveChunk(from: connection)
            if chunk.isEmpty { break }
            buffer.append(chunk)

            if headersEnd == nil, let range = buffer.range(of: Data("\r\n\r\n".utf8)) {
                headersEnd = range
                let headersData = buffer[..<range.lowerBound]
                let headerText = String(decoding: headersData, as: UTF8.self)
                let lines = headerText.components(separatedBy: "\r\n")
                if let firstLine = lines.first {
                    let parts = firstLine.split(separator: " ")
                    if parts.count >= 2 {
                        // Method/path parsed later
                    }
                }
                for line in lines.dropFirst() {
                    let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
                    guard parts.count == 2 else { continue }
                    let name = parts[0].trimmingCharacters(in: .whitespaces)
                    let value = parts[1].trimmingCharacters(in: .whitespaces)
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

        let headerData = buffer[..<headersEnd.lowerBound]
        let headerText = String(decoding: headerData, as: UTF8.self)
        let lines = headerText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else {
            throw HTTPError.invalidRequest
        }
        let requestParts = requestLine.split(separator: " ")
        guard requestParts.count >= 2 else {
            throw HTTPError.invalidRequest
        }

        let method = String(requestParts[0])
        let path = String(requestParts[1])
        let bodyStart = headersEnd.upperBound
        let body: Data? = if contentLength > 0, buffer.count >= bodyStart + contentLength {
            buffer.subdata(in: bodyStart..<(bodyStart + contentLength))
        } else {
            nil
        }

        return HTTPRequest(method: method, path: path, body: body)
    }

    private func receiveChunk(from connection: NWConnection) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, _, error in
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

struct HTTPRequest {
    let method: String
    let path: String
    let body: Data?
}

enum HTTPError: Error {
    case invalidRequest
}
