import Darwin
import Foundation

/// A duplex stream of newline-delimited frames. Tests use a fake; the app uses `ProcessTransport`.
public protocol EngineTransport: Sendable {
    /// Each complete line from the engine. Finishes when it's gone.
    var lines: AsyncStream<Data> { get }
    func send(_ line: Data) throws
    /// Asks the engine to finish up by closing its stdin. It stops running jobs and exits by itself.
    func close()
    /// What the engine last wrote to stderr, for explaining a failure.
    func diagnostics() -> String
}

/// Splits a byte stream on newlines without rescanning what it has already seen, since a single
/// frame can be many megabytes.
public struct LineSplitter: Sendable {
    private var buffer = Data()
    private var scanned = 0

    public init() {}

    public mutating func append(_ chunk: Data) -> [Data] {
        buffer.append(chunk)
        var out: [Data] = []
        var start = buffer.startIndex
        var cursor = buffer.startIndex + scanned
        while let newline = buffer[cursor...].firstIndex(of: 10) {
            if newline > start { out.append(Data(buffer[start..<newline])) }
            start = newline + 1
            cursor = start
        }
        if start > buffer.startIndex { buffer = Data(buffer[start...]) }
        scanned = buffer.count
        return out
    }
}

/// Keeps only the end of a stream.
final class TailBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    private let limit: Int

    init(limit: Int) { self.limit = limit }

    func append(_ chunk: Data) {
        lock.withLock {
            data.append(chunk)
            if data.count > limit * 2 { data = Data(data.suffix(limit)) }
        }
    }

    var text: String { lock.withLock { String(decoding: data.suffix(limit), as: UTF8.self) } }
}

/// The engine as a child process, on pipes. Nothing is logged to disk: stderr stays in memory.
public final class ProcessTransport: EngineTransport, @unchecked Sendable {
    public let lines: AsyncStream<Data>
    private let continuation: AsyncStream<Data>.Continuation
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let errors = Pipe()
    private let tail = TailBuffer(limit: 64 * 1024)
    private let writeLock = NSLock()
    private let readQueue = DispatchQueue(label: "app.mypeople.engine.read")

    public init(executable: URL, arguments: [String], environment: [String: String]) throws {
        // Writing to an engine that has just died must be an error, not the end of this app.
        signal(SIGPIPE, SIG_IGN)
        (lines, continuation) = AsyncStream.makeStream(of: Data.self)
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors

        let continuation = self.continuation, tail = self.tail
        var splitter = LineSplitter()
        let handle = output.fileHandleForReading
        let queue = readQueue
        // A dispatch source rather than readabilityHandler, so that end-of-file is unmistakable
        // and every line is delivered before the stream finishes.
        let source = DispatchSource.makeReadSource(fileDescriptor: handle.fileDescriptor, queue: queue)
        source.setEventHandler {
            let chunk = handle.availableData
            if chunk.isEmpty {
                source.cancel()
                continuation.finish()
                return
            }
            for line in splitter.append(chunk) { continuation.yield(line) }
        }
        source.resume()
        errors.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil } else { tail.append(chunk) }
        }
        try process.run()
        // The child holds its own copies. Ours must close, or EOF would never arrive.
        try? output.fileHandleForWriting.close()
        try? errors.fileHandleForWriting.close()
        try? input.fileHandleForReading.close()
    }

    public func send(_ line: Data) throws {
        try writeLock.withLock {
            try input.fileHandleForWriting.write(contentsOf: line)
        }
    }

    public func close() {
        writeLock.withLock { try? input.fileHandleForWriting.close() }
    }

    public func diagnostics() -> String { tail.text }

    deinit { close() }
}
