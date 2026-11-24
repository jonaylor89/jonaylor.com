import Foundation
import GRDB

/// The extension's SQLite database: rules, profiles, settings, blocklists, the connection
/// log and traffic statistics. Only the extension opens it; the app and `tattlectl` read
/// it through XPC. All methods are synchronous and must be called off the filter thread.
public final class TattleDatabase: Sendable {
    private let queue: DatabaseQueue
    private static let encoder = RuleDocument.makeEncoder()
    private static let decoder = RuleDocument.makeDecoder()

    /// Opens (creating if needed) the database at `path`, or an in-memory one for tests.
    public init(path: String? = nil) throws {
        var configuration = Configuration()
        configuration.label = "Tattle"
        if let path {
            queue = try DatabaseQueue(path: path, configuration: configuration)
            try queue.writeWithoutTransaction { db in
                try db.execute(sql: "PRAGMA journal_mode = WAL")
            }
        } else {
            queue = try DatabaseQueue(configuration: configuration)
        }
        try Self.migrator.migrate(queue)
    }

    static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in
            try db.execute(sql: """
                CREATE TABLE rules (id TEXT PRIMARY KEY, lifetime TEXT NOT NULL, body TEXT NOT NULL);
                CREATE TABLE profiles (id TEXT PRIMARY KEY, position INTEGER NOT NULL, body TEXT NOT NULL);
                CREATE TABLE settings (key TEXT PRIMARY KEY, body TEXT NOT NULL);
                CREATE TABLE blocklists (id TEXT PRIMARY KEY, position INTEGER NOT NULL, body TEXT NOT NULL, content BLOB);
                CREATE TABLE connections (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    flowID TEXT NOT NULL UNIQUE,
                    time REAL NOT NULL,
                    pid INTEGER,
                    path TEXT NOT NULL,
                    signingID TEXT,
                    teamID TEXT,
                    signature TEXT NOT NULL,
                    remoteAddress TEXT,
                    remoteHost TEXT,
                    remotePort INTEGER NOT NULL,
                    proto TEXT NOT NULL,
                    direction TEXT NOT NULL,
                    action TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    sourceID TEXT,
                    profileID TEXT,
                    bytesIn INTEGER NOT NULL DEFAULT 0,
                    bytesOut INTEGER NOT NULL DEFAULT 0,
                    needsReview INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX connections_time ON connections(time);
                CREATE INDEX connections_review ON connections(needsReview) WHERE needsReview = 1;
                CREATE TABLE traffic (
                    bucket INTEGER NOT NULL,
                    appKey TEXT NOT NULL,
                    appName TEXT NOT NULL,
                    host TEXT NOT NULL,
                    bytesIn INTEGER NOT NULL DEFAULT 0,
                    bytesOut INTEGER NOT NULL DEFAULT 0,
                    flows INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (bucket, appKey, host)
                );
                """)
        }
        migrator.registerMigration("v2-process-name") { db in
            // The kernel's name for processes whose executable can't be located.
            try db.execute(sql: "ALTER TABLE connections ADD COLUMN processName TEXT")
        }
        return migrator
    }

    private static func json<T: Encodable>(_ value: T) throws -> String {
        String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T {
        try decoder.decode(type, from: Data(text.utf8))
    }

    // MARK: Rules

    public func rules() throws -> [Rule] {
        try queue.read { db in
            try String.fetchAll(db, sql: "SELECT body FROM rules").map { try Self.decode(Rule.self, $0) }
        }
    }

    public func saveRules(_ rules: [Rule]) throws {
        try queue.write { db in
            for rule in rules {
                try db.execute(
                    sql: "INSERT OR REPLACE INTO rules (id, lifetime, body) VALUES (?, ?, ?)",
                    arguments: [rule.id.uuidString, rule.lifetime.rawValue, try Self.json(rule)]
                )
            }
        }
    }

    public func deleteRules(_ ids: [UUID]) throws {
        try queue.write { db in
            for id in ids { try db.execute(sql: "DELETE FROM rules WHERE id = ?", arguments: [id.uuidString]) }
        }
    }

    /// Replaces every non-system rule (used by import with "replace").
    public func replaceUserRules(with rules: [Rule]) throws {
        let existing = try self.rules().filter { !$0.isSystem }.map(\.id)
        try queue.write { db in
            for id in existing { try db.execute(sql: "DELETE FROM rules WHERE id = ?", arguments: [id.uuidString]) }
            for rule in rules {
                try db.execute(
                    sql: "INSERT OR REPLACE INTO rules (id, lifetime, body) VALUES (?, ?, ?)",
                    arguments: [rule.id.uuidString, rule.lifetime.rawValue, try Self.json(rule)]
                )
            }
        }
    }

    /// Removes rules that can't apply any more: until-quit rules (their processes belong to
    /// an earlier extension run) and until-restart rules from another boot session.
    /// Deletes until-restart rules from earlier boots, and until-quit rules whose process is
    /// gone (or that belong to an earlier boot, where process IDs mean nothing).
    public func removeStaleTemporaryRules(bootSession: String, processExists: (pid_t) -> Bool = { _ in false }) throws -> Int {
        let stale = try rules().filter { rule in
            switch rule.lifetime {
            case .untilQuit:
                guard rule.bootSession == bootSession, let bound = rule.boundProcess else { return true }
                return !processExists(bound.pid)
            case .untilRestart: return rule.bootSession != bootSession
            case .once, .forever: return false
            }
        }
        try deleteRules(stale.map(\.id))
        return stale.count
    }

    // MARK: Profiles

    public func profiles() throws -> [Profile] {
        try queue.read { db in
            try String.fetchAll(db, sql: "SELECT body FROM profiles ORDER BY position").map { try Self.decode(Profile.self, $0) }
        }
    }

    public func saveProfile(_ profile: Profile) throws {
        try queue.write { db in
            let position = try Int.fetchOne(db, sql: "SELECT position FROM profiles WHERE id = ?", arguments: [profile.id.uuidString])
                ?? (try Int.fetchOne(db, sql: "SELECT COALESCE(MAX(position), -1) + 1 FROM profiles") ?? 0)
            try db.execute(
                sql: "INSERT OR REPLACE INTO profiles (id, position, body) VALUES (?, ?, ?)",
                arguments: [profile.id.uuidString, position, try Self.json(profile)]
            )
        }
    }

    /// Deletes the profile and every rule that only applied in it.
    public func deleteProfile(_ id: UUID) throws {
        let orphaned = try rules().filter { $0.profileID == id }.map(\.id)
        try deleteRules(orphaned)
        try queue.write { db in
            try db.execute(sql: "DELETE FROM profiles WHERE id = ?", arguments: [id.uuidString])
        }
    }

    // MARK: Settings

    public func settings() throws -> Settings {
        try queue.read { db in
            guard let body = try String.fetchOne(db, sql: "SELECT body FROM settings WHERE key = 'settings'") else { return Settings() }
            return (try? Self.decode(Settings.self, body)) ?? Settings()
        }
    }

    public func saveSettings(_ settings: Settings) throws {
        try queue.write { db in
            try db.execute(sql: "INSERT OR REPLACE INTO settings (key, body) VALUES ('settings', ?)", arguments: [try Self.json(settings)])
        }
    }

    public func flag(_ key: String) throws -> Bool? {
        try queue.read { db in
            try String.fetchOne(db, sql: "SELECT body FROM settings WHERE key = ?", arguments: ["flag." + key]).map { $0 == "true" }
        }
    }

    public func setFlag(_ key: String, _ value: Bool) throws {
        try queue.write { db in
            try db.execute(sql: "INSERT OR REPLACE INTO settings (key, body) VALUES (?, ?)", arguments: ["flag." + key, value ? "true" : "false"])
        }
    }

    // MARK: Blocklists

    public func blocklists() throws -> [Blocklist] {
        try queue.read { db in
            try String.fetchAll(db, sql: "SELECT body FROM blocklists ORDER BY position").map { try Self.decode(Blocklist.self, $0) }
        }
    }

    public func saveBlocklist(_ list: Blocklist) throws {
        try queue.write { db in
            let position = try Int.fetchOne(db, sql: "SELECT position FROM blocklists WHERE id = ?", arguments: [list.id.uuidString])
                ?? (try Int.fetchOne(db, sql: "SELECT COALESCE(MAX(position), -1) + 1 FROM blocklists") ?? 0)
            if try Bool.fetchOne(db, sql: "SELECT 1 FROM blocklists WHERE id = ?", arguments: [list.id.uuidString]) == true {
                try db.execute(
                    sql: "UPDATE blocklists SET body = ? WHERE id = ?",
                    arguments: [try Self.json(list), list.id.uuidString]
                )
            } else {
                try db.execute(
                    sql: "INSERT INTO blocklists (id, position, body) VALUES (?, ?, ?)",
                    arguments: [list.id.uuidString, position, try Self.json(list)]
                )
            }
        }
    }

    public func saveBlocklistContent(_ id: UUID, content: Data) throws {
        try queue.write { db in
            try db.execute(sql: "UPDATE blocklists SET content = ? WHERE id = ?", arguments: [content, id.uuidString])
        }
    }

    public func blocklistContent(_ id: UUID) throws -> Data? {
        try queue.read { db in
            try Data.fetchOne(db, sql: "SELECT content FROM blocklists WHERE id = ?", arguments: [id.uuidString])
        }
    }

    public func deleteBlocklist(_ id: UUID) throws {
        try queue.write { db in
            try db.execute(sql: "DELETE FROM blocklists WHERE id = ?", arguments: [id.uuidString])
        }
    }

    public func addBlocklistHits(_ hits: [UUID: Int]) throws {
        guard !hits.isEmpty else { return }
        var lists = try blocklists()
        for index in lists.indices {
            if let count = hits[lists[index].id] { lists[index].hitCount += count }
        }
        for list in lists where hits[list.id] != nil { try saveBlocklist(list) }
    }

    // MARK: Connections

    /// Inserts new connections and applies byte-count updates in one transaction.
    public func writeConnections(_ records: [ConnectionRecord], byteUpdates: [UUID: (bytesIn: Int64, bytesOut: Int64)]) throws {
        guard !records.isEmpty || !byteUpdates.isEmpty else { return }
        try queue.write { db in
            for r in records {
                try db.execute(
                    sql: """
                        INSERT OR IGNORE INTO connections (flowID, time, pid, path, signingID, teamID, signature, remoteAddress,
                            remoteHost, remotePort, proto, direction, action, reason, sourceID, profileID, bytesIn, bytesOut, needsReview,
                            processName)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                    arguments: [
                        r.flowID.uuidString, r.time.timeIntervalSince1970, r.pid, r.process.path, r.process.signingID,
                        r.process.teamID, r.process.signature.rawValue, r.remoteAddress, r.remoteHost, Int(r.remotePort),
                        r.proto.rawValue, r.direction.rawValue, r.action.rawValue, r.reason.rawValue,
                        r.sourceID?.uuidString, r.profileID?.uuidString, r.bytesIn, r.bytesOut, r.needsReview,
                        r.process.name,
                    ]
                )
            }
            for (flowID, bytes) in byteUpdates {
                try db.execute(
                    sql: "UPDATE connections SET bytesIn = ?, bytesOut = ? WHERE flowID = ?",
                    arguments: [bytes.bytesIn, bytes.bytesOut, flowID.uuidString]
                )
            }
        }
    }

    public func connections(_ query: ConnectionQuery) throws -> [ConnectionRecord] {
        var clauses: [String] = []
        var arguments: StatementArguments = []
        if let afterID = query.afterID {
            clauses.append("id > ?")
            _ = arguments.append(contentsOf: [afterID])
        }
        if let action = query.action {
            clauses.append("action = ?")
            _ = arguments.append(contentsOf: [action.rawValue])
        }
        if let search = query.search?.trimmingCharacters(in: .whitespaces), !search.isEmpty {
            let pattern = "%" + search.prefix(200).replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "%", with: "\\%").replacingOccurrences(of: "_", with: "\\_") + "%"
            clauses.append("""
                (path LIKE ? ESCAPE '\\' OR signingID LIKE ? ESCAPE '\\' OR remoteHost LIKE ? ESCAPE '\\'
                 OR remoteAddress LIKE ? ESCAPE '\\' OR processName LIKE ? ESCAPE '\\')
                """)
            _ = arguments.append(contentsOf: [pattern, pattern, pattern, pattern, pattern])
        }
        let filter = clauses.isEmpty ? "" : "WHERE " + clauses.joined(separator: " AND ")
        let limit = min(max(query.limit, 1), 5000)
        // Tailing reads oldest-first after the cursor; the list view reads newest-first.
        let order = query.afterID == nil ? "DESC" : "ASC"
        return try queue.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM connections \(filter) ORDER BY id \(order) LIMIT \(limit)", arguments: arguments)
                .map(Self.connection)
        }
    }

    public func connectionCount() throws -> Int64 {
        try queue.read { db in try Int64.fetchOne(db, sql: "SELECT COUNT(*) FROM connections") ?? 0 }
    }

    private static func connection(_ row: Row) -> ConnectionRecord {
        ConnectionRecord(
            id: row["id"],
            flowID: UUID(uuidString: row["flowID"]) ?? UUID(),
            time: Date(timeIntervalSince1970: row["time"]),
            process: ProcessIdentity(
                signingID: row["signingID"], teamID: row["teamID"], path: row["path"],
                signature: SignatureStatus(rawValue: row["signature"]) ?? .unknown, name: row["processName"]
            ),
            pid: row["pid"],
            remoteAddress: row["remoteAddress"],
            remoteHost: row["remoteHost"],
            remotePort: UInt16(clamping: row["remotePort"] as Int),
            proto: TransportProtocol(rawValue: row["proto"]) ?? .any,
            direction: TrafficDirection(rawValue: row["direction"]) ?? .outbound,
            action: RuleAction(rawValue: row["action"]) ?? .allow,
            reason: VerdictReason(rawValue: row["reason"]) ?? .rule,
            sourceID: (row["sourceID"] as String?).flatMap(UUID.init(uuidString:)),
            profileID: (row["profileID"] as String?).flatMap(UUID.init(uuidString:)),
            bytesIn: row["bytesIn"],
            bytesOut: row["bytesOut"],
            needsReview: row["needsReview"]
        )
    }

    // MARK: Review

    public func reviewItems(limit: Int = 500) throws -> [ReviewItem] {
        try queue.read { db in
            try Row.fetchAll(db, sql: """
                SELECT path, signingID, teamID, signature, MAX(processName) AS processName,
                       COALESCE(remoteHost, remoteAddress, 'unknown') AS host,
                       MAX(remotePort) AS remotePort, MAX(proto) AS proto, MAX(action) AS action,
                       COUNT(*) AS count, MAX(time) AS lastSeen
                FROM connections WHERE needsReview = 1
                GROUP BY path, processName, host ORDER BY lastSeen DESC LIMIT ?
                """, arguments: [min(max(limit, 1), 5000)]).map { row in
                ReviewItem(
                    process: ProcessIdentity(
                        signingID: row["signingID"], teamID: row["teamID"], path: row["path"],
                        signature: SignatureStatus(rawValue: row["signature"]) ?? .unknown, name: row["processName"]
                    ),
                    host: row["host"],
                    remotePort: UInt16(clamping: row["remotePort"] as Int),
                    proto: TransportProtocol(rawValue: row["proto"]) ?? .any,
                    action: RuleAction(rawValue: row["action"]) ?? .allow,
                    count: row["count"],
                    lastSeen: Date(timeIntervalSince1970: row["lastSeen"])
                )
            }
        }
    }

    /// Marks every unreviewed connection from the process path to the host as reviewed.
    /// A nil host marks all of them.
    public func markReviewed(path: String?, host: String?) throws {
        try queue.write { db in
            switch (path, host) {
            case (nil, _):
                try db.execute(sql: "UPDATE connections SET needsReview = 0 WHERE needsReview = 1")
            case (let path?, nil):
                try db.execute(sql: "UPDATE connections SET needsReview = 0 WHERE needsReview = 1 AND path = ?", arguments: [path])
            case (let path?, let host?):
                try db.execute(
                    sql: "UPDATE connections SET needsReview = 0 WHERE needsReview = 1 AND path = ? AND COALESCE(remoteHost, remoteAddress, 'unknown') = ?",
                    arguments: [path, host]
                )
            }
        }
    }

    // MARK: Traffic

    public struct TrafficDelta: Hashable, Sendable {
        public var bucket: Int64
        public var appKey: String
        public var appName: String
        public var host: String
        public var bytesIn: Int64
        public var bytesOut: Int64
        public var flows: Int64

        public init(bucket: Int64, appKey: String, appName: String, host: String, bytesIn: Int64, bytesOut: Int64, flows: Int64) {
            self.bucket = bucket
            self.appKey = appKey
            self.appName = appName
            self.host = host
            self.bytesIn = bytesIn
            self.bytesOut = bytesOut
            self.flows = flows
        }
    }

    public func addTraffic(_ deltas: [TrafficDelta]) throws {
        guard !deltas.isEmpty else { return }
        try queue.write { db in
            for d in deltas {
                try db.execute(
                    sql: """
                        INSERT INTO traffic (bucket, appKey, appName, host, bytesIn, bytesOut, flows) VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(bucket, appKey, host) DO UPDATE SET
                            bytesIn = bytesIn + excluded.bytesIn, bytesOut = bytesOut + excluded.bytesOut,
                            flows = flows + excluded.flows, appName = excluded.appName
                        """,
                    arguments: [d.bucket, d.appKey, d.appName, d.host, d.bytesIn, d.bytesOut, d.flows]
                )
            }
        }
    }

    public func traffic(_ query: TrafficQuery) throws -> TrafficReport {
        let since = Int64(query.since.timeIntervalSince1970)
        let bucketSeconds = Int64(min(max(query.bucketHours, 1), 168)) * 3600
        var appFilter = ""
        var arguments: StatementArguments = [bucketSeconds, bucketSeconds, since]
        if let appKey = query.appKey {
            appFilter = "AND appKey = ?"
            _ = arguments.append(contentsOf: [appKey])
        }
        return try queue.read { db in
            let series = try Row.fetchAll(db, sql: """
                SELECT (bucket / ?) * ? AS slot, appKey, MAX(appName) AS appName, SUM(bytesIn) AS bytesIn, SUM(bytesOut) AS bytesOut
                FROM traffic WHERE bucket >= ? \(appFilter) GROUP BY slot, appKey ORDER BY slot
                """, arguments: arguments).map { row in
                TrafficPoint(
                    bucket: Date(timeIntervalSince1970: TimeInterval(row["slot"] as Int64)), appKey: row["appKey"],
                    appName: row["appName"], bytesIn: row["bytesIn"], bytesOut: row["bytesOut"]
                )
            }
            let apps = try Row.fetchAll(db, sql: """
                SELECT appKey AS key, MAX(appName) AS name, SUM(bytesIn) AS bytesIn, SUM(bytesOut) AS bytesOut, SUM(flows) AS flows
                FROM traffic WHERE bucket >= ? GROUP BY appKey ORDER BY bytesIn + bytesOut DESC LIMIT 200
                """, arguments: [since]).map(Self.total)
            var hostArguments: StatementArguments = [since]
            if let appKey = query.appKey { _ = hostArguments.append(contentsOf: [appKey]) }
            let hosts = try Row.fetchAll(db, sql: """
                SELECT host AS key, host AS name, SUM(bytesIn) AS bytesIn, SUM(bytesOut) AS bytesOut, SUM(flows) AS flows
                FROM traffic WHERE bucket >= ? \(appFilter) GROUP BY host ORDER BY bytesIn + bytesOut DESC LIMIT 200
                """, arguments: hostArguments).map(Self.total)
            return TrafficReport(series: series, apps: apps, hosts: hosts)
        }
    }

    private static func total(_ row: Row) -> TrafficTotal {
        TrafficTotal(key: row["key"], name: row["name"], bytesIn: row["bytesIn"], bytesOut: row["bytesOut"], flows: row["flows"])
    }

    // MARK: Retention

    /// Deletes connections and traffic older than the retention settings.
    public func prune(settings: Settings, now: Date = Date()) throws {
        let connectionCutoff = now.addingTimeInterval(-Double(settings.connectionRetentionDays) * 86400).timeIntervalSince1970
        let trafficCutoff = Int64(now.addingTimeInterval(-Double(settings.trafficRetentionDays) * 86400).timeIntervalSince1970)
        try queue.write { db in
            try db.execute(sql: "DELETE FROM connections WHERE time < ?", arguments: [connectionCutoff])
            try db.execute(sql: "DELETE FROM traffic WHERE bucket < ?", arguments: [trafficCutoff])
        }
    }

    public func eraseHistory() throws {
        try queue.write { db in
            try db.execute(sql: "DELETE FROM connections")
            try db.execute(sql: "DELETE FROM traffic")
        }
    }
}
