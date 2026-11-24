import Darwin
import Foundation
import Security
import os

/// Resolves who is behind a flow or XPC connection from the kernel's audit token, using
/// the Security framework. Rules bind to what this returns, so it errs on the side of
/// "unknown": anything that doesn't verify gets no signing ID.
public enum CodeIdentity {
    /// PID and PID version from an `audit_token_t` (8 × UInt32: val[5] is the PID, val[7]
    /// the PID version).
    public static func processInstance(auditToken: Data) -> ProcessInstance? {
        guard auditToken.count == 32 else { return nil }
        let values = auditToken.withUnsafeBytes { Array($0.bindMemory(to: UInt32.self)) }
        return ProcessInstance(pid: Int32(bitPattern: values[5]), pidVersion: Int32(bitPattern: values[7]))
    }

    public static func resolve(auditToken: Data) -> ProcessIdentity {
        guard auditToken.count == 32 else { return .unknown() }
        let identity = resolve(attributes: [kSecGuestAttributeAudit: auditToken])
        // When the code can't be inspected (for example the binary on disk was replaced
        // while the process kept running), still show where it runs from. The signature
        // stays unknown, so only path rules can match it.
        if identity.signature == .unknown, !identity.isLocated, let pid = processInstance(auditToken: auditToken)?.pid {
            logger.debug("Can't locate code for pid \(pid); falling back to the kernel's path and name")
            if let path = executablePath(pid: pid) {
                return ProcessIdentity(signingID: nil, teamID: nil, path: path, signature: .unknown)
            }
            return ProcessIdentity.unknown(name: processName(pid: pid))
        }
        return identity
    }

    /// Whether `pid` is a running process. Errs toward true when the kernel won't say.
    public static func processExists(_ pid: pid_t) -> Bool {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0 else { return true }
        return size > 0
    }

    /// The kernel's short name for a process (from its executable at launch).
    static func processName(pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 2 * Int(MAXCOMLEN) + 1)
        let length = proc_name(pid, &buffer, UInt32(buffer.count))
        if length > 0 {
            return String(decoding: buffer.prefix(Int(length)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
        }
        // proc_name can be refused inside the sandbox; the process table via sysctl usually isn't.
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0, size > 0 else {
            logger.notice("No name for pid \(pid): proc_name and sysctl failed (errno \(errno))")
            return nil
        }
        let name = withUnsafeBytes(of: info.kp_proc.p_comm) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        logger.debug("Named pid \(pid) \(name, privacy: .public) via sysctl")
        return name.isEmpty ? nil : name
    }

    private static let logger = Logger(subsystem: "dev.jonaylor.Tattle", category: "identity")

    /// The kernel's record of a process's executable path.
    static func executablePath(pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        return String(decoding: buffer.prefix(Int(length)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    public static func resolve(pid: pid_t) -> ProcessIdentity {
        resolve(attributes: [kSecGuestAttributePid: NSNumber(value: pid)])
    }

    private static func resolve(attributes: [CFString: Any]) -> ProcessIdentity {
        var guest: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, attributes as CFDictionary, [], &guest) == errSecSuccess, let code = guest else {
            return .unknown()
        }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return .unknown() }

        var pathURL: CFURL?
        let path = SecCodeCopyPath(staticCode, [], &pathURL) == errSecSuccess
            ? (pathURL as URL?)?.path(percentEncoded: false) ?? "unknown" : "unknown"

        var infoRef: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &infoRef) == errSecSuccess,
              let info = infoRef as? [String: Any]
        else { return ProcessIdentity(signingID: nil, teamID: nil, path: path, signature: .unknown) }

        let validity = SecCodeCheckValidity(code, [], nil)
        if validity == errSecCSUnsigned {
            return ProcessIdentity(signingID: nil, teamID: nil, path: path, signature: .unsigned)
        }
        guard validity == errSecSuccess else {
            return ProcessIdentity(signingID: nil, teamID: nil, path: path, signature: .invalid)
        }
        let flags = (info[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
        if flags & SecCodeSignatureFlags.adhoc.rawValue != 0 || info[kSecCodeInfoIdentifier as String] == nil {
            return ProcessIdentity(signingID: nil, teamID: nil, path: path, signature: .adHoc)
        }
        let signingID = info[kSecCodeInfoIdentifier as String] as? String
        if satisfies(code, Requirements.apple) {
            return ProcessIdentity(signingID: signingID, teamID: ProcessMatch.appleTeamID, path: path, signature: .apple)
        }
        if let team = info[kSecCodeInfoTeamIdentifier as String] as? String, satisfies(code, Requirements.appleGeneric) {
            return ProcessIdentity(signingID: signingID, teamID: team, path: path, signature: .developer)
        }
        // Valid signature, but not from a certificate Apple issued: proves nothing.
        return ProcessIdentity(signingID: nil, teamID: nil, path: path, signature: .adHoc)
    }

    /// Compiled once. SecRequirement objects are immutable, so sharing them across threads is safe.
    private enum Requirements {
        nonisolated(unsafe) static let apple = make("anchor apple")
        nonisolated(unsafe) static let appleGeneric = make("anchor apple generic")

        static func make(_ text: String) -> SecRequirement? {
            var requirement: SecRequirement?
            return SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess ? requirement : nil
        }
    }

    private static func satisfies(_ code: SecCode, _ requirement: SecRequirement?) -> Bool {
        guard let requirement else { return false }
        return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
    }

    /// The team and signing identifier of the running process, if it's validly signed.
    public static func current() -> (teamID: String, signingID: String)? {
        var selfCode: SecCode?
        guard SecCodeCopySelf([], &selfCode) == errSecSuccess, let selfCode else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(selfCode, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
        var infoRef: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &infoRef) == errSecSuccess,
              let info = infoRef as? [String: Any],
              let team = info[kSecCodeInfoTeamIdentifier as String] as? String,
              let identifier = info[kSecCodeInfoIdentifier as String] as? String
        else { return nil }
        return (team, identifier)
    }
}

/// A small LRU cache of resolved identities keyed by process instance, so the Security
/// framework work happens once per process rather than once per flow.
public final class IdentityCache: @unchecked Sendable {
    private struct Entry {
        let identity: ProcessIdentity
        var lastUsed: UInt64
    }

    private let lock = OSAllocatedUnfairLock()
    private var entries: [ProcessInstance: Entry] = [:]
    private var clock: UInt64 = 0
    private let capacity: Int

    public init(capacity: Int = 4096) {
        self.capacity = capacity
    }

    public func identity(for instance: ProcessInstance) -> ProcessIdentity? {
        lock.withLock {
            guard var entry = entries[instance] else { return nil }
            clock += 1
            entry.lastUsed = clock
            entries[instance] = entry
            return entry.identity
        }
    }

    public func store(_ identity: ProcessIdentity, for instance: ProcessInstance) {
        lock.withLock {
            clock += 1
            entries[instance] = Entry(identity: identity, lastUsed: clock)
            if entries.count > capacity {
                // Evict the least recently used quarter; amortized O(1) per insert.
                let victims = entries.sorted { $0.value.lastUsed < $1.value.lastUsed }.prefix(capacity / 4).map(\.key)
                for key in victims { entries[key] = nil }
            }
        }
    }

    public var count: Int { lock.withLock { entries.count } }
}
