import Foundation

/// Parsing for `tattlectl`. Kept here so it can be unit-tested.
public enum CLICommand: Equatable, Sendable {
    case help
    case status(json: Bool)
    case listRules(json: Bool)
    case addRule(Rule)
    case removeRules([UUID])
    case export(path: String?)
    case `import`(path: String, replace: Bool)
    case tail(count: Int, follow: Bool, json: Bool)

    public static let usage = """
        usage: tattlectl <command> [options]

        Commands:
          status [--json]                 Show filter status.
          rules list [--json]             List rules.
          rules add --allow|--deny [options]
                                          Add a permanent rule (needs sudo).
              --signing-id ID             Process signing identifier.
              --team-id ID                Process team ID ("apple" for Apple software).
              --path PATH                 Process executable path.
              --host NAME | --domain NAME | --ip ADDR | --cidr NET
                                          Remote endpoint (default: any).
              --port N | --ports LOW-HIGH Remote port (default: any).
              --protocol tcp|udp          Protocol (default: any).
              --note TEXT                 A note shown in the rules list.
          rules remove ID...              Delete rules by ID (needs sudo).
          export [FILE]                   Write rules as JSON to FILE or standard output.
          import FILE [--replace]         Import a rules file (needs sudo). --replace deletes
                                          existing non-system rules first.
          log tail [-n COUNT] [-f] [--json]
                                          Show recent connections; -f keeps following.
        """

    public struct ParseError: Error, Equatable, CustomStringConvertible {
        public let description: String
        init(_ description: String) { self.description = description }
    }

    public static func parse(_ arguments: [String]) throws -> CLICommand {
        var args = arguments[...]
        guard let command = args.popFirst() else { return .help }
        switch command {
        case "help", "-h", "--help":
            return .help
        case "status":
            return .status(json: try flags(args, allowed: ["--json"]).contains("--json"))
        case "rules":
            guard let sub = args.popFirst() else { throw ParseError("Missing rules subcommand.") }
            switch sub {
            case "list": return .listRules(json: try flags(args, allowed: ["--json"]).contains("--json"))
            case "add": return .addRule(try parseRule(args))
            case "remove":
                guard !args.isEmpty else { throw ParseError("Give at least one rule ID.") }
                return .removeRules(try args.map { value in
                    guard let id = UUID(uuidString: value) else { throw ParseError("“\(value)” isn't a rule ID.") }
                    return id
                })
            default: throw ParseError("Unknown rules subcommand “\(sub)”.")
            }
        case "export":
            guard args.count <= 1 else { throw ParseError("export takes at most one file.") }
            return .export(path: args.first)
        case "import":
            guard let path = args.popFirst() else { throw ParseError("Give a file to import.") }
            return .import(path: path, replace: try flags(args, allowed: ["--replace"]).contains("--replace"))
        case "log":
            guard args.popFirst() == "tail" else { throw ParseError("Did you mean “log tail”?") }
            var count = 50
            var follow = false
            var json = false
            while let arg = args.popFirst() {
                switch arg {
                case "-f", "--follow": follow = true
                case "--json": json = true
                case "-n":
                    guard let value = args.popFirst(), let n = Int(value), (1...5000).contains(n) else {
                        throw ParseError("-n needs a number from 1 to 5000.")
                    }
                    count = n
                default: throw ParseError("Unknown option “\(arg)”.")
                }
            }
            return .tail(count: count, follow: follow, json: json)
        default:
            throw ParseError("Unknown command “\(command)”.")
        }
    }

    private static func flags(_ args: ArraySlice<String>, allowed: Set<String>) throws -> Set<String> {
        for arg in args where !allowed.contains(arg) { throw ParseError("Unknown option “\(arg)”.") }
        return Set(args)
    }

    private static func parseRule(_ arguments: ArraySlice<String>) throws -> Rule {
        var args = arguments
        var action: RuleAction?
        var process = ProcessMatch()
        var remote: RemoteMatch = .any
        var port: PortMatch = .any
        var proto: TransportProtocol = .any
        var note: String?
        func value(_ option: String) throws -> String {
            guard let value = args.popFirst() else { throw ParseError("\(option) needs a value.") }
            return value
        }
        while let arg = args.popFirst() {
            switch arg {
            case "--allow": action = .allow
            case "--deny": action = .deny
            case "--signing-id": process.signingID = try value(arg)
            case "--team-id": process.teamID = try value(arg)
            case "--path": process.path = try value(arg)
            case "--host": remote = .host(try value(arg))
            case "--domain": remote = .domain(try value(arg))
            case "--ip":
                let text = try value(arg)
                guard let address = IPAddress(text) else { throw ParseError("“\(text)” isn't an IP address.") }
                remote = .ip(address)
            case "--cidr":
                let text = try value(arg)
                guard let network = IPNetwork(text) else { throw ParseError("“\(text)” isn't a CIDR network.") }
                remote = .network(network)
            case "--port":
                let text = try value(arg)
                guard let number = UInt16(text) else { throw ParseError("“\(text)” isn't a port.") }
                port = .single(number)
            case "--ports":
                let text = try value(arg)
                let parts = text.split(separator: "-")
                guard parts.count == 2, let low = UInt16(parts[0]), let high = UInt16(parts[1]), low <= high else {
                    throw ParseError("--ports needs LOW-HIGH, for example 8000-8100.")
                }
                port = .range(low, high)
            case "--protocol":
                let text = try value(arg)
                guard let parsed = TransportProtocol(rawValue: text), parsed != .any else { throw ParseError("--protocol is tcp or udp.") }
                proto = parsed
            case "--note": note = try value(arg)
            default: throw ParseError("Unknown option “\(arg)”.")
            }
        }
        guard let action else { throw ParseError("Say --allow or --deny.") }
        do {
            return try Rule(process: process, remote: remote, port: port, proto: proto, action: action, note: note).validated()
        } catch let error as RuleValidationError {
            throw ParseError(error.description)
        }
    }
}

/// Plain-text formatting shared by `tattlectl`.
public enum CLIFormat {
    /// Local wall-clock time, like `tail` users expect.
    static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

    public static func describe(_ rule: Rule) -> String {
        var process = "any process"
        if let signingID = rule.process.signingID { process = signingID }
        else if let path = rule.process.path { process = path }
        else if let team = rule.process.teamID { process = "team \(team)" }
        else if let bound = rule.boundProcess { process = "pid \(bound.pid)" }
        let remote: String = switch rule.remote {
        case .any: "any host"
        case .host(let name): name
        case .domain(let name): "*.\(name)"
        case .ip(let address): address.description
        case .network(let network): network.description
        }
        let port: String = switch rule.port {
        case .any: ""
        case .single(let value): ":\(value)"
        case .range(let low, let high): ":\(low)-\(high)"
        }
        let proto = rule.proto == .any ? "" : " \(rule.proto.rawValue)"
        var flags: [String] = []
        if rule.isSystem { flags.append("system") }
        if !rule.enabled { flags.append("disabled") }
        if rule.lifetime != .forever { flags.append(rule.lifetime.rawValue) }
        let suffix = flags.isEmpty ? "" : " [\(flags.joined(separator: ", "))]"
        return "\(rule.id.uuidString)  \(rule.action.rawValue.padding(toLength: 5, withPad: " ", startingAt: 0)) \(process) → \(remote)\(port)\(proto)\(suffix)"
    }

    public static func describe(_ record: ConnectionRecord) -> String {
        let time = timeFormatter.string(from: record.time)
        return "\(time)  \(record.action.rawValue.padding(toLength: 5, withPad: " ", startingAt: 0)) \(record.process.displayName) → \(record.displayHost):\(record.remotePort) \(record.proto.rawValue) (\(record.reason.rawValue))"
    }
}
