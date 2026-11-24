# Rule file format

Tattle exports and imports rules as JSON (**Rules → Import/Export** in the app,
`tattlectl export` / `sudo tattlectl import FILE`). The format is Tattle's own and
versioned; this page describes version 1.

## Document

```json
{
  "format" : "tattle-rules",
  "version" : 1,
  "exported" : "2026-11-20T09:30:00.000Z",
  "profiles" : [
    { "id" : "6F1C…", "name" : "Office", "ssids" : [ "Office" ], "interfaces" : [ ] }
  ],
  "rules" : [
    {
      "id" : "0B7A3C1E-5F0B-4C55-9A57-2C3D1E9F8A10",
      "process" : { "signingID" : "com.apple.Safari", "teamID" : "apple" },
      "direction" : "outbound",
      "remote" : { "type" : "domain", "value" : "example.com" },
      "port" : { "type" : "single", "value" : 443 },
      "protocol" : "tcp",
      "action" : "allow",
      "lifetime" : "forever",
      "enabled" : true,
      "created" : "2026-11-19T18:02:11.412Z",
      "modified" : "2026-11-19T18:02:11.412Z",
      "note" : "Work site",
      "system" : false
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | Always `"tattle-rules"`. Other files are rejected. |
| `version` | yes | `1`. Newer versions are rejected rather than guessed at. |
| `exported` | yes | When the file was written. Informational. |
| `rules` | yes | At most 100,000 rules. |
| `profiles` | yes | Profiles referenced by rules; may be empty. |

Timestamps are UTC ISO 8601 with milliseconds and a `Z` suffix.

## Rule fields

| Field | Default when missing | Values |
|---|---|---|
| `id` | required | UUID. Importing a rule with an existing ID replaces that rule. |
| `process` | any process | Object with any of `signingID`, `teamID`, `path`. All given fields must match. |
| `direction` | `outbound` | `outbound`, `inbound`, `any`. Tattle currently filters outbound flows only. |
| `remote` | any host | See below. |
| `port` | any port | `{"type":"any"}`, `{"type":"single","value":443}`, `{"type":"range","from":8000,"to":8100}` |
| `protocol` | `any` | `tcp`, `udp`, `any` |
| `action` | required | `allow` or `deny` |
| `lifetime` | `forever` | Only `forever` rules are exported or imported; others are dropped on import. |
| `profile` | all profiles | A profile `id`. The rule applies only while that profile is active. |
| `enabled` | `true` | Disabled rules are kept but never match. |
| `created`, `modified` | now | `modified` breaks ties between otherwise equal rules: newer wins. |
| `note` | none | Free text, up to 1,024 bytes. |
| `system` | `false` | Marks the built-in rules for Apple services. |

### Process matching

- `signingID` and `teamID` match only processes with a **valid** code signature. Use
  `"teamID": "apple"` for software signed by Apple itself.
- `path` is an absolute executable path and matches signed or unsigned processes. For
  unsigned tools it's the only identity Tattle can offer, so the alert says so.
- An empty `process` object (or a missing one) matches every process.

### Remote matching

| `type` | `value` | Matches |
|---|---|---|
| `any` | — | Every destination |
| `host` | `www.example.com` | Exactly that host name |
| `domain` | `example.com` | That name and all subdomains |
| `ip` | `93.184.216.34` or `2001:db8::1` | That address (IPv4-mapped IPv6 counts as IPv4) |
| `cidr` | `10.0.0.0/8` | Addresses in the network |

Host names are matched case-insensitively without a trailing dot. Flows usually carry an
IP address, so Tattle learns names from the flow's own host name, from DNS answers it
proxies (DNS-over-HTTPS), and remembers address → name mappings for at least five minutes.

## Precedence

For each new connection Tattle collects the enabled rules that match the process, port,
protocol, direction and destination, for the active profile and the current boot. The
winner is, in order:

1. A rule with a specific destination (anything except `any`) beats one for any host.
2. Within the same specificity, **deny** beats **allow**.
3. Within the same tier, the most recently **modified** rule wins.

So: deny-specific > allow-specific > deny-any-host > allow-any-host, ties to the newest.

If no rule matches, blocklists are checked next (a listed domain or address is denied),
then the mode decides: **Ask** shows an alert, **Silently allow/deny** applies that action.

## Validation on import

Import is all-or-nothing. The whole file is rejected, with the index of the first
offending rule, if any rule has an empty signing or team ID, a relative path, an invalid
host or domain name, an invalid address or CIDR, a port range that starts after it ends,
or an over-long field. Importing never changes the system rules unless the file contains a
rule with the same ID; `--replace` deletes your own rules (not system rules) first.
Profiles in the file are added or replace a profile with the same ID. A rule whose
`profile` is neither in the file nor on this Mac is imported for all profiles.
